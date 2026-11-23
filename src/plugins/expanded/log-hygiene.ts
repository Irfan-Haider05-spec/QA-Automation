import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import ts from "typescript";
import { z } from "zod";
import type { RunContext } from "../../core/context.js";
import { SkipError, type Finding, type Severity } from "../../core/types.js";
import { scriptKind, sourceFiles } from "../../discovery/mongoose-models.js";
import { RULES as SECRET_RULES } from "../secrets.js";
import { expandReports } from "./flaky-tests.js";
import { checkedPlugin, disposable, issue, localPath } from "./support.js";

/**
 * Log hygiene: credentials and personal data must not reach logs.
 *
 *  - source: logging calls (console, logger/errorLogger/winston/pino, morgan formats) that
 *    pass request bodies, headers or values named like passwords and tokens;
 *  - logs: the application's real log output, scanned line by line for passwords,
 *    tokens, keys, card numbers and (optionally) personal data;
 *  - canary: in a disposable environment, a unique value is sent to the API and the log
 *    lines written afterwards are searched for it, which proves what the app logs.
 * Values are never reported: findings name the rule, the file and line, and a length.
 */

const LOCATIONS = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_LINE = 64 * 1024;
const relPattern = z.string().min(1).max(1024).refine((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes(".."), "Use a path relative to the configuration directory");

const canarySchema = z.object({
  method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
  path: localPath,
  json: z.record(z.string(), z.unknown()),
  logs: z.union([relPattern, z.array(relPattern).min(1).max(20)]),
  settleMs: z.number().int().min(0).max(60_000).default(2000),
}).strict().refine((c) => JSON.stringify(c.json).includes("{{canary}}"), "Put {{canary}} in at least one json value (for example the password)");

export const logHygieneSchema = z.object({
  source: z.boolean().default(true),
  logs: z.union([relPattern, z.array(relPattern).min(1).max(50)]).optional(),
  pii: z.object({ emails: z.boolean().default(true), phones: z.boolean().default(true), idNumbers: z.boolean().default(true), cards: z.boolean().default(true) }).strict().default({ emails: true, phones: true, idNumbers: true, cards: true }),
  ignoreEmailDomains: z.array(z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i)).max(100).default([]),
  canary: canarySchema.optional(),
}).strict().refine((c) => c.source || c.logs || c.canary, "Enable source, logs or canary");
type Config = z.output<typeof logHygieneSchema>;

// ---------- source analysis ----------

const SENSITIVE = new Set(["password", "passwd", "pwd", "newpassword", "oldpassword", "confirmpassword", "currentpassword", "passwordconfirm", "passwordhash",
  "secret", "clientsecret", "secretkey", "apikey", "apisecret", "token", "accesstoken", "refreshtoken", "idtoken", "authtoken", "jwt", "bearer",
  "otp", "otpcode", "pin", "cvv", "cvc", "cardnumber", "creditcard", "authorization", "cookie", "cookies", "privatekey", "sessionid", "sessiontoken"]);
const isSensitiveName = (name: string) => SENSITIVE.has(name.toLowerCase().replace(/[_-]/g, ""));
const LOG_METHODS = new Set(["log", "info", "warn", "warning", "error", "debug", "trace", "fatal", "verbose", "silly", "http", "notice", "critical"]);
const REQUEST_NAMES = new Set(["req", "request", "ctx"]);

export type SourceKind = "body" | "headers" | "request" | "sensitive";
export interface SourceHit { kind: SourceKind; name: string; source: string }

const unwrap = (e: ts.Expression): ts.Expression => {
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
};
/** `req.body`, `request.body`, `ctx.request.body` → the chain of names. */
const chain = (e: ts.Expression): string[] => {
  e = unwrap(e);
  if (ts.isIdentifier(e)) return [e.text];
  if (e.kind === ts.SyntaxKind.ThisKeyword) return ["this"];
  if (ts.isPropertyAccessExpression(e)) return [...chain(e.expression), e.name.text];
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return [...chain(e.expression), e.argumentExpression.text];
  return ["?"];
};

function isLoggingCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !LOG_METHODS.has(callee.name.text)) return false;
  const owner = chain(callee.expression);
  const last = owner[owner.length - 1] ?? "";
  return last === "console" || /^(log|logger|logging|winston|pino|bunyan)$/i.test(last) || /logger$/i.test(last);
}

/** What an argument would put in the log, following concatenation, templates, objects and JSON.stringify. */
function argumentHits(e: ts.Expression, out: { kind: SourceKind; name: string }[], depth = 0) {
  if (depth > 12) return;
  e = unwrap(e);
  const c = chain(e);
  if (c[0] !== "?" && (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))) {
    const reqIdx = c.findIndex((n) => REQUEST_NAMES.has(n));
    const after = reqIdx >= 0 ? c.slice(reqIdx + 1).filter((n) => n !== "request") : [];
    if (reqIdx >= 0 && after.length === 0 && c.length - 1 === reqIdx && c[reqIdx] !== "ctx") { out.push({ kind: "request", name: c.join(".") }); return; }
    if (reqIdx >= 0 && after[0] === "body") { out.push({ kind: "body", name: c.join(".") }); return; }
    if (reqIdx >= 0 && (after[0] === "headers" || after[0] === "cookies" || after[0] === "signedCookies")) { out.push({ kind: "headers", name: c.join(".") }); return; }
    if (isSensitiveName(c[c.length - 1])) out.push({ kind: "sensitive", name: c.join(".") });
    return;
  }
  if (ts.isTemplateExpression(e)) { for (const s of e.templateSpans) argumentHits(s.expression, out, depth + 1); return; }
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.PlusToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    argumentHits(e.left, out, depth + 1); argumentHits(e.right, out, depth + 1); return;
  }
  if (ts.isConditionalExpression(e)) { argumentHits(e.whenTrue, out, depth + 1); argumentHits(e.whenFalse, out, depth + 1); return; }
  if (ts.isArrayLiteralExpression(e)) { for (const x of e.elements) argumentHits(x as ts.Expression, out, depth + 1); return; }
  if (ts.isSpreadElement(e)) { argumentHits(e.expression, out, depth + 1); return; }
  if (ts.isObjectLiteralExpression(e)) {
    for (const p of e.properties) {
      if (ts.isShorthandPropertyAssignment(p)) argumentHits(p.name, out, depth + 1);
      else if (ts.isSpreadAssignment(p)) argumentHits(p.expression, out, depth + 1);
      else if (ts.isPropertyAssignment(p)) {
        const key = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : undefined;
        const v = unwrap(p.initializer);
        const literal = ts.isStringLiteralLike(v) || ts.isNumericLiteral(v) || v.kind === ts.SyntaxKind.TrueKeyword || v.kind === ts.SyntaxKind.FalseKeyword || v.kind === ts.SyntaxKind.NullKeyword;
        if (key && isSensitiveName(key) && !literal) out.push({ kind: "sensitive", name: key });
        else argumentHits(v, out, depth + 1);
      }
    }
    return;
  }
  if (ts.isCallExpression(e)) {
    // JSON.stringify(x) and util.inspect(x) log x; any other call (mask(token), token.length) is a transformation.
    const callee = chain(e.expression).join(".");
    if (/^(JSON\.stringify|util\.inspect|inspect|String)$/.test(callee) && e.arguments[0]) argumentHits(e.arguments[0], out, depth + 1);
  }
}

/** `console.log("::add-mask::" + value)` registers a value for masking in GitHub Actions logs; the line itself is not shown. */
function isMaskCommand(call: ts.CallExpression): boolean {
  const first = call.arguments[0] && unwrap(call.arguments[0]);
  if (!first) return false;
  const head = ts.isTemplateExpression(first) ? first.head.text : ts.isStringLiteralLike(first) ? first.text
    : ts.isBinaryExpression(first) && ts.isStringLiteralLike(first.left) ? first.left.text : "";
  return head.startsWith("::add-mask::");
}

const MORGAN_HEADER = /:req\[(authorization|cookie|x-api-key|proxy-authorization)\]/i;

export function scanSource(backendDir: string): { hits: SourceHit[]; files: number; warnings: string[] } {
  const warnings: string[] = [];
  const files = sourceFiles(backendDir, warnings);
  const hits: SourceHit[] = [];
  for (const file of files) {
    let sf: ts.SourceFile;
    try { sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, scriptKind(file)); }
    catch { warnings.push(`${path.relative(backendDir, file)} could not be parsed`); continue; }
    const rel = path.relative(backendDir, file).split(path.sep).join("/");
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const where = `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
        if (isLoggingCall(node) && !isMaskCommand(node)) {
          const found: { kind: SourceKind; name: string }[] = [];
          for (const a of node.arguments) argumentHits(a, found);
          const seen = new Set<string>();
          for (const f of found) { const k = `${f.kind}|${f.name}`; if (!seen.has(k)) { seen.add(k); hits.push({ ...f, source: where }); } }
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "morgan" && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
          const m = MORGAN_HEADER.exec(node.arguments[0].text);
          if (m) hits.push({ kind: "headers", name: `morgan :req[${m[1].toLowerCase()}]`, source: where });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { hits, files: files.length, warnings };
}

// ---------- log output scanning ----------

export interface LogRule { id: string; title: string; severity: Severity; pii?: keyof Config["pii"] }
interface Matcher extends LogRule { find: (line: string) => number[] }

const MASKED = /^(\*+|x{3,}|\[?redacted\]?|<redacted>|\[filtered\]|\[hidden\]|null|undefined|true|false|)$/i;
const FIELD_NAMES = "password|passwd|pwd|new_?password|old_?password|confirm_?password|current_?password|secret|client_?secret|api_?key|api_?secret|access_?token|refresh_?token|id_?token|auth_?token|token|otp|cvv|cvc|card_?number|authorization|cookie|private_?key";
// Quoted values: "password":"x", \"password\":\"x\", password: 'x' (util.inspect). Unquoted only as key=value
// (query strings, form bodies), so a message like "invalid password: user not found" is not a hit.
// Numbers only after a quoted JSON key ("otp": 123456).
const FIELD_RES = [
  new RegExp(String.raw`(?:\\?["']|\b)(${FIELD_NAMES})(?:\\?["'])?\s*[:=]\s*\\?["']([^"'\\]{1,500})\\?["']`, "gi"),
  new RegExp(String.raw`\b(${FIELD_NAMES})=([^\s,;&"'}{\]]{1,500})`, "gi"),
  new RegExp(String.raw`\\?["'](${FIELD_NAMES})\\?["']\s*:\s*(\d{3,})`, "gi"),
];

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
const CARD_PREFIX = /^(4\d{12}(\d{3}){0,2}|5[1-5]\d{14}|2[2-7]\d{14}|3[47]\d{13}|6011\d{12}|65\d{14}|35\d{14})$/;

function matchers(c: Config): Matcher[] {
  const ignored = (email: string) => {
    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    return /\.(test|invalid|example|localhost)$/.test(domain) || ["example.com", "example.org", "example.net"].includes(domain)
      || c.ignoreEmailDomains.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`));
  };
  const all = (re: RegExp, keep: (m: RegExpExecArray, line: string) => boolean = () => true) => (line: string) => {
    const out: number[] = [];
    for (const m of line.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) if (keep(m, line)) out.push(m[0].length);
    return out;
  };
  const fieldRule = (names: RegExp) => (line: string) => {
    const out: number[] = [];
    for (const m of FIELD_RES.flatMap((re) => [...line.matchAll(re)])) {
      const value = (m[2] ?? "").trim();
      if (!names.test(m[1]) || MASKED.test(value) || /^(\{\{.*\}\}|\$\{.*\}|<[^>]+>)$/.test(value)) continue;
      // An authorization/cookie value is reported by its own rule; plain JSON nulls and placeholders are not secrets.
      out.push(value.length);
    }
    return out;
  };
  const keyRules = SECRET_RULES.filter((r) => ["private-key", "aws-access-key", "stripe-live", "stripe-test", "mongo-uri-creds", "redis-uri-creds", "google-api-key"].includes(r.id))
    .map((r): Matcher => ({ id: r.id, title: r.title.replace(/ committed$/, " in log output"), severity: r.severity === "critical" ? "critical" : "high", find: all(r.re) }));
  const list: Matcher[] = [
    { id: "password-field", title: "Passwords in log output", severity: "critical", find: fieldRule(/^(password|passwd|pwd|new_?password|old_?password|confirm_?password|current_?password)$/i) },
    { id: "secret-field", title: "Tokens or secrets in log output", severity: "critical", find: fieldRule(/^(secret|client_?secret|api_?key|api_?secret|access_?token|refresh_?token|id_?token|auth_?token|token|otp|cvv|cvc|private_?key)$/i) },
    { id: "auth-header", title: "Authorization or cookie headers in log output", severity: "critical", find: all(/\b(?:authorization|cookie|set-cookie)\\?["']?\s*[:=]\s*\\?["']?(?:(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9_.-]+=[A-Za-z0-9%._~+/-]{8,})/gi) },
    { id: "jwt", title: "JSON Web Tokens in log output", severity: "critical", find: all(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) },
    ...keyRules,
    { id: "card-number", title: "Payment card numbers in log output", severity: "high", pii: "cards", find: all(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g, (m) => { const d = m[0].replace(/[ -]/g, ""); return CARD_PREFIX.test(d) && luhn(d); }) },
    { id: "email", title: "Email addresses in log output", severity: "medium", pii: "emails", find: all(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (m, line) => !ignored(m[0]) && !/\/\/[^\s/]*$/.test(line.slice(0, m.index))) }, // user:pass@host in a URL is not an email
    { id: "phone", title: "Phone numbers in log output", severity: "medium", pii: "phones", find: all(/(?<![\w.:/-])(?:\+\d{1,3}[ -]?|0)3\d{2}[ -]?\d{7}(?![\w.])|(?<![\w.:/-])\+\d{1,3}[ -]?\d{2,4}[ -]?\d{6,8}(?![\w.])/g) },
    { id: "id-number", title: "National ID numbers in log output", severity: "medium", pii: "idNumbers", find: all(/(?<![\w.])\d{5}-\d{7}-\d(?![\w.])/g) },
  ];
  return list.filter((m) => !m.pii || c.pii[m.pii]);
}

export interface LogHit { rule: string; title: string; severity: Severity; file: string; line: number; length: number }

/** Scan text (one log file, or the part written after a request) line by line. */
export function scanLogText(text: string, file: string, c: Config, firstLine = 1): LogHit[] {
  const ms = matchers(c);
  const hits: LogHit[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
    for (const m of ms) for (const length of m.find(line)) hits.push({ rule: m.id, title: m.title, severity: m.severity, file, line: firstLine + i, length });
  });
  return hits;
}

function readLog(file: string, from = 0): { text: string; size: number; firstLine: number } {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`Log file ${file} not found`);
  if (stat.size - from > MAX_FILE_BYTES) throw new Error(`Log file ${path.basename(file)} has more than 50 MiB to scan; rotate it or scan a smaller file`);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(stat.size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    let firstLine = 1;
    if (from > 0) {
      const head = Buffer.alloc(from);
      fs.readSync(fd, head, 0, from, 0);
      firstLine = head.toString("utf8").split("\n").length;
    }
    return { text: buf.toString("utf8"), size: stat.size, firstLine };
  } finally { fs.closeSync(fd); }
}

function groupHits(hits: LogHit[], configDir: string): Finding[] {
  const byRule = new Map<string, LogHit[]>();
  for (const h of hits) byRule.set(h.rule, [...(byRule.get(h.rule) ?? []), h]);
  const order: Severity[] = ["critical", "high", "medium", "low", "info"];
  return [...byRule.values()].sort((a, b) => order.indexOf(a[0].severity) - order.indexOf(b[0].severity) || b.length - a.length).map((list) => {
    const files = [...new Set(list.map((h) => path.relative(configDir, h.file).split(path.sep).join("/")))];
    const where = list.slice(0, LOCATIONS).map((h) => `${path.relative(configDir, h.file).split(path.sep).join("/")}:${h.line} (${h.length}-character value)`).join("\n");
    const f = issue("log-hygiene", list[0].title, files.length === 1 ? files[0] : `${files.length} log files`,
      `${list.length} occurrence(s); values are not shown:\n${where}${list.length > LOCATIONS ? `\n…and ${list.length - LOCATIONS} more` : ""}`, list[0].severity, "security", "CWE-532");
    return { ...f, remediation: "Stop writing this data: redact it in the logger (for example a winston/pino redact list for password, token, authorization, cookie), log request metadata instead of bodies, then rotate the affected logs and rotate any exposed credentials." };
  });
}

// ---------- canary ----------

export function injectCanary(value: unknown, canary: string): { json: unknown; fields: string[] } {
  const fields: string[] = [];
  const walk = (v: unknown, at: string): unknown => {
    if (typeof v === "string") { if (v.includes("{{canary}}")) { fields.push(at || "(body)"); return v.split("{{canary}}").join(canary); } return v; }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}[${i}]`));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, at ? `${at}.${k}` : k)]));
    return v;
  };
  return { json: walk(value, ""), fields };
}

async function runCanary(ctx: RunContext, c: NonNullable<Config["canary"]>) {
  if (!ctx.http) throw new Error("The canary needs the target URL (set QA_BASE_URL)");
  const files = expandReports(ctx.configDir, Array.isArray(c.logs) ? c.logs : [c.logs], "log file");
  const before = new Map(files.map((f) => [f, fs.statSync(f).size]));
  const canary = `VeriqCanary${randomBytes(12).toString("hex")}`;
  const { json, fields } = injectCanary(c.json, canary);
  const res = await ctx.http.send({ method: c.method, path: c.path, json, retry: false });
  if (res.networkError) throw new Error(`Canary request failed: ${res.networkError}`);
  await new Promise((r) => setTimeout(r, c.settleMs));
  let grew = false;
  const hits: { file: string; line: number }[] = [];
  for (const f of files) {
    const prev = before.get(f) ?? 0;
    const now = fs.statSync(f).size;
    const from = now < prev ? 0 : prev; // rotated or truncated: read the new file whole
    if (now === prev) continue;
    grew = true;
    const { text, firstLine } = readLog(f, from);
    const encoded = encodeURIComponent(canary);
    text.split(/\r?\n/).forEach((line, i) => { if (line.includes(canary) || line.includes(encoded)) hits.push({ file: f, line: firstLine + i }); });
  }
  // No new log lines means these files are not this app's live logs: absence would prove nothing.
  if (!grew) throw new Error(`No new log lines were written within ${c.settleMs} ms of the canary request (HTTP ${res.status}); point canary.logs at the file this API writes to`);
  return { hits, fields, status: res.status };
}

// ---------- plugin ----------

const SOURCE_TEXT: Record<SourceKind, { title: string; severity: Severity }> = {
  body: { title: "Request bodies written to logs", severity: "high" },
  headers: { title: "Request headers or cookies written to logs", severity: "high" },
  request: { title: "Whole request objects written to logs", severity: "high" },
  sensitive: { title: "Passwords or tokens passed to the logger", severity: "high" },
};

export async function logHygiene(ctx: RunContext, c: Config) {
  const findings: Finding[] = [];
  const stats: Record<string, number | string> = {};
  let ran = 0;

  if (c.source) {
    if (ctx.config.backend.none) stats.source = "skipped: no backend source";
    else {
      const s = scanSource(ctx.config.backend.dir);
      ran++;
      stats.sourceFiles = s.files; stats.sourceHits = s.hits.length;
      for (const kind of Object.keys(SOURCE_TEXT) as SourceKind[]) {
        const list = s.hits.filter((h) => h.kind === kind);
        if (!list.length) continue;
        const where = list.slice(0, LOCATIONS).map((h) => `${h.source} ${h.name}`).join("\n");
        findings.push({ ...issue("log-hygiene", SOURCE_TEXT[kind].title, "source", `${list.length} logging call(s):\n${where}${list.length > LOCATIONS ? `\n…and ${list.length - LOCATIONS} more` : ""}`, SOURCE_TEXT[kind].severity, "security", "CWE-532"),
          confidence: "medium", remediation: "Log an allow-list of safe fields (ids, route, status, duration) instead; configure the logger to redact password, token, authorization and cookie paths." });
      }
    }
  }

  if (c.logs) {
    const files = expandReports(ctx.configDir, Array.isArray(c.logs) ? c.logs : [c.logs], "log file");
    let total = 0;
    const hits: LogHit[] = [];
    for (const f of files) {
      total += fs.statSync(f).size;
      if (total > MAX_TOTAL_BYTES) throw new Error("Log files exceed 200 MiB in total");
      const { text } = readLog(f);
      hits.push(...scanLogText(text, f, c));
    }
    ran++;
    stats.logFiles = files.length; stats.logHits = hits.length;
    findings.push(...groupHits(hits, ctx.configDir));
  }

  if (c.canary) {
    let allowed = true;
    try { disposable(ctx); } catch (e) { if (e instanceof SkipError) { allowed = false; stats.canary = `skipped: ${e.message}`; } else throw e; }
    if (allowed) {
      const r = await runCanary(ctx, c.canary);
      ran++;
      stats.canary = r.hits.length ? "found in logs" : "not found in new log lines";
      if (r.hits.length) {
        const where = r.hits.slice(0, LOCATIONS).map((h) => `${path.relative(ctx.configDir, h.file).split(path.sep).join("/")}:${h.line}`).join("\n");
        findings.push({ ...issue("log-hygiene", "Value sent to the API was written to the logs", `${c.canary.method} ${c.canary.path}`,
          `A unique value sent in ${r.fields.join(", ")} (response HTTP ${r.status}) appeared in ${r.hits.length} new log line(s):\n${where}`, "critical", "security", "CWE-532"),
          remediation: "Find the logger call that writes this request (often a request-logging middleware or an error handler logging req.body) and redact the field; then rotate the affected logs." });
      }
    }
  }

  if (!ran) throw new SkipError(String(stats.canary ?? stats.source ?? "Nothing to check"));
  return { findings, stats };
}

export const logHygienePlugin = checkedPlugin("log-hygiene", "static", "Passwords, tokens and personal data in logging code and log output; optional disposable canary proof",
  logHygieneSchema, (ctx, c) => logHygiene(ctx, c));
// Only the canary sends a request to the target API.
logHygienePlugin.usesTarget = (ctx) => !!(ctx.config.pluginSettings?.["log-hygiene"] as { canary?: unknown } | undefined)?.canary;
