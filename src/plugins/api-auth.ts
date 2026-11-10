/**
 * Live auth enforcement:
 *  1. Every protected route rejects requests with no token and with a bad token.
 *  2. Role-restricted routes reject an account whose role is not allowed.
 *  3. Unprotected GET routes not on the allowlist are confirmed reachable.
 * Path params are filled with a non-existent ObjectId, so even a broken route
 * cannot touch real records. Mutating requests are only sent with a token
 * when allowMutations is on (throwaway CI database).
 */
import type { Finding, QaPlugin, RouteInfo } from "../core/types.js";
import { fillParams, snippet } from "../core/http.js";
import { isNotMountedResponse, keyMatcher, routeKey, where } from "./util.js";

export const apiAuthPlugin: QaPlugin = {
  name: "api-auth",
  layer: "api",
  description: "401 without token, 403 for wrong role, live check of unprotected routes",
  needs: ["baseUrl"],
  async run(ctx) {
    const http = ctx.http!;
    const auth = ctx.auth!;
    const findings: Finding[] = [];
    const notMounted: string[] = [];
    const isPublic = keyMatcher(ctx.config.publicRoutes);
    let checks = 0;

    const report = (r: RouteInfo, req: Parameters<typeof http.send>[0], res: Awaited<ReturnType<typeof http.send>>, f: Omit<Finding, "plugin" | "target" | "evidence">) =>
      findings.push({ plugin: this.name, target: routeKey(r), ...f, evidence: { ...where(r), url: res.url, status: res.status, curl: http.curl(req), responseSnippet: snippet(res.text) } });

    for (const r of ctx.targetRoutes) {
      if (r.module === "app") continue;
      const key = routeKey(r);
      const p = fillParams(r.path, ctx.config.target.pathParams);

      if (!r.authRequired) {
        if (isPublic(key) || r.method !== "GET") continue; // never fire unauthenticated writes at a live system
        const req = { method: r.method, path: p };
        const res = await http.send(req); checks++;
        if (res.status >= 200 && res.status < 300) {
          report(r, req, res, { severity: /export|admin|report/i.test(r.apiPath) ? "critical" : "high", category: "security", title: "Confirmed live: route answers without any token" });
        }
        continue;
      }

      // 1a. No token
      const req1 = { method: r.method, path: p, json: r.method === "GET" ? undefined : {} };
      const res1 = await http.send(req1); checks++;
      if (isNotMountedResponse(res1.status, res1.text)) { notMounted.push(key); continue; }
      if (res1.networkError) {
        report(r, req1, res1, { severity: "medium", category: "env", title: `Request failed without response: ${res1.networkError}` });
        continue;
      }
      if (res1.status >= 200 && res1.status < 300) report(r, req1, res1, { severity: "critical", category: "security", title: "Auth bypass: protected route answered 2xx without a token" });
      else if (res1.status >= 500) report(r, req1, res1, { severity: "high", category: "regression", title: `Server error (${res1.status}) on an unauthenticated request` });
      else if (res1.status !== 401 && res1.status !== 403) report(r, req1, res1, { severity: "low", category: "quality", title: `Expected 401 without a token, got ${res1.status}`, detail: "Usually validateRequest runs before auth(). Put auth() first so anonymous callers learn nothing about the payload." });

      // 1b. Malformed token (GET only, enough to exercise JWT verification)
      if (r.method === "GET") {
        const req2 = { method: r.method, path: p, headers: { authorization: "Bearer qa.invalid.token" }, tokenLabel: "invalid" };
        const res2 = await http.send(req2); checks++;
        if (res2.status >= 200 && res2.status < 300) report(r, req2, res2, { severity: "critical", category: "security", title: "Auth bypass: route accepts a malformed JWT" });
        else if (res2.status >= 500) report(r, req2, res2, { severity: "high", category: "regression", title: `Server error (${res2.status}) on a malformed token` });
      }

      // 2. Wrong role
      if (r.roles.length && (r.method === "GET" || ctx.config.allowMutations)) {
        const outsider = auth.accountOutsideRoles(r.roles);
        const headers = outsider ? await auth.header(outsider) : undefined;
        if (outsider && headers) {
          const req3 = { method: r.method, path: p, headers, tokenLabel: outsider, json: r.method === "GET" ? undefined : {} };
          const res3 = await http.send(req3); checks++;
          if (res3.status >= 200 && res3.status < 300) report(r, req3, res3, { severity: "critical", category: "security", title: `Role bypass: ${auth.account(outsider).role} account got 2xx on a route limited to ${r.roles.join(", ")}` });
          else if (res3.status >= 500) report(r, req3, res3, { severity: "high", category: "regression", title: `Server error (${res3.status}) for a disallowed role` });
          // 401 vs 403 only matters when the arguments are user roles of this app (some account has one).
          // Otherwise they're scopes or a different credential type (e.g. authApiKey("runs:write")),
          // and refusing a user login with 401 is right.
          else if (res3.status !== 403 && auth.accountNames.some((n) => r.roles.includes(auth.account(n).role)))
            report(r, req3, res3, { severity: "low", category: "quality", title: `Expected 403 for role ${auth.account(outsider).role}, got ${res3.status}` });
        }
      }
    }

    if (notMounted.length) {
      findings.push({
        plugin: this.name, severity: "info", category: "env", target: "route inventory",
        title: `${notMounted.length} route(s) in source are not deployed on the target`,
        detail: `The target answers "API DOESN'T EXIST" for: ${notMounted.slice(0, 25).join(", ")}${notMounted.length > 25 ? " …" : ""}. The environment may be running an older build.`,
      });
    }
    const loginErrors = auth.accountNames.map((n) => (auth.loginError(n) ? `${n}: ${auth.loginError(n)}` : "")).filter(Boolean);
    for (const e of loginErrors) findings.push({ plugin: this.name, severity: "high", category: "env", target: `login ${e.split(":")[0]}`, title: `QA account could not log in (${e})`, detail: "Role checks for this account were skipped." });
    return { findings, stats: { checks, routes: ctx.targetRoutes.length, notMounted: notMounted.length } };
  },
};
