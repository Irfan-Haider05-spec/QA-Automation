import { createHmac } from "node:crypto";
import { z } from "zod";
import { fillParams, getPath } from "../../core/http.js";
import { SkipError, type Finding, type QaPlugin } from "../../core/types.js";
import { activeCaseSchema, checkedPlugin, disposable, issue, localPath, request, requestSchema } from "./support.js";
import { refreshSessionSchema, testRefreshSession, validateRefreshSession } from "./session-lifecycle.js";
import { webhookStateSchema, verifyWebhookState } from "./webhook-state.js";

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const ok = (status: number) => status >= 200 && status < 300;
const cases = z.object({ cases: z.array(activeCaseSchema).min(1).max(100) }).strict();

export const authzMatrix = checkedPlugin("authz-matrix", "api", "Explicit role/route policies, including disposable write and mass-assignment cases", cases,
  async (ctx, config) => {
    // Preflight the complete set before sending even one request.
    if (config.cases.some((c) => c.method !== "GET")) disposable(ctx);
    const findings: Finding[] = [];
    for (const c of config.cases) {
      const res = await request(ctx, c);
      if (!c.expectedStatuses.includes(res.status)) findings.push(issue("authz-matrix", `Authorization policy mismatch as ${c.account ?? "anonymous"}`, key(c),
        `Expected ${c.expectedStatuses.join("/")}; got ${res.status}. Policy is explicit; a 404/422 is not treated as proof of authorization.`, "high", "security", "CWE-863"));
    }
    return { findings, stats: { checks: config.cases.length } };
  }, ["baseUrl"]);

export const dataExposure: QaPlugin = {
  name: "data-exposure", layer: "api", description: "Sensitive field names and credential values in successful API responses", needs: ["baseUrl"],
  async run(ctx) {
    const findings: Finding[] = []; let checks = 0;
    for (const r of ctx.targetRoutes.filter((r) => r.method === "GET")) {
      if ([...r.path.matchAll(/:([\w]+)/g)].some((m) => !ctx.config.target.pathParams[m[1]])) continue;
      const account = r.authRequired ? ctx.auth?.accountForRoles(r.roles) : undefined;
      if (r.authRequired && !account) continue;
      const res = await request(ctx, { method: "GET", path: fillParams(r.path, ctx.config.target.pathParams), account });
      if (!ok(res.status)) throw new Error(`Cannot inspect response fields: ${key(r)} returned ${res.status}`);
      checks++;
      const queue: Array<[unknown, string, number]> = [[res.json, "$", 0]];
      let inspected = 0;
      while (queue.length) {
        const [value, p, depth] = queue.shift()!;
        if (!value || typeof value !== "object") continue;
        if (++inspected > 10000 || depth > 30) throw new Error("Response exceeds inspection limits");
        for (const [name, child] of Object.entries(value)) {
          const field = `${p}.${Array.isArray(value) ? "[]" : name}`;
          if (/^(password(?:hash)?|passwd|secret|clientSecret|apiKey|accessToken|refreshToken|privateKey|resetToken|otp)$/i.test(name) && child != null && child !== "" && !/^\*+$|^\[redacted\]$/i.test(String(child))) {
            findings.push(issue(this.name, `Sensitive response field: ${name}`, key(r), `Non-empty field at ${field}. Value deliberately omitted.`, "high", "security", "CWE-200"));
          } else if (child && typeof child === "object") queue.push([child, field, depth + 1]);
        }
      }
    }
    if (!checks) throw new SkipError("No inspectable GET routes with configured parameters and accounts");
    return { findings, stats: { responses: checks } };
  },
};

const sessionSchema = z.object({ account: z.string(), protectedPath: localPath, logoutPath: localPath.optional(),
  weakSecrets: z.array(z.string().min(1).max(100)).max(5).default([]), jwtProbes: z.boolean().default(true), refresh: refreshSessionSchema.optional() }).strict()
  .refine(c => c.jwtProbes || (!!c.refresh && !c.logoutPath && !c.weakSecrets.length), "Without JWT probes configure refresh lifecycle and put logout settings inside refresh");
export const authSession = checkedPlugin("auth-session", "api", "Reject unsigned/expired/weak-secret JWTs and verify logout invalidation", sessionSchema,
  async (ctx, c) => {
    disposable(ctx); // logout invalidates the dedicated account; explicitly isolated runs only
    if (c.refresh) validateRefreshSession(ctx, c.account);
    if (!c.jwtProbes) return testRefreshSession(ctx, c.account, c.protectedPath, c.refresh!);
    const token = await ctx.auth!.token(c.account);
    if (!token) throw new Error("JWT account could not authenticate");
    const parts = token.split(".");
    if (parts.length !== 3) throw new SkipError("JWT-specific checks require a JWT bearer strategy");
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()); }
    catch { throw new Error("JWT payload is not valid JSON; token omitted"); }
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const original = await request(ctx, { method: "GET", path: c.protectedPath, account: c.account });
    if (!ok(original.status)) throw new Error("Session positive control did not return 2xx");
    const probes: Array<[string, string]> = [["Unsigned JWT accepted", `${encode({ alg: "none", typ: "JWT" })}.${parts[1]}.`]];
    // An expired token with an invalid signature proves nothing about expiry; only
    // test expiry with a discovered signing key that matches the original token.
    for (const secret of c.weakSecrets) {
      const signed = `${parts[0]}.${parts[1]}`;
      const signature = createHmac("sha256", secret).update(signed).digest("base64url");
      if (signature === parts[2]) {
        const expired = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ ...payload, exp: 1 })}`;
        probes.push(["Expired correctly signed JWT accepted", `${expired}.${createHmac("sha256", secret).update(expired).digest("base64url")}`]);
      }
    }
    const findings: Finding[] = [];
    for (const [title, value] of probes) {
      const res = await request(ctx, { method: "GET", path: c.protectedPath }, { headers: { authorization: `Bearer ${value}` } });
      if (ok(res.status)) findings.push(issue("auth-session", title, c.protectedPath, "A modified token accessed a route that passed the authenticated control.", "critical", "security", "CWE-347"));
      else if (![401, 403].includes(res.status)) throw new Error(`JWT rejection inconclusive (HTTP ${res.status})`);
    }
    if (probes.length > 1) findings.push(issue("auth-session", "JWT uses a configured weak signing secret", c.protectedPath, "A candidate secret reproduced the original signature; secret omitted.", "critical", "security", "CWE-321"));
    if (c.logoutPath) {
      const logout = await request(ctx, { method: "POST", path: c.logoutPath, account: c.account });
      if (!ok(logout.status)) throw new Error(`Logout failed (HTTP ${logout.status})`);
      const after = await request(ctx, { method: "GET", path: c.protectedPath }, { headers: { authorization: `Bearer ${token}` } });
      if (ok(after.status)) findings.push(issue("auth-session", "Access token still accepted after logout", c.protectedPath, "Review the documented revocation policy and access-token lifetime.", "medium", "security", "CWE-613"));
      else if (![401, 403].includes(after.status)) throw new Error("Logout check inconclusive");
    }
    if (c.refresh) findings.push(...await testRefreshSession(ctx, c.account, c.protectedPath, c.refresh));
    return findings;
  }, ["baseUrl", "accounts"]);

export const rateLimit = checkedPlugin("rate-limit", "api", "Bounded disposable-environment rate-limit probes with an explicit expected threshold",
  z.object({ cases: z.array(requestSchema).min(1).max(10), attempts: z.number().int().min(2).max(50), maxWindowMs: z.number().int().min(100).max(60000) }).strict(),
  async (ctx, c) => {
    disposable(ctx);
    if ((c.attempts - 1) * Math.ceil(60000 / ctx.config.target.requestsPerMinute) >= c.maxWindowMs) throw new Error("Configured request budget cannot exercise the limit inside maxWindowMs; no requests sent");
    const findings: Finding[] = [];
    for (const spec of c.cases) {
      const start = Date.now(); let limited = false;
      for (let i = 0; i < c.attempts; i++) {
        const res = await request(ctx, spec);
        if (Date.now() - start > c.maxWindowMs) throw new Error("Rate-limit probe exceeded its observation window");
        if (res.status === 429) { limited = true; break; }
        if (res.status >= 500) throw new Error("Rate-limit target returned a server error");
      }
      if (!limited) findings.push(issue("rate-limit", "Expected rate limit not observed", key(spec), `No 429 in ${c.attempts} configured probes. This does not prove absence of a higher threshold.`, "medium", "security", "CWE-770"));
    }
    return findings;
  }, ["baseUrl"]);

export const webhookSecurity = checkedPlugin("webhook-security", "api", "Reject missing, invalid and explicitly supplied stale webhook signatures",
  z.object({ cases: z.array(requestSchema.extend({ signatureHeader: z.string().regex(/^[a-z0-9-]+$/i).refine(v => !/^(host|content-length|transfer-encoding|connection|cookie)$/i.test(v), 'Unsafe signature header'), staleSignatureEnv: z.string().optional(), state: webhookStateSchema.optional() })).min(1).max(20) }).strict(),
  async (ctx, c) => {
    disposable(ctx); const findings: Finding[] = [];
    // Preflight every case before mutating any endpoint.
    const prepared = c.cases.map(spec => {
      if (spec.method !== "POST") throw new Error("Webhook checks require explicitly configured POST cases");
      if (spec.account && spec.signatureHeader.toLowerCase() === 'authorization') throw new Error('Webhook signature header conflicts with account authentication');
      const signature = (name: string) => { const v = process.env[name]; if (!v || v.length > 8192 || /[\r\n]/.test(v)) throw new Error('Webhook signature environment variable missing or invalid'); return v; };
      const variants: Array<[string, string | undefined]> = [["missing", undefined], ["invalid", "veriq-invalid-signature"]];
      if (spec.staleSignatureEnv) variants.push(['stale', signature(spec.staleSignatureEnv)]);
      const valid = spec.state ? signature(spec.state.validSignatureEnv) : undefined;
      if (valid && variants.some(([, v]) => v === valid)) throw new Error('Valid and invalid/stale signature controls must differ');
      return { spec, variants, valid };
    });
    for (const { spec, variants, valid } of prepared) {
      if (spec.state) { findings.push(...await verifyWebhookState(ctx, spec, spec.state, variants, valid!)); continue; }
      for (const [label, value] of variants) {
        const res = await request(ctx, spec, { headers: value ? { [spec.signatureHeader]: value } : {} });
        if (ok(res.status)) findings.push(issue("webhook-security", `Webhook accepted ${label} signature`, spec.path, "Confirm that the payload was not processed; acknowledge-and-ignore handlers need an application-specific state assertion.", "high", "security", "CWE-345"));
        else if (![400, 401, 403].includes(res.status)) throw new Error(`Webhook rejection inconclusive (HTTP ${res.status})`);
      }
    }
    return findings;
  }, ["baseUrl"]);

export const raceConditions = checkedPlugin("race-conditions", "api", "Concurrent disposable writes with a server-state invariant",
  z.object({ request: requestSchema, concurrency: z.number().int().min(2).max(10), verify: requestSchema,
    valuePath: z.string().min(1), expectedValue: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
  async (ctx, c) => {
    disposable(ctx);
    if (c.request.method === "GET" || c.verify.method !== "GET") throw new Error("Race check requires a write and a read-only verification request");
    // Shared throttling is deliberately retained. Report timing so users can see
    // whether the target's processing overlapped; never promise a race was forced.
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: c.concurrency }, () => request(ctx, c.request)));
    if (results.some((r) => r.status >= 500)) throw new Error("Race probe returned server errors; state may need cleanup");
    const verify = await request(ctx, c.verify);
    if (!ok(verify.status)) throw new Error("Race invariant could not be read");
    const actual = getPath(verify.json, c.valuePath);
    if (actual === undefined) throw new Error("Race verification valuePath does not exist");
    return { findings: actual === c.expectedValue ? [] : [issue("race-conditions", "Concurrent write invariant violated", key(c.request), "Observed state differs from the explicitly configured invariant. Response values omitted.", "critical", "security", "CWE-362")], stats: { requests: results.length, windowMs: Date.now() - started } };
  }, ["baseUrl"]);

export const fileUpload = checkedPlugin("file-upload", "api", "Disposable multipart uploads of invalid types, traversal names and oversized content",
  z.object({ path: localPath, account: z.string(), field: z.string().min(1), maxAcceptedBytes: z.number().int().min(1).max(1024 * 1024),
    expectedStatuses: z.array(z.number().int().min(400).max(499)).min(1).default([400, 413, 415, 422]) }).strict(),
  async (ctx, c) => {
    disposable(ctx); const findings: Finding[] = [];
    for (const [label, filename, content, type] of [
      ["script", "veriq-probe.html", "<script>/* inert VeriQ upload probe */</script>", "text/html"],
      ["traversal", "../veriq-probe.txt", "VeriQ probe", "text/plain"],
      ["oversized", "veriq-probe.txt", "x".repeat(c.maxAcceptedBytes + 1), "text/plain"],
    ]) {
      const form = new FormData(); form.append(c.field, new Blob([content], { type }), filename);
      const res = await request(ctx, { method: "POST", path: c.path, account: c.account }, { body: form });
      if (!c.expectedStatuses.includes(res.status)) findings.push(issue("file-upload", `Upload policy mismatch: ${label}`, c.path,
        `Expected rejection ${c.expectedStatuses.join("/")}; got ${res.status}. Acceptance alone does not prove executable storage or traversal.`, "medium", "security", "CWE-434"));
    }
    return findings;
  }, ["baseUrl", "accounts"]);

export const graphql = checkedPlugin("graphql", "api", "GraphQL introspection policy and explicit role/cost rejection cases",
  z.object({ path: localPath, forbidIntrospection: z.boolean().default(true), cases: z.array(z.object({ query: z.string().min(1).max(10000), account: z.string().optional(), shouldReject: z.boolean() })).max(20).default([]) }).strict(),
  async (ctx, c) => {
    disposable(ctx); // untrusted query documents may contain mutations
    const findings: Finding[] = [];
    const probes = [...(c.forbidIntrospection ? [{ query: "query { __schema { queryType { name } } }", shouldReject: true, account: undefined }] : []), ...c.cases];
    if (!probes.length) throw new SkipError("No GraphQL probes configured");
    for (const [i, probe] of probes.entries()) {
      const res = await request(ctx, { method: "POST", path: c.path, account: probe.account, json: { query: probe.query } });
      if (res.status >= 500 || res.status === 429 || res.status === 404) throw new Error(`GraphQL probe inconclusive (HTTP ${res.status})`);
      const dataPresent = res.json?.data && Object.values(res.json.data).some((v) => v !== null);
      const accepted = ok(res.status) && !!dataPresent;
      if (accepted === probe.shouldReject) findings.push(issue("graphql", `GraphQL policy mismatch in case ${i + 1}`, c.path, `Expected ${probe.shouldReject ? "rejection" : "data"}. Partial data with errors still counts as data exposure.`, "high", "security", "CWE-863"));
    }
    return findings;
  }, ["baseUrl"]);
