import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { RunContext } from "../../core/context.js";
import { responseEvidence, sanitizeEvidenceText, type HttpRequest, type HttpResponse } from "../../core/http.js";
import { assertionSchema, check, checkSchemaKeywords, diffValues, getPath, show, snapshotValue, validateSchema } from "../../core/json-assert.js";
import { SkipError, type Finding, type Severity } from "../../core/types.js";
import { openDb, type DbConn } from "../../core/db.js";
import { checkResult, databaseSpec, dbExpectSpec, dbQueryFields, dbQueryFor } from "./db-checks.js";
import { expandReports } from "./flaky-tests.js";
import { checkedPlugin } from "./support.js";

/**
 * API scenarios: multi-step functional tests written as data (YAML or JSON).
 *
 * Each step sends one request (as a QA account or anonymously), checks status, time,
 * headers, JSON values, a JSON Schema and optionally a stored snapshot, and can save
 * values for later steps (create → read → update → delete). Cleanup steps always run.
 * Scenarios that write data run only with allowMutations and disposable. Tags select
 * smoke, regression or UAT sets. Results are findings plus a JSON and a JUnit report.
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const relPattern = z.string().min(1).max(1024).refine((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes(".."), "Use a path relative to the configuration directory");
const tag = z.string().min(1).max(50).regex(/^[A-Za-z0-9_.-]+$/);
const varName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "Variable names use letters, digits and _");

export const apiScenariosSchema = z.object({
  files: z.union([relPattern, z.array(relPattern).min(1).max(50)]),
  tags: z.array(tag).max(50).default([]),
  excludeTags: z.array(tag).max(50).default([]),
  snapshotDir: relPattern.default(".veriq/api-snapshots"),
  /** For `db` steps: the database to read (read-only) after API calls. */
  database: databaseSpec.optional(),
  dbTimeoutMs: z.number().int().min(1000).max(600_000).default(15_000),
}).strict();
type Config = z.output<typeof apiScenariosSchema>;

const headerExpect = z.union([z.string().max(1000), z.object({ equals: z.string().max(1000).optional(), contains: z.string().max(1000).optional(),
  matches: z.string().min(1).max(200).optional(), exists: z.boolean().optional() }).strict()]);
const requestSpec = z.object({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  path: z.string().min(1).max(2048).refine((p) => p.startsWith("/") && !p.startsWith("//"), "Use a path on the target, starting with /"),
  query: z.record(z.string().max(200), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
  headers: z.record(z.string().min(1).max(200).regex(/^[A-Za-z0-9-]+$/).refine((h) => !/^(host|content-length|connection|transfer-encoding)$/i.test(h), "This header is set by the client"), z.string().max(4000)).optional(),
  json: z.unknown().optional(),
}).strict();
const expectSpec = z.object({
  status: z.union([z.number().int().min(100).max(599), z.array(z.number().int().min(100).max(599)).min(1).max(20)]).optional(),
  maxMs: z.number().int().min(1).max(600_000).optional(),
  headers: z.record(z.string().min(1).max(200), headerExpect).optional(),
  json: z.array(assertionSchema).max(200).optional(),
  schema: z.unknown().optional(),
  text: z.object({ contains: z.string().max(2000).optional(), notContains: z.string().max(2000).optional(), matches: z.string().min(1).max(200).optional() }).strict().optional(),
  snapshot: z.object({ name: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).optional(), ignore: z.array(z.string().min(1).max(500)).max(100).default([]), mode: z.enum(["values", "shape"]).default("values") }).strict().optional(),
}).strict();
const dbStepSpec = z.object({ ...dbQueryFields, expect: dbExpectSpec.optional() }).strict();
const stepSpec = z.object({
  name: z.string().min(1).max(200).optional(),
  account: z.string().min(1).max(100).nullable().optional(),
  request: requestSpec.optional(),
  /** Instead of a request: read the database (read-only) and check what was stored. */
  db: dbStepSpec.optional(),
  expect: expectSpec.optional(),
  save: z.record(varName, z.union([z.string().min(1).max(500).startsWith("$"), z.object({ header: z.string().min(1).max(200) }).strict()])).optional(),
  delayMs: z.number().int().min(0).max(10_000).optional(),
}).strict().refine((s) => !!s.request !== !!s.db, "A step has either request or db")
  .refine((s) => !s.db || (!s.expect && !s.account), "A db step puts its expectations in db.expect and uses no account");
const scenarioSpec = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  tags: z.array(tag).max(20).default([]),
  account: z.string().min(1).max(100).optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).default("high"),
  vars: z.record(varName, z.unknown()).default({}),
  steps: z.array(stepSpec).min(1).max(100),
  cleanup: z.array(stepSpec).max(20).default([]),
}).strict();
const fileSpec = z.object({ version: z.literal(1).optional(), scenarios: z.array(scenarioSpec).min(1).max(500) }).strict();
export type Scenario = z.output<typeof scenarioSpec> & { file: string };
type Step = z.output<typeof stepSpec>;

/** Read, validate and select scenarios. Problems in a file are configuration errors, never skipped silently. */
export function loadScenarios(configDir: string, patterns: string[], dbType?: "mongodb" | "postgres" | "mysql"): Scenario[] {
  const files = expandReports(configDir, patterns, "scenario file");
  const all: Scenario[] = [];
  for (const file of files) {
    const rel = path.relative(configDir, file).split(path.sep).join("/");
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`Scenario file ${rel} not found`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`Scenario file ${rel} exceeds 2 MiB`);
    const text = fs.readFileSync(file, "utf8");
    let data: unknown;
    try { data = /\.json$/i.test(file) ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 50 }); }
    catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      // The most common YAML slip: $.items[0].id inside { } or [ ] starts a list unless quoted.
      const hint = /flow-seq|flow-map|Unexpected flow|Flow sequence/i.test(msg) ? ' (inside { } or [ ], put JSON paths with [ ] in quotes: "$.data[0].id")' : "";
      throw new Error(`Scenario file ${rel} could not be parsed: ${msg}${hint}`);
    }
    const parsed = fileSpec.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Scenario file ${rel}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    for (const s of parsed.data.scenarios) {
      for (const [i, st] of [...s.steps, ...s.cleanup].entries()) {
        if (st.db) {
          if (!dbType) throw new Error(`Scenario "${s.name}" step ${i + 1} in ${rel} reads the database; set database in the api-scenarios settings`);
          try { dbQueryFor(dbType, st.db); } catch (e) { throw new Error(`Scenario "${s.name}" step ${i + 1} in ${rel}: ${(e as Error).message}`); }
        }
        if (st.expect?.schema !== undefined) {
          try { checkSchemaKeywords(st.expect.schema); } catch (e) { throw new Error(`Scenario "${s.name}" step ${i + 1} in ${rel}: ${(e as Error).message}`); }
        }
        for (const re of [st.expect?.text?.matches, ...Object.values(st.expect?.headers ?? {}).map((h) => (typeof h === "string" ? undefined : h.matches))]) {
          if (re) { try { new RegExp(re); } catch { throw new Error(`Scenario "${s.name}" in ${rel}: invalid regular expression ${re}`); } }
        }
      }
      if (all.some((x) => x.name === s.name)) throw new Error(`Scenario name "${s.name}" is used twice (${rel}); names identify results and snapshots`);
      all.push({ ...s, file: rel });
    }
  }
  return all;
}

export function selectScenarios(all: Scenario[], include: string[], exclude: string[]) {
  return all.filter((s) => (!include.length || s.tags.some((t) => include.includes(t))) && !s.tags.some((t) => exclude.includes(t)));
}

// ---------- variables ----------

const TEMPLATE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

export function lookup(name: string, vars: Record<string, unknown>): unknown {
  if (name.startsWith("env.")) {
    const env = name.slice(4);
    if (!/^QA_[A-Z0-9_]+$/.test(env)) throw new Error(`Only QA_* environment variables can be used ({{${name}}})`);
    const v = process.env[env];
    if (v === undefined) throw new Error(`Environment variable ${env} is not set`);
    return v;
  }
  if (!Object.hasOwn(vars, name)) throw new Error(`Unknown variable {{${name}}}`);
  return vars[name];
}

/** Replace {{name}}. A string that is exactly one template keeps the value's type (numbers stay numbers). */
export function interpolate(value: unknown, vars: Record<string, unknown>, encode = false, depth = 0): unknown {
  if (depth > 32) throw new Error("Value nested too deeply");
  if (typeof value === "string") {
    const whole = /^\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}$/.exec(value);
    if (whole && !encode) return lookup(whole[1], vars);
    return value.replace(TEMPLATE, (_, n: string) => {
      const v = lookup(n, vars);
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return encode ? encodeURIComponent(s) : s;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars, encode, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars, encode, depth + 1)]));
  return value;
}

/** Expected values are interpolated; JSON paths and regular expressions are not. */
const interpolateAssertion = (a: unknown, vars: Record<string, unknown>): unknown => {
  if (Array.isArray(a)) return a.map((x) => interpolateAssertion(x, vars));
  if (!a || typeof a !== "object") return a;
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, k === "path" || k === "matches" ? v : k === "every" || k === "some" ? interpolateAssertion(v, vars) : interpolate(v, vars)]));
};

const mutating = (s: Scenario) => [...s.steps, ...s.cleanup].some((st) => st.request && !["GET", "HEAD"].includes(st.request.method));
const usesDb = (s: Scenario) => [...s.steps, ...s.cleanup].some((st) => st.db);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "x";

// ---------- running ----------

export interface StepResult {
  name: string; method: string; path: string; account: string | null; status?: number; ms?: number;
  ok: boolean; errors: string[]; skipped?: string; snapshot?: "written" | "matched" | "missing" | "changed";
}
export interface ScenarioResult { name: string; file: string; tags: string[]; status: "passed" | "failed" | "skipped"; reason?: string; ms: number; steps: StepResult[]; cleanup: StepResult[] }

interface RunState { vars: Record<string, unknown>; snapshotMissing: string[]; evidence?: { req: HttpRequest; res: HttpResponse }; db?: () => Promise<DbConn> }

/** A database step: interpolate the query, run it read-only, check rows, save values from them. */
async function runDbStep(c: Config, st: Step, name: string, state: RunState): Promise<StepResult> {
  const q = st.db!;
  const label = q.collection ?? "sql";
  const base: StepResult = { name, method: "DB", path: label, account: null, ok: false, errors: [] };
  try {
    const query = dbQueryFor(c.database!.type, {
      ...q,
      filter: q.filter && (interpolate(q.filter, state.vars) as Record<string, unknown>),
      pipeline: q.pipeline && (interpolate(q.pipeline, state.vars) as Record<string, unknown>[]),
      params: q.params && (interpolate(q.params, state.vars) as unknown[]),
    });
    if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs));
    const started = Date.now();
    const result = await (await state.db!()).run(query);
    const out: StepResult = { ...base, ms: Date.now() - started };
    const expect = q.expect ? (interpolateAssertion(q.expect, state.vars) as typeof q.expect) : { min: 1 };
    out.errors.push(...checkResult(result, expect!));
    if (!out.errors.length) for (const [v, from] of Object.entries(st.save ?? {})) {
      if (typeof from !== "string") { out.errors.push(`save ${v}: a db step saves from rows ($[0].field)`); continue; }
      const got = getPath(result.rows, from);
      if (!got.found) { out.errors.push(`save ${v}: ${from} not found in the rows`); continue; }
      state.vars[v] = got.value;
    }
    out.ok = out.errors.length === 0;
    return out;
  } catch (e) { return { ...base, errors: [(e as Error).message] }; }
}

async function runStep(ctx: RunContext, c: Config, s: Scenario, st: Step, index: number, phase: "step" | "cleanup", state: RunState): Promise<StepResult> {
  const name = st.name ?? `${phase} ${index + 1}`;
  if (st.db) return runDbStep(c, st, name, state);
  const request = st.request!;
  const account = st.account === null ? null : st.account ?? s.account ?? null;
  const base: StepResult = { name, method: request.method, path: request.path, account, ok: false, errors: [] };
  let req: HttpRequest;
  try {
    let p = String(interpolate(request.path, state.vars, true));
    if (request.query) {
      const q = interpolate(request.query, state.vars) as Record<string, unknown>;
      const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString();
      if (qs) p += (p.includes("?") ? "&" : "?") + qs;
    }
    if (!p.startsWith("/") || p.startsWith("//") || /[\r\n\\]/.test(p)) throw new Error(`Path ${show(p)} is not a path on the target`);
    base.path = p;
    const headers = { ...(interpolate(request.headers ?? {}, state.vars) as Record<string, string>) };
    if (account) {
      const auth = await ctx.auth?.header(account);
      if (!auth) throw new Error(`QA account ${account} could not authenticate`);
      for (const [k, v] of Object.entries(auth)) if (!Object.keys(headers).some((h) => h.toLowerCase() === k.toLowerCase())) headers[k] = v;
    }
    req = { method: request.method, path: p, headers, retry: false, tokenLabel: account ?? undefined, ...(request.json !== undefined ? { json: interpolate(request.json, state.vars) } : {}) };
  } catch (e) { return { ...base, errors: [(e as Error).message] }; }

  if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs));
  const res = await ctx.http!.send(req);
  state.evidence = { req, res };
  if (res.networkError) return { ...base, errors: [`No response: ${res.networkError}`] };
  const out: StepResult = { ...base, status: res.status, ms: res.ms };
  const errs = out.errors;
  const ex = st.expect ?? {};
  const statuses = ex.status === undefined ? null : Array.isArray(ex.status) ? ex.status : [ex.status];
  if (statuses ? !statuses.includes(res.status) : res.status < 200 || res.status > 299) errs.push(`status: expected ${statuses ? statuses.join(" or ") : "2xx"}, got ${res.status}`);
  if (ex.maxMs !== undefined && res.ms > ex.maxMs) errs.push(`time: expected at most ${ex.maxMs} ms, took ${Math.round(res.ms)} ms`);
  for (const [h, want] of Object.entries(ex.headers ?? {})) {
    const got = res.headers.get(h);
    const w = typeof want === "string" ? { equals: String(interpolate(want, state.vars)) } : (interpolate(want, state.vars) as Exclude<typeof want, string>);
    if (w.exists !== undefined && (got !== null) !== w.exists) errs.push(`header ${h}: expected ${w.exists ? "present" : "absent"}`);
    if (got === null) { if (w.equals !== undefined || w.contains !== undefined || w.matches !== undefined) errs.push(`header ${h}: missing`); continue; }
    if (w.equals !== undefined && got !== w.equals) errs.push(`header ${h}: expected ${show(w.equals)}, got ${show(got)}`);
    if (w.contains !== undefined && !got.includes(w.contains)) errs.push(`header ${h}: expected to contain ${show(w.contains)}, got ${show(got)}`);
    if (w.matches !== undefined && !new RegExp(w.matches).test(got)) errs.push(`header ${h}: expected to match /${w.matches}/, got ${show(got)}`);
  }
  if (ex.text) {
    const t = res.text ?? "";
    if (ex.text.contains !== undefined && !t.includes(String(interpolate(ex.text.contains, state.vars)))) errs.push(`body: expected to contain ${show(ex.text.contains)}`);
    if (ex.text.notContains !== undefined && t.includes(String(interpolate(ex.text.notContains, state.vars)))) errs.push(`body: expected not to contain ${show(ex.text.notContains)}`);
    if (ex.text.matches !== undefined && !(t.length <= 1_000_000 && new RegExp(ex.text.matches).test(t))) errs.push(`body: expected to match /${ex.text.matches}/`);
  }
  const needsJson = !!(ex.json?.length || ex.schema !== undefined || ex.snapshot || Object.values(st.save ?? {}).some((v) => typeof v === "string"));
  if (needsJson && res.json === undefined) errs.push(`body: expected JSON, got ${res.headers.get("content-type") ?? "no content type"}`);
  else {
    for (const a of ex.json ?? []) errs.push(...check(res.json, interpolateAssertion(a, state.vars) as typeof a));
    if (ex.schema !== undefined) errs.push(...validateSchema(res.json, ex.schema).map((e) => `schema: ${e}`));
    // A step that already failed is reported as failed; a snapshot complaint on top would only add noise.
    if (ex.snapshot && !errs.length) {
      const file = path.join(path.resolve(ctx.configDir, c.snapshotDir), `${ex.snapshot.name ?? `${slug(s.name)}--${slug(name)}`}.json`);
      const current = snapshotValue(res.json, ex.snapshot.ignore, ex.snapshot.mode);
      if (ctx.updateBaseline) {
        if (!errs.length) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ version: 1, scenario: s.name, step: name, mode: ex.snapshot.mode, value: current }, null, 2) + "\n"); out.snapshot = "written"; }
      } else if (!fs.existsSync(file)) { out.snapshot = "missing"; state.snapshotMissing.push(`${s.name} › ${name}`); }
      else {
        let stored: unknown;
        try { stored = (JSON.parse(fs.readFileSync(file, "utf8")) as { value: unknown }).value; } catch { throw new Error(`Snapshot ${path.relative(ctx.configDir, file)} is not valid JSON`); }
        const diff = diffValues(stored, current);
        out.snapshot = diff.length ? "changed" : "matched";
        errs.push(...diff.map((d) => `snapshot: ${d}`));
      }
    }
  }
  if (!errs.length) {
    for (const [v, from] of Object.entries(st.save ?? {})) {
      if (typeof from === "string") {
        const got = getPath(res.json, from);
        if (!got.found) { errs.push(`save ${v}: ${from} not found in the response`); continue; }
        state.vars[v] = got.value;
      } else {
        const h = res.headers.get(from.header);
        if (h === null) { errs.push(`save ${v}: header ${from.header} missing`); continue; }
        state.vars[v] = h;
      }
    }
  }
  out.ok = errs.length === 0;
  return out;
}

export async function runScenario(ctx: RunContext, c: Config, s: Scenario, runId: string, index: number, db?: () => Promise<DbConn>): Promise<{ result: ScenarioResult; state: RunState }> {
  const started = Date.now();
  const now = new Date();
  const state: RunState = { vars: {}, snapshotMissing: [], db };
  const result: ScenarioResult = { name: s.name, file: s.file, tags: s.tags, status: "passed", ms: 0, steps: [], cleanup: [] };
  try {
    // uniqueDigits: ten digits, for fields that must be numeric and short (phone numbers).
    // The scenario index keeps scenarios of one run apart; the clock keeps runs apart.
    state.vars = { unique: `${runId}${index.toString(36)}`, uniqueDigits: `${String(now.getTime()).slice(-8)}${String(index % 100).padStart(2, "0")}`,
      now: now.toISOString(), today: now.toISOString().slice(0, 10) };
    Object.assign(state.vars, interpolate(s.vars, state.vars) as Record<string, unknown>);
  } catch (e) {
    return { result: { ...result, status: "failed", reason: (e as Error).message, ms: Date.now() - started }, state };
  }
  for (const [i, st] of s.steps.entries()) {
    const r = await runStep(ctx, c, s, st, i, "step", state);
    result.steps.push(r);
    if (!r.ok) {
      result.status = "failed";
      for (const [j, rest] of s.steps.slice(i + 1).entries()) result.steps.push({ name: rest.name ?? `step ${i + j + 2}`, method: rest.request?.method ?? "DB", path: rest.request?.path ?? rest.db?.collection ?? "sql", account: null, ok: false, errors: [], skipped: "an earlier step failed" });
      break;
    }
  }
  const failedEvidence = result.status === "failed" ? state.evidence : undefined;
  // Cleanup always runs, so test data does not pile up; a step whose variables were never saved is skipped.
  for (const [i, st] of s.cleanup.entries()) {
    const r = await runStep(ctx, c, s, st, i, "cleanup", state);
    if (!r.ok && r.errors.length === 1 && /^Unknown variable/.test(r.errors[0])) result.cleanup.push({ ...r, skipped: r.errors[0], errors: [] });
    else result.cleanup.push(r);
  }
  if (failedEvidence) state.evidence = failedEvidence;
  result.ms = Date.now() - started;
  return { result, state };
}

// ---------- reports ----------

const xml = (s: string) => s.replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
export function junitXml(results: ScenarioResult[]): string {
  const failures = results.filter((r) => r.status === "failed").length, skipped = results.filter((r) => r.status === "skipped").length;
  const cases = results.map((r) => {
    const failed = r.steps.find((s) => !s.ok && !s.skipped);
    const body = r.status === "skipped" ? `<skipped message="${xml(r.reason ?? "")}"/>`
      : r.status === "failed" ? `<failure message="${xml(r.reason ?? `${failed?.name}: ${failed?.errors[0] ?? "failed"}`)}">${xml(failed ? failed.errors.join("\n") : r.reason ?? "")}</failure>` : "";
    return `<testcase classname="${xml(r.file)}" name="${xml(r.name)}" time="${(r.ms / 1000).toFixed(3)}">${body}</testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="api-scenarios" tests="${results.length}" failures="${failures}" skipped="${skipped}">${cases.join("")}</testsuite></testsuites>\n`;
}

function stepLine(r: StepResult) { return r.method === "DB" ? `database read on ${r.path}` : `${r.method} ${r.path}${r.account ? ` as ${r.account}` : " (anonymous)"}`; }

export async function apiScenarios(ctx: RunContext, c: Config) {
  if (!ctx.http) throw new Error("API scenarios need the target URL (set QA_BASE_URL)");
  const all = loadScenarios(ctx.configDir, Array.isArray(c.files) ? c.files : [c.files], c.database?.type);
  const include = process.env.QA_SCENARIO_TAGS ? process.env.QA_SCENARIO_TAGS.split(",").map((t) => t.trim()).filter(Boolean) : c.tags;
  const selected = selectScenarios(all, include, c.excludeTags);
  if (!selected.length) throw new SkipError(`No scenario matches tags ${include.join(", ") || "(any)"}${c.excludeTags.length ? ` without ${c.excludeTags.join(", ")}` : ""} (${all.length} defined)`);
  const writesAllowed = !!(ctx.config.allowMutations && ctx.config.disposable);
  const runId = `vq${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

  const results: ScenarioResult[] = [];
  const findings: Finding[] = [];
  const missing: string[] = [];
  // One read-only database connection, opened only if a scenario that runs has a db step.
  let dbConn: Promise<DbConn> | undefined;
  const db = () => (dbConn ??= openDb(c.database!, c.dbTimeoutMs));
  try {
  for (const [i, s] of selected.entries()) {
    if (mutating(s) && !writesAllowed) {
      results.push({ name: s.name, file: s.file, tags: s.tags, status: "skipped", reason: "writes data; runs only with allowMutations and disposable", ms: 0, steps: [], cleanup: [] });
      continue;
    }
    const { result, state } = await runScenario(ctx, c, s, runId, i, usesDb(s) ? db : undefined);
    results.push(result);
    missing.push(...state.snapshotMissing);
    const failed = result.steps.find((x) => !x.ok && !x.skipped);
    if (result.status === "failed") {
      const pos = failed ? result.steps.indexOf(failed) + 1 : 0;
      const detail = failed
        ? `Step ${pos} of ${s.steps.length} "${failed.name}" (${stepLine(failed)}${failed.status ? `, HTTP ${failed.status}` : ""}):\n${failed.errors.map((e) => `- ${sanitizeEvidenceText(e, 400)}`).join("\n")}`
        : `Scenario setup failed: ${result.reason}`;
      const ev = state.evidence;
      findings.push({
        plugin: "api-scenarios", severity: s.severity as Severity, title: `API scenario failed: ${s.name}`, target: `${s.file} › ${s.name}`,
        detail: `${detail}${s.description ? `\n\nScenario: ${s.description}` : ""}`, category: "regression", confidence: "high",
        remediation: "Fix the API behaviour, or, if the expected behaviour changed on purpose, update the scenario (and its snapshot with qa run --only api-scenarios --baseline).",
        ...(ev && failed ? { evidence: { url: ev.res.url, status: ev.res.status || undefined, curl: ctx.http.curl(ev.req), responseSnippet: ev.res.networkError ? undefined : responseEvidence(ev.res) } } : {}),
      });
    }
    const badCleanup = result.cleanup.filter((x) => !x.ok && !x.skipped);
    if (badCleanup.length) {
      findings.push({ plugin: "api-scenarios", severity: "medium", title: `API scenario cleanup failed: ${s.name}`, target: `${s.file} › ${s.name} › cleanup`, category: "env", confidence: "high",
        detail: badCleanup.map((x) => `${x.name} (${stepLine(x)}${x.status ? `, HTTP ${x.status}` : ""}): ${x.errors.map((e) => sanitizeEvidenceText(e, 300)).join("; ")}`).join("\n"),
        remediation: "Remove the test data this scenario created, and fix the cleanup step so later runs start clean." });
    }
  }
  } finally { if (dbConn) await (await dbConn.catch(() => undefined))?.close(); }
  if (missing.length) {
    findings.push({ plugin: "api-scenarios", severity: "high", title: "API snapshots not recorded yet", target: c.snapshotDir, category: "config", confidence: "high",
      detail: `${missing.length} snapshot comparison(s) could not run:\n${missing.slice(0, 20).join("\n")}`,
      remediation: "Review the responses, then record snapshots with qa run --only api-scenarios --baseline and commit them." });
  }

  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.outDir, "api-scenarios.json"), JSON.stringify({ runId, tags: include, results }, null, 2));
  fs.writeFileSync(path.join(ctx.outDir, "api-scenarios.junit.xml"), junitXml(results));
  const count = (st: ScenarioResult["status"]) => results.filter((r) => r.status === st).length;
  const stats = { scenarios: results.length, passed: count("passed"), failed: count("failed"), skipped: count("skipped"), requests: results.reduce((n, r) => n + r.steps.filter((x) => !x.skipped).length + r.cleanup.filter((x) => !x.skipped).length, 0) };
  if (!stats.passed && !stats.failed) throw new SkipError(`All ${stats.skipped} selected scenario(s) write data; they run only with allowMutations and disposable`);
  // Per-scenario outcomes go to the platform, where UAT criteria linked to a scenario show its latest result.
  const cases = results.slice(0, 2000).map((r) => ({ name: r.name.slice(0, 200), status: r.status, tags: r.tags.slice(0, 20), ms: r.ms }));
  return { findings, stats, cases };
}

export const apiScenariosPlugin = checkedPlugin("api-scenarios", "api", "Multi-step functional API scenarios from YAML/JSON: chained requests, value and schema assertions, snapshots, tags for smoke/regression/UAT",
  apiScenariosSchema, (ctx, c) => apiScenarios(ctx, c), ["baseUrl"]);
