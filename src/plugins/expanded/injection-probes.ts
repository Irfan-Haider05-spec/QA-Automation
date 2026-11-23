import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { RunContext } from "../../core/context.js";
import { responseEvidence, sanitizeEvidenceText, type HttpRequest, type HttpResponse } from "../../core/http.js";
import { assertionSchema, check, getPath } from "../../core/json-assert.js";
import type { Finding, Severity } from "../../core/types.js";
import { checkedPlugin, disposable, localPath } from "./support.js";

/**
 * Injection probes for explicitly listed inputs, in a disposable environment only.
 *
 * NoSQL (MongoDB operators): the marked value is replaced by an operator object such as
 * {"$ne": null} (or `field[$ne]=` in a query string). SQL: boolean pairs (a TRUE and a
 * FALSE condition), quote-breaking inputs that expose database errors, and optional
 * time delays. Every probe is judged against a control request with an ordinary value:
 * a case is reported only when the payload changes the outcome the way an injection
 * would, and positives are repeated once to rule out flakiness. No stacked or
 * destructive statements are ever sent.
 */

const PROBE = "{{probe}}";
const scalar = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
const caseSchema = z.object({
  name: z.string().min(1).max(200),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  path: localPath,
  account: z.string().min(1).max(100).optional(),
  query: z.record(z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/), scalar).optional(),
  json: z.record(z.string(), z.unknown()).optional(),
  kinds: z.array(z.enum(["nosql", "sql"])).min(1).max(2).default(["nosql", "sql"]),
  /** What a "successful" answer looks like (for example a login that returns a token). */
  success: z.object({ status: z.array(z.number().int().min(100).max(599)).min(1).max(10).default([200]), json: z.array(assertionSchema).max(20).default([]) }).strict().optional(),
  /** Or: a JSON path to the result list (or count); more results than the control means the filter was bypassed. */
  resultPath: z.string().min(1).max(200).startsWith("$").optional(),
  /** Ordinary value for the control request (default: a random string that matches nothing). */
  control: z.string().max(200).optional(),
  /** SQL injection by delay (PostgreSQL pg_sleep, MySQL SLEEP), repeated twice; slower. */
  timeBased: z.boolean().default(false),
  delaySeconds: z.number().int().min(2).max(10).default(3),
  severity: z.enum(["critical", "high", "medium"]).default("critical"),
}).strict().superRefine((c, ctx) => {
  const marked = [...Object.values(c.query ?? {}), ...collect(c.json)].filter((v) => v === PROBE).length;
  if (marked !== 1) ctx.addIssue({ code: "custom", message: `Mark exactly one input as "${PROBE}" (a whole query or JSON value); found ${marked}` });
  if (!c.success === !c.resultPath) ctx.addIssue({ code: "custom", message: "Give success (what an accepted answer looks like) or resultPath (a list to count), not both" });
  if (c.json && c.method === "GET") ctx.addIssue({ code: "custom", message: "GET requests carry the probe in query, not json" });
});
export const injectionProbesSchema = z.object({ cases: z.array(caseSchema).min(1).max(30) }).strict();
type Case = z.output<typeof caseSchema>;

function collect(v: unknown, out: unknown[] = [], depth = 0): unknown[] {
  if (depth > 20) return out;
  if (Array.isArray(v)) v.forEach((x) => collect(x, out, depth + 1));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collect(x, out, depth + 1));
  else out.push(v);
  return out;
}

/** Replace the marked value (deeply) with `value`. */
export function place(v: unknown, value: unknown, depth = 0): unknown {
  if (depth > 20) return v;
  if (v === PROBE) return value;
  if (Array.isArray(v)) return v.map((x) => place(x, value, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, place(x, value, depth + 1)]));
  return v;
}

export const NOSQL_OPERATORS: Record<string, unknown>[] = [{ $ne: null }, { $gt: "" }, { $regex: ".*" }, { $exists: true }];
export const SQL_ERROR_SIGNATURES = /SQL syntax|syntax error at or near|unterminated quoted string|unclosed quotation mark|quoted string not properly terminated|SQLSTATE\[|ORA-\d{5}|PG::SyntaxError|pg_query\(|mysql_fetch|mysqli?_|SQLite3?::|near "[^"]*": syntax error|ER_PARSE_ERROR|Incorrect syntax near|psycopg2\.|sequelize.*Error|QueryFailedError/i;

interface Sent { req: HttpRequest; res: HttpResponse; label: string }

export async function injectionProbes(ctx: RunContext, c: z.output<typeof injectionProbesSchema>) {
  disposable(ctx);
  if (!ctx.http) throw new Error("Injection probes need the target URL (set QA_BASE_URL)");
  const http = ctx.http;
  const findings: Finding[] = [];
  let requests = 0, inconclusive = 0;
  const notes: string[] = [];

  for (const cs of c.cases) {
    const headers: Record<string, string> = {};
    if (cs.account) {
      const auth = await ctx.auth?.header(cs.account);
      if (!auth) throw new Error(`QA account ${cs.account} could not authenticate`);
      Object.assign(headers, auth);
    }
    const probeKey = Object.entries(cs.query ?? {}).find(([, v]) => v === PROBE)?.[0];
    const build = (value: unknown): HttpRequest => {
      let p = cs.path;
      if (cs.query) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(cs.query)) {
          if (k !== probeKey) { qs.append(k, String(v)); continue; }
          // Operator objects in a query string use the bracket syntax Express/qs turns back into objects.
          if (value && typeof value === "object") for (const [op, x] of Object.entries(value)) qs.append(`${k}[${op}]`, x === null ? "" : String(x));
          else qs.append(k, String(value));
        }
        p += `?${qs.toString()}`;
      }
      return { method: cs.method, path: p, headers, retry: false, tokenLabel: cs.account, ...(cs.json ? { json: place(cs.json, value) } : {}) };
    };
    const send = async (value: unknown, label: string): Promise<Sent> => { const req = build(value); requests++; return { req, res: await http.send(req), label }; };
    const accepted = (r: HttpResponse) => cs.success ? cs.success.status.includes(r.status) && cs.success.json.every((a) => check(r.json, a).length === 0) : false;
    const size = (r: HttpResponse): number | undefined => {
      if (!cs.resultPath) return undefined;
      const g = getPath(r.json, cs.resultPath);
      return !g.found ? undefined : Array.isArray(g.value) ? g.value.length : typeof g.value === "number" ? g.value : undefined;
    };
    const describe = (s: Sent) => `${s.label}: HTTP ${s.res.status}${cs.resultPath ? `, ${size(s.res) ?? "no"} result(s)` : cs.success ? (accepted(s.res) ? ", accepted" : ", not accepted") : ""}`;
    const report = (title: string, severity: Severity, cwe: string, lines: string[], ev: Sent, remediation: string) => findings.push({
      plugin: "injection-probes", severity, title, target: `${cs.method} ${cs.path} › ${cs.name}`, category: "security", cwe: [cwe], confidence: "high",
      detail: lines.join("\n"), remediation,
      evidence: { url: ev.res.url, status: ev.res.status || undefined, curl: http.curl(ev.req), responseSnippet: ev.res.networkError ? undefined : responseEvidence(ev.res) },
    });

    const controlValue = cs.control ?? `veriq${randomBytes(6).toString("hex")}`;
    const control = await send(controlValue, "control (ordinary value)");
    if (control.res.networkError) throw new Error(`${cs.name}: control request failed (${control.res.networkError})`);
    // With an account, 401/403 means the login did not work; without one, it is the normal answer to a wrong value (a login form).
    if (cs.account && (control.res.status === 401 || control.res.status === 403)) { inconclusive++; notes.push(`${cs.name}: control was refused (HTTP ${control.res.status}); check the account`); continue; }
    if (accepted(control.res)) { inconclusive++; notes.push(`${cs.name}: the control value is already accepted, so a bypass cannot be told apart; choose a control that must fail`); continue; }
    if (cs.resultPath && size(control.res) === undefined) { inconclusive++; notes.push(`${cs.name}: ${cs.resultPath} is not a list or number in the control response`); continue; }
    const baseSize = size(control.res) ?? 0;
    const beats = (r: HttpResponse) => cs.success ? accepted(r) : (size(r) ?? -1) > baseSize;

    if (cs.kinds.includes("nosql")) {
      let hit: Sent | undefined, crashed: Sent | undefined;
      for (const op of NOSQL_OPERATORS) {
        const p = await send(op, `operator ${JSON.stringify(op)}`);
        if (p.res.status >= 500 && control.res.status < 500) crashed ??= p;
        if (beats(p.res)) {
          const again = await send(op, `operator ${JSON.stringify(op)} (repeat)`);
          const control2 = await send(controlValue, "control (repeat)");
          if (beats(again.res) && !beats(control2.res)) { hit = p; break; }
        }
      }
      if (hit) report("NoSQL operator injection", cs.severity as Severity, "CWE-943",
        [`An operator object in place of the value changed the result; the control did not (both repeated).`, `- ${describe(control)}`, `- ${describe(hit)}`],
        hit, "Accept only the expected type for this field (cast to string or validate with a schema) before building the query; with Mongoose, enable sanitizeFilter or strict query casting.");
      // A server error shows the value is not type-checked; it does not show where it went
      // (MLITech's sanitizer strips the $ key and a string method then fails on the object).
      else if (crashed) report("Operator input causes a server error", "medium", "CWE-20",
        [`An object sent in place of a text value caused a server error instead of a validation error. The field is not type-checked; whether the object reaches the database is not known from outside.`, `- ${describe(control)}`, `- ${describe(crashed)}`],
        crashed, "Validate the type of this field and return 400 for objects where a text value is expected.");
    }

    if (cs.kinds.includes("sql")) {
      const base = cs.control ?? "veriq";
      const pairs: [string, string][] = [[`${base}' OR '1'='1`, `${base}' AND '1'='2`], [`${base}" OR "1"="1`, `${base}" AND "1"="2`], ["1 OR 1=1", "1 AND 1=2"], [`${base}') OR ('1'='1`, `${base}') AND ('1'='2`]];
      let found = false;
      for (const [t, f] of pairs) {
        const yes = await send(t, `TRUE condition ${JSON.stringify(t)}`);
        if (!beats(yes.res)) continue;
        const no = await send(f, `FALSE condition ${JSON.stringify(f)}`);
        const yes2 = await send(t, "TRUE condition (repeat)");
        if (!beats(no.res) && beats(yes2.res)) {
          report("SQL injection (boolean condition)", cs.severity as Severity, "CWE-89",
            [`A TRUE condition changed the result and a FALSE condition did not, so the input is part of the SQL text.`, `- ${describe(control)}`, `- ${describe(yes)}`, `- ${describe(no)}`],
            yes, "Use parameterised queries (placeholders) for this value; never build SQL by joining strings.");
          found = true; break;
        }
      }
      if (!found) for (const breaker of [`${base}'`, `${base}"`, `${base}')`]) {
        const p = await send(breaker, `quote ${JSON.stringify(breaker)}`);
        const text = p.res.text ?? "";
        if (SQL_ERROR_SIGNATURES.test(text) && !SQL_ERROR_SIGNATURES.test(control.res.text ?? "")) {
          report("SQL injection (database error exposed)", "high", "CWE-89",
            [`A quote character produced a database syntax error in the response; the control did not.`, `- ${describe(control)}`, `- ${describe(p)}: ${sanitizeEvidenceText((SQL_ERROR_SIGNATURES.exec(text) ?? [""])[0], 120)}`],
            p, "Use parameterised queries for this value and return generic error messages.");
          found = true; break;
        }
      }
      if (!found && cs.timeBased) {
        const d = cs.delaySeconds;
        // Single-statement delays only (PostgreSQL, MySQL/MariaDB); nothing is stacked after a semicolon.
        const slow = [`${base}' OR pg_sleep(${d}) IS NOT NULL OR '1'='2`, `${base}' OR SLEEP(${d}) OR '1'='2`];
        const t0 = Date.now(); await send(controlValue, "control (timing)"); const baseMs = Date.now() - t0;
        for (const s of slow) {
          const a = await send(s, `delay ${JSON.stringify(s)}`);
          if (a.res.ms < baseMs + d * 900) continue;
          const b = await send(s, "delay (repeat)");
          if (b.res.ms >= baseMs + d * 900) {
            report("SQL injection (time delay)", cs.severity as Severity, "CWE-89",
              [`A database delay of ${d} s in the input slowed the answer twice (${Math.round(a.res.ms)} ms, ${Math.round(b.res.ms)} ms; control ${baseMs} ms).`],
              a, "Use parameterised queries for this value.");
            break;
          }
        }
      }
    }
  }
  if (!findings.length && inconclusive === c.cases.length) throw new Error(`Every case was inconclusive: ${notes.join("; ")}`);
  return { findings, stats: { cases: c.cases.length, requests, inconclusive, ...(notes.length ? { notes: notes.join(" | ").slice(0, 500) } : {}) } };
}

export const injectionProbesPlugin = checkedPlugin("injection-probes", "security", "NoSQL operator and SQL injection probes on listed inputs, judged against control requests (disposable environments only)",
  injectionProbesSchema, (ctx, c) => injectionProbes(ctx, c), ["baseUrl"]);
