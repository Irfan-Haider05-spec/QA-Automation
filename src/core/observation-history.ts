import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Bounded, local, append-and-prune observation history (JSON Lines).
 *
 * - One record per line, strictly validated on every read; a corrupt line stops the
 *   run instead of being skipped, so history is never silently rewritten or lost.
 * - Writes take an exclusive lock file, merge with the current file, prune by age and
 *   count, then replace the file atomically (temporary file + rename).
 * - Timestamps are UTC ISO-8601. Records from the future (beyond a small clock-skew
 *   allowance) are rejected, which also catches a clock moved backwards.
 * - Only outcomes, HTTP status, latency and a path with its query removed are stored;
 *   never headers, bodies or credentials.
 */

export const OUTCOMES = ["up", "slow", "down", "check-error"] as const;
export const uptimeRecordSchema = z.object({
  v: z.literal(1),
  at: z.string().datetime(),
  target: z.string().min(1).max(2100),
  outcome: z.enum(OUTCOMES),
  status: z.number().int().min(0).max(999).optional(),
  ms: z.number().int().min(0).max(3_600_000).optional(),
  reason: z.enum(["http", "network", "timeout", "auth"]).optional(),
}).strict();
export type UptimeRecord = z.output<typeof uptimeRecordSchema>;

export const CLOCK_SKEW_MS = 5 * 60_000;
const MAX_LINE_BYTES = 4096;

/** Resolve a store path that must stay inside `root` and end in `ext` (.jsonl by default). */
export function resolveStorePath(root: string, relative: string, ext = ".jsonl"): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || !relative.endsWith(ext)) {
    throw new Error(`History path must be a relative ${ext} path inside the configuration directory`);
  }
  const base = path.resolve(root), full = path.resolve(base, relative);
  if (!full.startsWith(base + path.sep)) throw new Error("History path escapes the configuration directory");
  return full;
}

/** Remove the query from a target so tokens in query strings are never persisted. */
export function redactTarget(method: string, requestPath: string): string {
  const [pathname, query] = requestPath.split("?", 2);
  return `${method} ${pathname}${query !== undefined ? "?[redacted]" : ""}`;
}

export function readHistory<T>(file: string, schema: z.ZodType<T>, maxBytes: number, nowMs: number, at: (r: T) => string): T[] {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (e: any) { if (e.code === "ENOENT") return []; throw new Error("History file cannot be read"); }
  if (!stat.isFile()) throw new Error("History path must be a regular file, not a link or directory");
  if (stat.size > maxBytes) throw new Error(`History file exceeds ${maxBytes} bytes; lower retention or move the file`);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const records: T[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: T;
    try {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("too long");
      parsed = schema.parse(JSON.parse(line));
    } catch { throw new Error(`History line ${index + 1} is invalid; fix or move the file (content not shown)`); }
    if (Date.parse(at(parsed)) > nowMs + CLOCK_SKEW_MS) throw new Error(`History line ${index + 1} is in the future; check the system clock`);
    records.push(parsed);
  });
  return records.sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)));
}

/** Run `fn` while holding an exclusive `<file>.lock`; a lock older than two minutes is treated as abandoned. */
export async function withLock<T>(file: string, fn: () => T): Promise<T> {
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    let fd: number | undefined;
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch (e: any) {
      if (e.code !== "EEXIST") throw new Error("History lock cannot be created");
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (attempt >= 50) throw new Error("History file is locked by another run");
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    try { return fn(); }
    finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch { /* already removed */ } }
  }
}

export interface Retention { retentionDays: number; maxEntries: number; maxBytes: number }

/** Merge new records into the file under a lock, prune, and replace atomically. */
export async function appendHistory<T>(file: string, schema: z.ZodType<T>, additions: T[], retention: Retention, nowMs: number, at: (r: T) => string): Promise<T[]> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, () => {
    const existing = readHistory(file, schema, retention.maxBytes, nowMs, at);
    const cutoff = nowMs - retention.retentionDays * 86_400_000;
    const merged = [...existing, ...additions.map(r => schema.parse(r))]
      .filter(r => Date.parse(at(r)) >= cutoff)
      .sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)))
      .slice(-retention.maxEntries);
    const body = merged.map(r => JSON.stringify(r)).join("\n") + (merged.length ? "\n" : "");
    if (Buffer.byteLength(body) > retention.maxBytes) throw new Error("Pruned history still exceeds its size limit; lower maxEntries");
    writeFileAtomic(file, body);
    return merged;
  });
}

/** Replace `file` with `body` via a private temporary file and rename, so readers never see a partial file. */
export function writeFileAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch { try { fs.unlinkSync(tmp); } catch { /* not created */ } throw new Error("History file could not be written"); }
}

export interface TargetSummary {
  target: string; observations: number; up: number; slow: number; down: number; checkErrors: number;
  coveragePercent: number; observedAvailabilityPercent: number | null; downSeconds: number;
  outageEpisodes: number; longestOutageSeconds: number;
  gaps: Array<{ from: string; to: string }>; gapsTruncated: boolean;
}

/**
 * Summarize one target over [now - windowSeconds, now].
 *
 * Each successful observation (up/slow/down) is taken to describe at most
 * 1.5 × intervalSeconds after it, or until the next observation if sooner. Anything
 * not covered that way is unobserved: it counts as neither uptime nor downtime.
 * Check errors (the check itself failed, e.g. authentication) are unobserved too.
 */
export function summarizeTarget(records: UptimeRecord[], target: string, nowMs: number, windowSeconds: number, intervalSeconds: number, maxGaps = 50): TargetSummary {
  const start = nowMs - windowSeconds * 1000, reach = intervalSeconds * 1500;
  const all = records.filter(r => r.target === target);
  const inWindow = all.filter(r => { const t = Date.parse(r.at); return t >= start && t <= nowMs; });
  const known = all.filter(r => r.outcome !== "check-error" && Date.parse(r.at) <= nowMs);
  // The last known observation before the window may still cover its start.
  let seedIndex = -1;
  known.forEach((r, i) => { if (Date.parse(r.at) < start) seedIndex = i; });
  const points = known.slice(Math.max(seedIndex, 0)).filter(r => Date.parse(r.at) >= start || r === known[seedIndex]);
  let covered = 0, downCovered = 0;
  const gaps: Array<{ from: number; to: number }> = [];
  let cursor = start;
  points.forEach((r, i) => {
    const t = Date.parse(r.at);
    const next = i + 1 < points.length ? Date.parse(points[i + 1].at) : nowMs;
    const segStart = Math.max(t, start), segEnd = Math.min(t + reach, next, nowMs);
    if (segStart > cursor) gaps.push({ from: cursor, to: segStart });
    if (segEnd > segStart) {
      covered += segEnd - segStart;
      if (r.outcome === "down") downCovered += segEnd - segStart;
    }
    cursor = Math.max(cursor, segEnd);
  });
  if (cursor < nowMs) gaps.push({ from: cursor, to: nowMs });
  // Outage episodes: runs of consecutive "down" among known observations in the window.
  const windowKnown = known.filter(r => Date.parse(r.at) >= start);
  let episodes = 0, longest = 0, episodeStart: number | undefined;
  windowKnown.forEach((r, i) => {
    const t = Date.parse(r.at);
    if (r.outcome === "down" && episodeStart === undefined) { episodes++; episodeStart = t; }
    if (episodeStart !== undefined && (r.outcome !== "down" || i === windowKnown.length - 1)) {
      const end = r.outcome !== "down" ? t : Math.min(t + reach, nowMs);
      longest = Math.max(longest, end - episodeStart);
      if (r.outcome !== "down") episodeStart = undefined;
    }
  });
  const count = (o: UptimeRecord["outcome"]) => inWindow.filter(r => r.outcome === o).length;
  const meaningful = gaps.filter(g => g.to - g.from >= 1000);
  return {
    target, observations: inWindow.length, up: count("up"), slow: count("slow"), down: count("down"), checkErrors: count("check-error"),
    coveragePercent: round(covered / (windowSeconds * 1000) * 100),
    observedAvailabilityPercent: covered ? round((covered - downCovered) / covered * 100) : null,
    downSeconds: Math.round(downCovered / 1000), outageEpisodes: episodes, longestOutageSeconds: Math.round(longest / 1000),
    gaps: meaningful.slice(0, maxGaps).map(g => ({ from: new Date(g.from).toISOString(), to: new Date(g.to).toISOString() })),
    gapsTruncated: meaningful.length > maxGaps,
  };
}
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Opaque, filter-bound offset cursor for paging through exported records. */
export function paginate<T>(records: T[], filterKey: string, cursor: string | undefined, limit: number): { records: T[]; nextCursor: string | null } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be an integer from 1 to 1000");
  const binding = createHash("sha256").update(filterKey).digest("base64url").slice(0, 16);
  let offset = 0;
  if (cursor) {
    const match = /^(\d{1,9})\.([\w-]{16})$/.exec(Buffer.from(cursor, "base64url").toString());
    if (!match || match[2] !== binding) throw new Error("Cursor is invalid or belongs to different filters");
    offset = Number(match[1]);
    if (offset > records.length) throw new Error("Cursor is past the end of the export; the history may have been pruned");
  }
  const page = records.slice(offset, offset + limit);
  const next = offset + page.length;
  return { records: page, nextCursor: next < records.length ? Buffer.from(`${next}.${binding}`).toString("base64url") : null };
}

export const exportFilterSchema = z.object({
  from: z.string().datetime().optional(), to: z.string().datetime().optional(),
  target: z.string().min(1).max(2100).optional(), outcome: z.enum(OUTCOMES).optional(),
  cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(1000).default(100),
}).strict().refine(f => !f.from || !f.to || Date.parse(f.from) <= Date.parse(f.to), "from must not be after to");

/** Page through stored uptime records, oldest first, with filters bound to the cursor. */
export function exportUptimeHistory(file: string, filters: z.input<typeof exportFilterSchema>, maxBytes = 200000 * 512) {
  const f = exportFilterSchema.parse(filters);
  const records = readHistory(file, uptimeRecordSchema, maxBytes, Date.now(), r => r.at).filter(r => {
    const t = Date.parse(r.at);
    return (!f.from || t >= Date.parse(f.from)) && (!f.to || t <= Date.parse(f.to)) && (!f.target || r.target === f.target) && (!f.outcome || r.outcome === f.outcome);
  });
  const key = JSON.stringify([f.from ?? null, f.to ?? null, f.target ?? null, f.outcome ?? null]);
  return { total: records.length, ...paginate(records, key, f.cursor, f.limit) };
}
