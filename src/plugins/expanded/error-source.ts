import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getPath, readBoundedResponse } from "../../core/http.js";

/**
 * Provider-neutral error-event sources for post-deploy comparison.
 *
 * A source yields events with a timestamp, an optional release and a fingerprint.
 * Raw messages are never kept: a missing fingerprint is derived by normalizing the
 * message (emails, URLs, UUIDs, long hex/digit runs and numbers replaced) and hashing
 * it. A provider fingerprint is normalized the same way, so PII in it is not copied.
 *
 * A source must prove completeness: an NDJSON file is read whole within its limits;
 * an HTTP source must reach the end of its pagination within maxPages/maxEvents.
 * Anything less is an error, never a partial pass.
 */

const dotPath = z.string().regex(/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*){0,10}$/);
const fieldsSchema = z.object({
  timestamp: dotPath.default("timestamp"),
  fingerprint: dotPath.optional(),
  message: dotPath.optional(),
  release: dotPath.optional(),
}).strict().refine(f => f.fingerprint || f.message, "Configure fields.fingerprint or fields.message");

const ndjsonSchema = z.object({ kind: z.literal("ndjson"), file: z.string().min(1).max(512), fields: fieldsSchema }).strict();
const httpSchema = z.object({
  kind: z.literal("http"),
  url: z.string().url().max(2048),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  fromParam: z.string().regex(/^[\w.-]{1,64}$/).default("from"),
  toParam: z.string().regex(/^[\w.-]{1,64}$/).default("to"),
  cursorParam: z.string().regex(/^[\w.-]{1,64}$/).default("cursor"),
  limitParam: z.string().regex(/^[\w.-]{1,64}$/).default("limit"),
  pageSize: z.number().int().min(1).max(1000).default(100),
  maxPages: z.number().int().min(1).max(1000).default(50),
  eventsPath: dotPath.default("events"),
  nextCursorPath: dotPath.default("nextCursor"),
  timeoutMs: z.number().int().min(500).max(60000).default(15000),
  fields: fieldsSchema,
}).strict();
export const errorSourceSchema = z.discriminatedUnion("kind", [ndjsonSchema, httpSchema]);
export type ErrorSourceConfig = z.output<typeof errorSourceSchema>;

export interface ErrorEvent { at: number; fingerprint: string; release?: string }
export interface SourceResult { events: ErrorEvent[]; pages: number; read: number }

export const MAX_EVENTS = 200_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Remove personal data and credentials, keeping the rest of the text. */
export function redactPii(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<token>");
}
/** Also replace variable data (ids, hex, numbers) so equal messages share a fingerprint. */
export function normalizeErrorText(text: string): string {
  return redactPii(text)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}
/** A stable, non-reversible fingerprint label for a normalized string. */
export function fingerprintOf(kind: "fp" | "msg", text: string): string {
  // Provider fingerprints are often hashes themselves: only personal data is removed.
  const basis = kind === "fp" ? redactPii(text) : normalizeErrorText(text);
  return `${kind}:${createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

function toEvent(raw: unknown, fields: z.output<typeof fieldsSchema>, where: string): ErrorEvent {
  const ts = getPath(raw, fields.timestamp);
  const at = typeof ts === "number" ? (ts < 1e12 ? ts * 1000 : ts) : typeof ts === "string" ? Date.parse(ts) : NaN;
  if (!Number.isFinite(at)) throw new Error(`${where}: missing or invalid timestamp`);
  const fp = fields.fingerprint ? getPath(raw, fields.fingerprint) : undefined;
  const msg = fields.message ? getPath(raw, fields.message) : undefined;
  let fingerprint: string;
  if (typeof fp === "string" && fp.length && fp.length <= 2000) fingerprint = fingerprintOf("fp", fp);
  else if (typeof msg === "string" && msg.length) fingerprint = fingerprintOf("msg", msg);
  else throw new Error(`${where}: no fingerprint or message`);
  const rel = fields.release ? getPath(raw, fields.release) : undefined;
  if (rel !== undefined && rel !== null && (typeof rel !== "string" || rel.length > 200)) throw new Error(`${where}: invalid release`);
  return { at, fingerprint, ...(typeof rel === "string" ? { release: rel } : {}) };
}

export function readNdjsonSource(configDir: string, c: z.output<typeof ndjsonSchema>, range: { from: number; to: number }): SourceResult {
  if (path.isAbsolute(c.file) || c.file.split(/[\\/]/).includes("..")) throw new Error("Error source file must be a relative path inside the configuration directory");
  const file = path.resolve(configDir, c.file);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch { throw new Error("Error source file cannot be read"); }
  if (!stat.isFile()) throw new Error("Error source file must be a regular file");
  if (stat.size > MAX_FILE_BYTES) throw new Error("Error source file exceeds 50 MiB");
  const events: ErrorEvent[] = []; let read = 0;
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    if (++read > MAX_EVENTS) throw new Error(`Error source exceeds ${MAX_EVENTS} events`);
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new Error(`Error source line ${i + 1} is not valid JSON (content not shown)`); }
    const event = toEvent(raw, c.fields, `Error source line ${i + 1}`);
    if (event.at >= range.from && event.at < range.to) events.push(event);
  });
  return { events, pages: 1, read };
}

function tokenFrom(name?: string): string | undefined {
  if (!name) return undefined;
  const value = process.env[name];
  if (!value || value.length > 8192 || /[\r\n]/.test(value)) throw new Error("Error source token environment variable missing or invalid");
  return value;
}

export async function readHttpSource(c: z.output<typeof httpSchema>, range: { from: number; to: number }): Promise<SourceResult> {
  const base = new URL(c.url);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) throw new Error("Error source URL must use HTTPS (HTTP only for loopback testing)");
  if (base.username || base.password || base.hash) throw new Error("Error source URL must not contain credentials or a fragment");
  for (const p of [c.fromParam, c.toParam, c.cursorParam, c.limitParam]) if (base.searchParams.has(p)) throw new Error("Error source URL already sets a paging parameter");
  if (new Set([c.fromParam, c.toParam, c.cursorParam, c.limitParam]).size !== 4) throw new Error("Paging parameter names must differ");
  const token = tokenFrom(c.tokenEnv);
  const events: ErrorEvent[] = []; let cursor: string | undefined, read = 0;
  for (let page = 1; page <= c.maxPages; page++) {
    const url = new URL(base);
    url.searchParams.set(c.fromParam, new Date(range.from).toISOString());
    url.searchParams.set(c.toParam, new Date(range.to).toISOString());
    url.searchParams.set(c.limitParam, String(c.pageSize));
    if (cursor) url.searchParams.set(c.cursorParam, cursor);
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, redirect: "error", signal: AbortSignal.timeout(c.timeoutMs) });
    } catch { throw new Error(`Error source page ${page} request failed`); }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`Error source page ${page} returned HTTP ${res.status}`); }
    let body: unknown;
    try { body = JSON.parse(await readBoundedResponse(res, 10 * 1024 * 1024)); } catch { throw new Error(`Error source page ${page} is not bounded JSON`); }
    const list = getPath(body, c.eventsPath);
    if (!Array.isArray(list) || list.length > c.pageSize) throw new Error(`Error source page ${page} has no valid events array`);
    for (const [i, raw] of list.entries()) {
      if (++read > MAX_EVENTS) throw new Error(`Error source exceeds ${MAX_EVENTS} events`);
      const event = toEvent(raw, c.fields, `Error source page ${page} event ${i + 1}`);
      if (event.at >= range.from && event.at < range.to) events.push(event);
    }
    const next = getPath(body, c.nextCursorPath);
    if (next === null || next === undefined || next === "") return { events, pages: page, read };
    if (typeof next !== "string" || next.length > 2048) throw new Error(`Error source page ${page} has an invalid cursor`);
    if (next === cursor) throw new Error(`Error source page ${page} repeated its cursor`);
    cursor = next;
  }
  throw new Error(`Error source had more than ${c.maxPages} pages; the window is incomplete, so no result is accepted`);
}

export async function readErrorSource(configDir: string, c: ErrorSourceConfig, range: { from: number; to: number }): Promise<SourceResult> {
  return c.kind === "ndjson" ? readNdjsonSource(configDir, c, range) : readHttpSource(c, range);
}
