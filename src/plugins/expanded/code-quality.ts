import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RunContext } from "../../core/context.js";
import type { Finding, Severity } from "../../core/types.js";
import { checkedPlugin, issue } from "./support.js";

/**
 * Code-quality gate: the project's own TypeScript typecheck, ESLint and Dart analyzer,
 * failing only on diagnostics that are new compared with a committed baseline.
 *
 * - Tools run without a shell, from the project's own node_modules (tsc, eslint) or PATH
 *   (dart), bounded in time and output. ESLint loads the project's eslint config, which
 *   is project code: configuring `eslint` is consent to run it.
 * - Saved tool output can be imported instead (CI artifacts, Windows Dart).
 * - Diagnostics are compared as counts per (tool, file, rule, message), without line
 *   numbers, so edits that only move code do not make old diagnostics look new.
 * - `qa run --baseline` writes the baseline. Without one, `failOn: "new"` errors rather
 *   than pass; a tool that could not really run (config error, crash, unreadable
 *   output) errors too.
 */

const MAX_OUTPUT = 64 * 1024 * 1024;
const LISTED = 30;
const relPath = z.string().min(1).max(1024).refine((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes(".."), "Use a path relative to the project");

export const codeQualitySchema = z.object({
  repoDir: z.string().min(1).max(1024).optional(),
  typescript: z.object({ tsconfig: relPath.optional(), output: relPath.optional() }).strict()
    .refine((t) => !(t.tsconfig && t.output), "Use tsconfig (run) or output (import), not both").optional(),
  eslint: z.object({ paths: z.array(relPath).min(1).max(50).optional(), report: relPath.optional() }).strict()
    .refine((e) => !!e.paths !== !!e.report, "Use paths (run) or report (import)").optional(),
  dart: z.object({ dir: relPath.optional(), output: relPath.optional() }).strict()
    .refine((d) => !(d.dir && d.output), "Use dir (run) or output (import), not both").optional(),
  failOn: z.enum(["new", "any"]).default("new"),
  baseline: relPath.default(".veriq/code-quality-baseline.json"),
  includeWarnings: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(1_800_000).default(600_000),
}).strict().refine((c) => c.typescript || c.eslint || c.dart, "Configure at least one of typescript, eslint or dart");
type Config = z.output<typeof codeQualitySchema>;

export interface Diagnostic { tool: "typescript" | "eslint" | "dart"; file: string; line: number; code: string; message: string; severity: "error" | "warning" }

const norm = (repoDir: string, file: string) => {
  const rel = path.relative(repoDir, path.resolve(repoDir, file)).split(path.sep).join("/");
  return rel.startsWith("..") ? file.split(path.sep).join("/") : rel;
};

/** `src/a.ts(3,5): error TS2322: ...` lines. Global `error TS5058: ...` means the check could not run. */
export function parseTsc(text: string, repoDir: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line);
    if (m) { out.push({ tool: "typescript", file: norm(repoDir, m[1]), line: Number(m[2]), code: m[5], message: m[6].trim(), severity: m[4] as "error" }); continue; }
    const global = /^error (TS\d+): /.exec(line);
    if (global) throw new Error(`TypeScript could not check the project (${global[1]}); fix the tsconfig or the configured path`);
  }
  return out;
}

/** ESLint `-f json` output. A fatal parse error counts as an error. */
export function parseEslint(text: string, repoDir: string): Diagnostic[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("ESLint output is not JSON (use -f json)"); }
  const files = z.array(z.object({ filePath: z.string(), messages: z.array(z.object({
    ruleId: z.string().nullable().optional(), severity: z.number(), message: z.string(), line: z.number().optional(), fatal: z.boolean().optional(),
  }).passthrough()) }).passthrough()).safeParse(data);
  if (!files.success) throw new Error("ESLint JSON report has an unexpected shape");
  return files.data.flatMap((f) => f.messages.filter((m) => m.severity >= 1).map((m): Diagnostic => ({
    tool: "eslint", file: norm(repoDir, f.filePath), line: m.line ?? 0, code: m.ruleId ?? (m.fatal ? "parse-error" : "eslint"),
    message: m.message.trim(), severity: m.fatal || m.severity === 2 ? "error" : "warning" })));
}

/** `dart analyze --format=machine`: SEVERITY|TYPE|CODE|FILE|LINE|COL|LENGTH|MESSAGE, `\|` escaped. */
export function parseDartMachine(text: string, repoDir: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^(ERROR|WARNING|INFO)\|/.test(line)) continue;
    const fields: string[] = []; let cur = "";
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\" && i + 1 < line.length) { cur += line[++i]; continue; }
      if (line[i] === "|" && fields.length < 7) { fields.push(cur); cur = ""; continue; }
      cur += line[i];
    }
    fields.push(cur);
    if (fields.length < 8) throw new Error("Dart analyzer output is not in --format=machine");
    const [severity, , code, file, lineNo, , , message] = fields;
    if (severity === "INFO") continue;
    out.push({ tool: "dart", file: norm(repoDir, file), line: Number(lineNo) || 0, code, message: message.trim(), severity: severity === "ERROR" ? "error" : "warning" });
  }
  return out;
}

/** Stable identity of a diagnostic, without its line number. */
export const diagnosticKey = (d: Diagnostic) =>
  createHash("sha256").update([d.tool, d.file, d.code, d.message.replace(/\s+/g, " ")].join("\u0000")).digest("hex").slice(0, 20);

function countByKey(list: Diagnostic[]) {
  const m = new Map<string, number>();
  for (const d of list) m.set(diagnosticKey(d), (m.get(diagnosticKey(d)) ?? 0) + 1);
  return m;
}

/** Diagnostics whose count went up since the baseline (all occurrences of that key are listed). */
export function newDiagnostics(current: Diagnostic[], baseline: Record<string, number>) {
  const counts = countByKey(current);
  const added = new Map<string, number>();
  for (const [k, n] of counts) if (n > (baseline[k] ?? 0)) added.set(k, n - (baseline[k] ?? 0));
  let fixed = 0;
  for (const [k, n] of Object.entries(baseline)) fixed += Math.max(0, n - (counts.get(k) ?? 0));
  return { added, fixed, list: current.filter((d) => added.has(diagnosticKey(d))) };
}

function runTool(file: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } }, (error, stdout) => {
      const e = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      if (!e) return resolve({ stdout, code: 0 });
      if (e.killed) return reject(new Error(`${path.basename(args[0] ?? file)} timed out`));
      if (e.code === "ENOENT") return reject(new Error(`${file} is not installed or not on PATH`));
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new Error("Tool output exceeds 64 MiB"));
      if (typeof e.code === "number") return resolve({ stdout, code: e.code });
      reject(new Error(`${path.basename(file)} could not run`));
    });
  });
}

/**
 * The project's own copy of a tool's bin script, so its pinned version is used. Only
 * node_modules folders of the project and its parents are searched (workspace hoisting
 * works); NODE_PATH and global folders are not, so a machine-wide copy is never used.
 */
export function projectBin(repoDir: string, pkg: string, bin: string): string {
  let manifest: string | undefined;
  for (let dir = path.resolve(repoDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", pkg, "package.json");
    if (fs.existsSync(candidate)) { manifest = fs.realpathSync(candidate); break; }
    if (path.dirname(dir) === dir) break;
  }
  if (!manifest) throw new Error(`${pkg} is not installed in the project (npm install it, or import a saved report)`);
  const data = JSON.parse(fs.readFileSync(manifest, "utf8")) as { bin?: string | Record<string, string> };
  const rel = typeof data.bin === "string" ? data.bin : data.bin?.[bin];
  if (!rel) throw new Error(`${pkg} has no ${bin} executable`);
  return path.join(path.dirname(manifest), rel);
}

function readImport(configDir: string, file: string, headTime: number | undefined): string {
  const full = path.resolve(configDir, file);
  const stat = fs.statSync(full, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`Report ${file} not found`);
  if (stat.size > MAX_OUTPUT) throw new Error(`Report ${file} exceeds 64 MiB`);
  if (headTime && stat.mtimeMs + 1000 < headTime) throw new Error(`Report ${file} is older than the latest commit; regenerate it`);
  return fs.readFileSync(full, "utf8");
}

async function headCommitTime(repoDir: string): Promise<number | undefined> {
  if (!fs.existsSync(path.join(repoDir, ".git"))) return undefined;
  const r = await runTool("git", ["-c", "core.fsmonitor=false", "-C", repoDir, "show", "-s", "--format=%ct", "HEAD"], repoDir, 30000).catch(() => undefined);
  const t = r && r.code === 0 ? Number(r.stdout.trim()) * 1000 : NaN;
  return Number.isFinite(t) ? t : undefined;
}

export async function collectDiagnostics(ctx: RunContext, c: Config, repoDir: string) {
  const headTime = await headCommitTime(repoDir);
  const all: Diagnostic[] = [];
  const ran: string[] = [];
  if (c.typescript) {
    let text: string;
    if (c.typescript.output) text = readImport(ctx.configDir, c.typescript.output, headTime);
    else {
      const tsconfig = c.typescript.tsconfig ?? "tsconfig.json";
      if (!fs.existsSync(path.join(repoDir, tsconfig))) throw new Error(`${tsconfig} not found in the project`);
      const r = await runTool(process.execPath, [projectBin(repoDir, "typescript", "tsc"), "--noEmit", "--pretty", "false", "-p", tsconfig], repoDir, c.timeoutMs);
      if (r.code !== 0 && !/error TS\d+/.test(r.stdout)) throw new Error(`tsc exited with code ${r.code} without diagnostics`);
      text = r.stdout;
    }
    all.push(...parseTsc(text, repoDir)); ran.push("typescript");
  }
  if (c.eslint) {
    let text: string;
    if (c.eslint.report) text = readImport(ctx.configDir, c.eslint.report, headTime);
    else {
      // Exit 0 = clean, 1 = lint problems, 2 = configuration error or crash.
      const r = await runTool(process.execPath, [projectBin(repoDir, "eslint", "eslint"), "--format", "json", "--no-error-on-unmatched-pattern", ...c.eslint.paths!], repoDir, c.timeoutMs);
      if (r.code >= 2) throw new Error("ESLint could not run (configuration error or crash)");
      text = r.stdout;
    }
    all.push(...parseEslint(text, repoDir)); ran.push("eslint");
  }
  if (c.dart) {
    let text: string;
    if (c.dart.output) text = readImport(ctx.configDir, c.dart.output, headTime);
    else {
      // Node refuses to start Windows batch files (dart.bat) without a shell; no shell is used.
      if (process.platform === "win32") throw new Error("On Windows, save `dart analyze --format=machine` output and use dart.output");
      const r = await runTool("dart", ["analyze", "--format=machine", c.dart.dir ?? "."], repoDir, c.timeoutMs);
      if (r.code > 3) throw new Error("dart analyze could not run");
      text = r.stdout;
    }
    all.push(...parseDartMachine(text, repoDir)); ran.push("dart");
  }
  return { diagnostics: all.filter((d) => d.severity === "error" || c.includeWarnings), ran };
}

const severityOf = (d: Diagnostic): Severity => (d.severity === "error" ? "high" : "medium");

export async function codeQuality(ctx: RunContext, c: Config): Promise<{ findings: Finding[]; stats: Record<string, number | string> }> {
  const repoDir = path.resolve(ctx.configDir, c.repoDir ?? ".");
  if (!fs.statSync(repoDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error("repoDir is not a directory");
  const { diagnostics, ran } = await collectDiagnostics(ctx, c, repoDir);
  const baselineFile = path.resolve(ctx.configDir, c.baseline);
  const current = Object.fromEntries([...countByKey(diagnostics)].sort(([a], [b]) => a.localeCompare(b)));

  if (ctx.updateBaseline) {
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, JSON.stringify({ version: 1, tools: ran, writtenAt: new Date().toISOString(), counts: current }, null, 2) + "\n");
    return { findings: [], stats: { tools: ran.join(","), diagnostics: diagnostics.length, baselineWritten: c.baseline } };
  }

  let baseline: Record<string, number> = {};
  if (c.failOn === "new") {
    if (!fs.existsSync(baselineFile)) throw new Error(`No code-quality baseline at ${c.baseline}; accept the current state with \`qa run --only code-quality --baseline\` and commit the file`);
    const parsed = z.object({ version: z.literal(1), counts: z.record(z.string().regex(/^[0-9a-f]{20}$/), z.number().int().min(1)) }).passthrough()
      .safeParse(JSON.parse(fs.readFileSync(baselineFile, "utf8")));
    if (!parsed.success) throw new Error(`The code-quality baseline ${c.baseline} is invalid`);
    baseline = parsed.data.counts;
  }
  const { added, fixed, list } = newDiagnostics(diagnostics, baseline);
  const newCount = [...added.values()].reduce((a, b) => a + b, 0);

  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.outDir, "code-quality.json"), JSON.stringify({
    tools: ran, failOn: c.failOn, total: diagnostics.length, new: newCount, fixedSinceBaseline: fixed,
    newDiagnostics: list.slice(0, 2000), truncated: list.length > 2000,
  }, null, 2));

  const findings: Finding[] = [];
  for (const tool of ran) {
    const items = list.filter((d) => d.tool === tool).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    if (!items.length) continue;
    const label = { typescript: "TypeScript", eslint: "ESLint", dart: "Dart analyzer" }[tool as Diagnostic["tool"]];
    const lines = items.slice(0, LISTED).map((d) => `${d.file}:${d.line} ${d.code} ${d.message}`).join("\n");
    const f = issue("code-quality", c.failOn === "new" ? `New ${label} problems` : `${label} problems`, tool,
      `${items.length} ${c.failOn === "new" ? "new " : ""}problem(s):\n${lines}${items.length > LISTED ? `\n…and ${items.length - LISTED} more (see code-quality.json)` : ""}`,
      items.some((d) => d.severity === "error") ? "high" : severityOf(items[0]), "quality");
    findings.push({ ...f, remediation: `Fix the listed ${label} problems${c.failOn === "new" ? ", or, if they are accepted, update the baseline with qa run --only code-quality --baseline" : ""}.` });
  }
  return { findings, stats: { tools: ran.join(","), diagnostics: diagnostics.length, new: newCount, fixedSinceBaseline: fixed } };
}

export const codeQualityPlugin = checkedPlugin("code-quality", "static", "Project typecheck, ESLint and Dart analyzer; fails on problems that are new since the committed baseline",
  codeQualitySchema, (ctx, c) => codeQuality(ctx, c));
