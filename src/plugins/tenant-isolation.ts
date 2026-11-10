/**
 * Cross-tenant isolation (the most important check for a multi-tenant SaaS).
 *
 * For every detail route `GET /x/:id` that has a matching list route `GET /x`:
 *   1. owner lists /x and collects record ids
 *   2. owner opens /x/:id            → control, must succeed
 *   3. attacker opens /x/:id         → must NOT return the owner's record
 * With allowMutations, the attacker also tries PATCH /x/:id with an empty body.
 * Owner and attacker are two different merchant accounts (two tenants).
 */
import type { Finding, QaPlugin, RouteInfo } from "../core/types.js";
import { fillParams, snippet } from "../core/http.js";
import { extractIds, keyMatcher, routeKey, where } from "./util.js";

function pairs(routes: RouteInfo[], target: RouteInfo[], extra: Array<{ list: string; detail: string }>, known: Record<string, string>) {
  const byKey = new Map(routes.map((r) => [routeKey(r), r]));
  const out: Array<{ list: RouteInfo; detail: RouteInfo }> = [];
  for (const d of target) {
    if (d.method !== "GET") continue;
    const m = d.path.match(/^(.*)\/:([A-Za-z0-9_]+)$/);
    if (!m) continue;
    // The list path may contain params only if all of them have real values (target.pathParams)
    if ([...m[1].matchAll(/:([A-Za-z0-9_]+)/g)].some((x) => !(x[1] in known))) continue;
    const list = routes.find((r) => r.method === "GET" && r.path === m[1]);
    if (list) out.push({ list, detail: d });
  }
  for (const p of extra) {
    const list = byKey.get(p.list), detail = byKey.get(p.detail);
    if (list && detail && !out.some((o) => o.detail === detail)) out.push({ list, detail });
  }
  return out;
}

export const tenantIsolationPlugin: QaPlugin = {
  name: "tenant-isolation",
  layer: "api",
  description: "Merchant B must not read or edit merchant A's records",
  needs: ["baseUrl", "accounts"],
  skipReason(ctx) {
    const t = ctx.config.tenantIsolation;
    if (!ctx.config.accounts[t.owner] || !ctx.config.accounts[t.attacker]) return `needs both '${t.owner}' and '${t.attacker}' accounts`;
    return null;
  },
  async run(ctx) {
    const http = ctx.http!;
    const auth = ctx.auth!;
    const t = ctx.config.tenantIsolation;
    const shared = keyMatcher(t.sharedResources);
    const findings: Finding[] = [];
    const tally = { pairs: 0, sharedSkipped: 0, noData: 0, controlFailed: 0, checked: 0 };

    const ownerH = await auth.header(t.owner);
    const attackerH = await auth.header(t.attacker);
    if (!ownerH || !attackerH) {
      const who = !ownerH ? t.owner : t.attacker;
      return [{ plugin: this.name, severity: "high", category: "env", target: `login ${who}`, title: `QA account '${who}' could not log in: ${auth.loginError(who)}`, detail: "Tenant isolation was not tested." }];
    }

    for (const { list, detail } of pairs(ctx.routes, ctx.targetRoutes, t.pairs, ctx.config.target.pathParams)) {
      tally.pairs++;
      if (shared(routeKey(detail))) { tally.sharedSkipped++; continue; }
      const lres = await http.send({ method: "GET", path: fillParams(list.path, ctx.config.target.pathParams), headers: ownerH });
      const ids = lres.status < 300 ? extractIds(lres.json, t.maxIdsPerRoute) : [];
      if (!ids.length) { tally.noData++; continue; }
      const param = detail.path.match(/:([A-Za-z0-9_]+)$/)![1];

      for (const id of ids) {
        const p = fillParams(detail.path, { ...ctx.config.target.pathParams, [param]: id });
        const own = await http.send({ method: "GET", path: p, headers: ownerH });
        if (own.status >= 300 || !own.text.includes(id)) { tally.controlFailed++; continue; }
        tally.checked++;
        const req = { method: "GET", path: p, headers: attackerH, tokenLabel: t.attacker };
        const res = await http.send(req);
        const ev = { ...where(detail), url: res.url, status: res.status, curl: http.curl(req), responseSnippet: snippet(res.text) };
        if (res.status >= 200 && res.status < 300 && res.text.includes(id)) {
          findings.push({
            plugin: this.name, severity: "critical", category: "security", target: routeKey(detail),
            title: "Cross-tenant read: another merchant can open this record",
            detail: `${t.attacker} fetched ${t.owner}'s record ${id}. Scope the query by the caller's merchantId. If this resource is meant to be public, add "${routeKey(detail)}" to tenantIsolation.sharedResources.`,
            evidence: ev,
          });
          break; // one proof per route is enough
        } else if (res.status >= 500) {
          findings.push({ plugin: this.name, severity: "medium", category: "regression", target: routeKey(detail), title: `Server error ${res.status} when another tenant requests the record`, evidence: ev });
          break;
        }

        if (ctx.config.allowMutations && id === ids[0]) {
          const patch = ctx.routes.find((r) => r.method === "PATCH" && r.path === detail.path);
          if (patch) {
            const preq = { method: "PATCH", path: p, headers: attackerH, tokenLabel: t.attacker, json: {} };
            const pres = await http.send(preq);
            if (pres.status >= 200 && pres.status < 300) {
              findings.push({
                plugin: this.name, severity: "critical", category: "security", target: routeKey(patch),
                title: "Cross-tenant write: another merchant can update this record",
                evidence: { ...where(patch), url: pres.url, status: pres.status, curl: http.curl(preq), responseSnippet: snippet(pres.text) },
              });
            }
          }
        }
      }
    }
    return { findings, stats: tally };
  },
};
