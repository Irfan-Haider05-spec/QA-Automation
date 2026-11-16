/**
 * Smoke test: call every GET route whose path params are known (none, or all set in
 * target.pathParams) with an account
 * whose role is allowed. Fails on 5xx, flags slow responses and broken
 * response envelopes. 4xx is accepted (a route may need query params).
 */
import type { Finding, QaPlugin } from "../core/types.js";
import { snippet } from "../core/http.js";
import { routeKey, where, isNotMountedResponse } from "./util.js";
import { fillParams } from "../core/http.js";

export const apiSmokePlugin: QaPlugin = {
  name: "api-smoke",
  layer: "api",
  description: "GET every parameter-free route with the right role: no 5xx, not slow",
  needs: ["baseUrl"],
  async confirm(ctx, finding) {
    const route = ctx.targetRoutes.find((r) => routeKey(r) === finding.target && r.method === "GET");
    if (!route || !/^(Server error|No response|Slow response)/.test(finding.title)) return "inconclusive";
    const account = route.authRequired ? ctx.auth!.accountForRoles(route.roles) : undefined;
    const headers = account ? await ctx.auth!.header(account) : undefined;
    if (route.authRequired && !headers) return "inconclusive";
    const res = await ctx.http!.send({ method: "GET", path: fillParams(route.path, ctx.config.target.pathParams), headers, retry: false });
    if (res.networkError || res.status >= 500) return "confirmed";
    if (res.status < 200 || res.status >= 300 || res.json?.success === false) return "inconclusive";
    if (finding.title.startsWith("Slow response") && res.ms > ctx.config.target.slowMs) return "confirmed";
    return "cleared";
  },
  async run(ctx) {
    const http = ctx.http!;
    const auth = ctx.auth!;
    const findings: Finding[] = [];
    const tally = { ok2xx: 0, client4xx: 0, server5xx: 0, skippedNoAccount: 0, slow: 0 };

    for (const r of ctx.targetRoutes) {
      if (r.method !== "GET") continue;
      // Only routes whose every :param has a real value configured in target.pathParams
      const params = [...r.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      if (params.some((n) => !(n in ctx.config.target.pathParams))) continue;
      const path = fillParams(r.path, ctx.config.target.pathParams);
      let headers: Record<string, string> | undefined;
      let label: string | undefined;
      if (r.authRequired) {
        label = auth.accountForRoles(r.roles);
        headers = label ? await auth.header(label) : undefined;
        if (!headers) { tally.skippedNoAccount++; continue; }
      }
      const req = { method: "GET", path, headers, tokenLabel: label };
      const res = await http.send(req);
      if (isNotMountedResponse(res.status, res.text)) continue;
      const ev = { ...where(r), url: res.url, status: res.status, curl: http.curl(req), responseSnippet: snippet(res.text) };
      if (res.networkError) {
        findings.push({ plugin: this.name, severity: "high", category: "regression", target: routeKey(r), title: `No response: ${res.networkError}`, evidence: ev });
        continue;
      }
      if (res.status >= 500) {
        tally.server5xx++;
        findings.push({ plugin: this.name, severity: "high", category: "regression", target: routeKey(r), title: `Server error ${res.status}${label ? ` as ${auth.account(label).role}` : ""}`, detail: res.json?.message, evidence: ev });
        continue;
      }
      if (res.status >= 400) { tally.client4xx++; continue; }
      tally.ok2xx++;
      if (res.ms > ctx.config.target.slowMs) {
        tally.slow++;
        findings.push({ plugin: this.name, severity: "medium", category: "performance", target: routeKey(r), title: `Slow response: ${res.ms} ms (limit ${ctx.config.target.slowMs} ms)`, evidence: ev });
      }
      const ctype = res.headers.get("content-type") ?? "";
      if (ctype.includes("json") && res.json && res.json.success === false) {
        findings.push({ plugin: this.name, severity: "low", category: "quality", target: routeKey(r), title: "2xx response with success: false", evidence: ev });
      }
    }
    return { findings, stats: tally };
  },
};
