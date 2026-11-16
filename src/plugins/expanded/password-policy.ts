import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { RunContext } from "../../core/context.js";
import type { Finding } from "../../core/types.js";
import { checkedPlugin, disposable, issue, localPath, request } from "./support.js";

/**
 * Explicit password-policy workflow for account-creating endpoints (registration or
 * an admin "create user" route) in a disposable environment.
 *
 * Every submission creates a distinct user, so a weak password that is accepted never
 * changes an existing QA account. The plugin never sees or logs response bodies, and
 * neither passwords nor generated identifiers appear in findings or errors.
 */

const PASSWORD = "{{password}}";
const UNIQUE = "{{unique}}";
const PLACEHOLDER = /\{\{[^}]*\}\}/g;

export const PASSWORD_POLICY_CHECKS = ["length", "common", "identifier", "long"] as const;
type Check = typeof PASSWORD_POLICY_CHECKS[number];

/** Well-known passwords that satisfy typical composition rules (upper, lower, digit, symbol). */
export const DEFAULT_COMMON_PASSWORDS = ["Password123!", "Welcome2024!", "Qwerty123456!", "P@ssw0rd1234"];

const fieldValue = z.string().max(256);
const caseSchema = z.object({
  method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
  path: localPath,
  account: z.string().optional(),
  body: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/), fieldValue)
    .refine(b => Object.keys(b).length >= 1 && Object.keys(b).length <= 20, "body must have 1–20 fields"),
  minLength: z.number().int().min(6).max(64).default(12),
  checks: z.array(z.enum(PASSWORD_POLICY_CHECKS)).min(1).max(4).default(["length", "common"])
    .refine(c => new Set(c).size === c.length, "checks must not repeat"),
  commonPasswords: z.array(z.string().min(1).max(128)).min(1).max(10).optional(),
  acceptedStatuses: z.array(z.number().int().min(200).max(299)).min(1).max(5).default([200, 201, 204]),
  rejectionStatuses: z.array(z.number().int().min(400).max(499)).min(1).max(5).default([400, 422])
    .refine(s => !s.some(v => [401, 403, 404, 405, 408, 409, 429].includes(v)), "Use 400/422-style validation statuses; auth, conflict and rate-limit answers are not policy rejections"),
}).strict().superRefine((c, z2) => {
  const values = Object.values(c.body);
  const passwordFields = values.filter(v => v === PASSWORD).length;
  if (!passwordFields) z2.addIssue({ code: "custom", message: `At least one body field must be exactly ${PASSWORD}` });
  if (values.some(v => v !== PASSWORD && v.includes(PASSWORD))) z2.addIssue({ code: "custom", message: `${PASSWORD} must be a whole field value` });
  if (!values.some(v => v.includes(UNIQUE))) z2.addIssue({ code: "custom", message: `A body field must contain ${UNIQUE} so every submission creates a distinct user` });
  for (const v of values) for (const m of v.match(PLACEHOLDER) ?? []) if (m !== PASSWORD && m !== UNIQUE) z2.addIssue({ code: "custom", message: "Unsupported body placeholder" });
  if (c.commonPasswords && !c.checks.includes("common")) z2.addIssue({ code: "custom", message: "commonPasswords requires the common check" });
});
export const passwordPolicySchema = z.object({ cases: z.array(caseSchema).min(1).max(10) }).strict();
type Case = z.output<typeof caseSchema>;

interface Probe { check: Check | "control"; title?: string; password: (unique: string) => string; expect: "accept" | "reject"; cwe?: string; severity?: Finding["severity"] }

/** A random password with all four character classes, of exactly `length` characters. */
export function strongPassword(length: number): string {
  const body = randomBytes(Math.ceil(length * 0.75) + 3).toString("base64url").replace(/[-_]/g, "x");
  return ("Aa7!" + body).slice(0, length);
}
/** Unique identifier fragment; long enough to be a plausible password if reused as one. */
export const uniqueValue = () => `veriq${randomBytes(8).toString("hex")}`;

function probes(c: Case): Probe[] {
  // The control is comfortably above minLength but short enough for common maximums (≥ 16).
  const list: Probe[] = [{ check: "control", password: () => strongPassword(Math.min(Math.max(c.minLength + 4, 16), 64)), expect: "accept" }];
  const common = (c.commonPasswords ?? DEFAULT_COMMON_PASSWORDS).filter(p => p.length >= c.minLength);
  for (const check of c.checks) {
    if (check === "length") list.push({ check, title: "Password shorter than the required minimum accepted", password: () => strongPassword(c.minLength - 1), expect: "reject", cwe: "CWE-521", severity: "medium" });
    if (check === "common") {
      // A common password shorter than minLength would test length again, not a blocklist.
      if (!common.length) throw new Error("No common-password candidate meets minLength; configure commonPasswords at least minLength long");
      for (const p of common) list.push({ check, title: "Well-known common password accepted", password: () => p, expect: "reject", cwe: "CWE-521", severity: "high" });
    }
    if (check === "identifier") {
      if (uniqueValue().length < c.minLength) throw new Error("The identifier check cannot meet minLength; remove it or lower minLength");
      list.push({ check, title: "Password equal to the account identifier accepted", password: unique => unique, expect: "reject", cwe: "CWE-521", severity: "medium" });
    }
    if (check === "long") list.push({ check, title: "Long passphrase (64 characters) rejected", password: () => strongPassword(64), expect: "accept", cwe: "CWE-521", severity: "low" });
  }
  return list;
}

function fill(body: Record<string, string>, password: string, unique: string) {
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v === PASSWORD ? password : v.replaceAll(UNIQUE, unique)]));
}

export async function checkPasswordPolicy(ctx: RunContext, c: Case, list: Probe[]): Promise<Finding[]> {
  const target = `${c.method} ${c.path}`;
  const findings: Finding[] = [];
  for (const probe of list) {
    const unique = uniqueValue();
    const res = await request(ctx, { method: c.method, path: c.path, account: c.account, json: fill(c.body, probe.password(unique), unique) });
    const label = probe.check === "control" ? "positive control" : `${probe.check} probe`;
    const accepted = c.acceptedStatuses.includes(res.status), rejected = c.rejectionStatuses.includes(res.status);
    if (probe.check === "control") {
      if (!accepted) throw new Error(`Password-policy ${label} was not accepted (HTTP ${res.status}); check the endpoint, body template and acceptedStatuses`);
      continue;
    }
    if (!accepted && !rejected) {
      // 3xx, 401/403/409/429, 5xx and anything unexpected leave the policy unknown.
      throw new Error(`Password-policy ${label} inconclusive (HTTP ${res.status})`);
    }
    if ((probe.expect === "reject" && accepted) || (probe.expect === "accept" && rejected)) {
      if (findings.some(f => f.title === probe.title)) continue;
      findings.push(issue("password-policy", probe.title!, target,
        probe.expect === "reject"
          ? "The server created an account with a password the configured policy should refuse. Password and identifier omitted."
          : "The server refused a strong 64-character password; long passphrases should be allowed.",
        probe.severity, "security", probe.cwe));
    }
  }
  return findings;
}

export const passwordPolicy = checkedPlugin("password-policy", "api", "Explicit disposable registration/user-create password-policy workflow with a strong-password positive control", passwordPolicySchema,
  async (ctx, config) => {
    disposable(ctx);
    // Preflight every case (accounts and probe sets) before creating any user.
    const prepared = config.cases.map(c => {
      if (c.account && !Object.hasOwn(ctx.config.accounts, c.account)) throw new Error("Password-policy case names an unknown QA account");
      return { c, list: probes(c) };
    });
    const findings: Finding[] = [];
    for (const { c, list } of prepared) findings.push(...await checkPasswordPolicy(ctx, c, list));
    return { findings, stats: { cases: prepared.length, submissions: prepared.reduce((n, p) => n + p.list.length, 0) } };
  }, ["baseUrl"]);
