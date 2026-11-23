import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { RunContext } from "../../core/context.js";
import { openDb, scrubDbError, validateMongoQuery, validateSql, type DbConn, type DbQuery, type DbResult } from "../../core/db.js";
import { sanitizeEvidenceText } from "../../core/http.js";
import { assertionSchema, check, show } from "../../core/json-assert.js";
import { SkipError, type Finding, type Severity } from "../../core/types.js";
import { expandReports } from "./flaky-tests.js";
import { checkedPlugin } from "./support.js";

/**
 * Data-integrity checks: rules about the data itself, written as read-only queries
 * (MongoDB filter/aggregate, or one SQL SELECT) with an expected count. Examples:
 * promotions whose merchant was deleted, duplicate emails, negative point balances,
 * expired promotions still marked active. Only a count and a few sample ids are
 * reported; row contents are never copied into findings.
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const relPattern = z.string().min(1).max(1024).refine((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes(".."), "Use a path relative to the configuration directory");
const tag = z.string().min(1).max(50).regex(/^[A-Za-z0-9_.-]+$/);

export const databaseSpec = z.object({
  type: z.enum(["mongodb", "postgres", "mysql"]),
  urlEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "Name of an environment variable, e.g. QA_DB_URL").default("QA_DB_URL"),
  database: z.string().min(1).max(64).optional(),
}).strict();

export const dbChecksSchema = z.object({
  database: databaseSpec,
  files: z.union([relPattern, z.array(relPattern).min(1).max(50)]),
  tags: z.array(tag).max(50).default([]),
  excludeTags: z.array(tag).max(50).default([]),
  timeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
}).strict();
type Config = z.output<typeof dbChecksSchema>;

export const dbExpectSpec = z.object({
  count: z.number().int().min(0).optional(),
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(0).optional(),
  json: z.array(assertionSchema).max(100).optional(),
}).strict();
export const dbQueryFields = {
  collection: z.string().min(1).max(120).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  pipeline: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
  sql: z.string().min(1).max(20_000).optional(),
  params: z.array(z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()])).max(100).optional(),
};
const checkSpec = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  tags: z.array(tag).max(20).default([]),
  severity: z.enum(["critical", "high", "medium", "low"]).default("high"),
  ...dbQueryFields,
  expect: dbExpectSpec.default({ count: 0 }),
  sampleField: z.string().min(1).max(100).optional(),
}).strict();
const fileSpec = z.object({ version: z.literal(1).optional(), checks: z.array(checkSpec).min(1).max(500) }).strict();
export type DataCheck = z.output<typeof checkSpec> & { file: string };

/** The query a check (or a scenario database step) describes, validated for the database type. */
export function dbQueryFor(type: Config["database"]["type"], q: { collection?: string; filter?: Record<string, unknown>; pipeline?: Record<string, unknown>[]; sql?: string; params?: unknown[] }): DbQuery {
  if (type === "mongodb") {
    if (!q.collection || q.sql) throw new Error("A MongoDB check needs collection (with filter or pipeline) and no sql");
    validateMongoQuery({ collection: q.collection, filter: q.filter, pipeline: q.pipeline });
    return { collection: q.collection, ...(q.pipeline ? { pipeline: q.pipeline } : { filter: q.filter ?? {} }) };
  }
  if (!q.sql || q.collection || q.filter || q.pipeline) throw new Error(`A ${type === "postgres" ? "PostgreSQL" : "MySQL"} check needs sql (and params) only`);
  validateSql(q.sql);
  return { sql: q.sql, params: q.params ?? [] };
}

/** Failure messages for a result against an expectation (empty = passed). */
export function checkResult(result: DbResult, expect: z.output<typeof dbExpectSpec>): string[] {
  const errs: string[] = [];
  const n = result.count, more = result.truncated ? " or more" : "";
  if (expect.count !== undefined && (n !== expect.count || result.truncated)) errs.push(`expected ${expect.count} row(s), found ${n}${more}`);
  if (expect.min !== undefined && n < expect.min) errs.push(`expected at least ${expect.min} row(s), found ${n}`);
  if (expect.max !== undefined && (n > expect.max || result.truncated)) errs.push(`expected at most ${expect.max} row(s), found ${n}${more}`);
  for (const a of expect.json ?? []) errs.push(...check(result.rows, a));
  return errs;
}

export function loadDataChecks(configDir: string, patterns: string[], type: Config["database"]["type"]): DataCheck[] {
  const out: DataCheck[] = [];
  for (const file of expandReports(configDir, patterns, "data check file")) {
    const rel = path.relative(configDir, file).split(path.sep).join("/");
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`Data check file ${rel} exceeds 2 MiB`);
    let data: unknown;
    try { data = /\.json$/i.test(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : parseYaml(fs.readFileSync(file, "utf8"), { maxAliasCount: 50 }); }
    catch (e) { throw new Error(`Data check file ${rel} could not be parsed: ${(e as Error).message.split("\n")[0]}`); }
    const parsed = fileSpec.safeParse(data);
    if (!parsed.success) { const i = parsed.error.issues[0]; throw new Error(`Data check file ${rel}: ${i.path.join(".") || "(root)"}: ${i.message}`); }
    for (const c of parsed.data.checks) {
      try { dbQueryFor(type, c); } catch (e) { throw new Error(`Data check "${c.name}" in ${rel}: ${(e as Error).message}`); }
      if (out.some((x) => x.name === c.name)) throw new Error(`Data check name "${c.name}" is used twice (${rel})`);
      out.push({ ...c, file: rel });
    }
  }
  return out;
}

const samples = (result: DbResult, field: string | undefined, type: string) => {
  const key = field ?? (type === "mongodb" ? "_id" : "id");
  const vals = result.rows.map((r) => r[key]).filter((v) => v !== undefined && v !== null).slice(0, 5);
  return vals.length ? `Sample ${key}: ${vals.map((v) => sanitizeEvidenceText(show(v, key), 80)).join(", ")}` : "";
};

export async function dbChecks(ctx: RunContext, c: Config) {
  const all = loadDataChecks(ctx.configDir, Array.isArray(c.files) ? c.files : [c.files], c.database.type);
  const selected = all.filter((x) => (!c.tags.length || x.tags.some((t) => c.tags.includes(t))) && !x.tags.some((t) => c.excludeTags.includes(t)));
  if (!selected.length) throw new SkipError(`No data check matches tags ${c.tags.join(", ") || "(any)"} (${all.length} defined)`);
  const conn: DbConn = await openDb(c.database, c.timeoutMs);
  const findings: Finding[] = [];
  const report: { name: string; file: string; count?: number; truncated?: boolean; passed: boolean; error?: string; ms: number }[] = [];
  try {
    for (const chk of selected) {
      const started = Date.now();
      const target = `${c.database.type} › ${chk.collection ?? "sql"} › ${chk.name}`;
      let result: DbResult;
      try { result = await conn.run(dbQueryFor(c.database.type, chk)); }
      catch (e) {
        const msg = scrubDbError((e as Error).message);
        report.push({ name: chk.name, file: chk.file, passed: false, error: msg, ms: Date.now() - started });
        findings.push({ plugin: "db-checks", severity: "high", title: `Data check could not run: ${chk.name}`, target, category: "config", confidence: "high",
          detail: `${chk.file}: ${msg}`, remediation: "Fix the query (collection, table and column names, parameters) or the database permissions of the QA user." });
        continue;
      }
      const errs = checkResult(result, chk.expect);
      report.push({ name: chk.name, file: chk.file, count: result.count, truncated: result.truncated, passed: !errs.length, ms: Date.now() - started });
      if (errs.length) {
        const sample = samples(result, chk.sampleField, c.database.type);
        findings.push({ plugin: "db-checks", severity: chk.severity as Severity, title: `Data integrity check failed: ${chk.name}`, target, category: "regression", confidence: "high",
          detail: `${errs.map((e) => `- ${sanitizeEvidenceText(e, 300)}`).join("\n")}${sample ? `\n${sample}` : ""}${chk.description ? `\n\n${chk.description}` : ""}`,
          remediation: "Repair the affected records and fix the code path that allowed them (validation, cascading delete, a missing unique index, a transaction)." });
      }
    }
  } finally { await conn.close(); }
  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.outDir, "db-checks.json"), JSON.stringify({ database: c.database.type, checks: report }, null, 2));
  return { findings, stats: { checks: report.length, passed: report.filter((r) => r.passed).length, failed: report.filter((r) => !r.passed && !r.error).length, errors: report.filter((r) => r.error).length } };
}

export const dbChecksPlugin = checkedPlugin("db-checks", "static", "Read-only data-integrity rules on MongoDB, PostgreSQL or MySQL (orphans, duplicates, impossible values) with expected counts",
  dbChecksSchema, (ctx, c) => dbChecks(ctx, c));
// It reads the database named in its settings, never the target API.
dbChecksPlugin.usesTarget = () => false;
