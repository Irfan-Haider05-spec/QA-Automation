/**
 * Static route audit (no network):
 *  - routes without auth() that are not on the public allowlist
 *  - privileged routes that only check "logged in", not a role
 *  - routes with no handler (requests hang until the client times out)
 *  - routes shadowed by an earlier "/:param" route, and duplicate routes
 */
import type { Finding, QaPlugin, RouteInfo } from "../core/types.js";
import { keyMatcher, routeKey, where } from "./util.js";

const segs = (p: string) => p.split("/").filter(Boolean);

/** true if pattern `a` (declared earlier) also matches every request meant for `b` */
function shadows(a: string, b: string) {
  const sa = segs(a), sb = segs(b);
  if (sa.length !== sb.length) return false;
  let differs = false;
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] === sb[i]) continue;
    if (sa[i].startsWith(":") && !sb[i].startsWith(":")) { differs = true; continue; }
    return false;
  }
  return differs;
}

export const routeAuthPlugin: QaPlugin = {
  name: "route-auth",
  layer: "static",
  description: "Static audit of auth, roles, missing handlers and route shadowing",
  async run(ctx) {
    const findings: Finding[] = [];
    const isPublic = keyMatcher(ctx.config.publicRoutes);
    const isPrivileged = keyMatcher(ctx.config.privilegedPrefixes.map((p) => `* ${p.replace(/\/$/, "")}{,/**}`));
    const routes = ctx.targetRoutes;

    for (const r of routes) {
      const key = routeKey(r);
      const handlerCount = r.middlewares.length;
      if (handlerCount === 0) {
        findings.push({
          plugin: this.name, severity: "medium", category: "quality", target: key,
          title: "Route is registered without any handler",
          detail: "Express registers nothing for it, so requests fall through to the 404 handler. Either an unfinished endpoint or dead code: finish it or delete it.",
          evidence: where(r),
        });
        continue;
      }
      if (!r.authRequired && !isPublic(key)) {
        const adminLike = /admin|role|permission|super/i.test(r.apiPath) || isPrivileged(key);
        const dataExport = /export|download|report/i.test(r.apiPath);
        const severity = adminLike ? "critical" : r.method !== "GET" || dataExport ? "high" : "medium";
        findings.push({
          plugin: this.name, severity, category: "security", target: key,
          title: adminLike ? "Privileged route has no auth middleware" : dataExport ? "Data export route has no auth middleware" : "Route has no auth middleware and is not on the public allowlist",
          detail: "Add auth(...roles) to the route, or add it to publicRoutes in qa.config.ts if it is meant to be public.",
          evidence: where(r),
        });
      }
      if (r.authRequired && r.roles.length === 0 && isPrivileged(key)) {
        findings.push({
          plugin: this.name, severity: "medium", category: "security", target: key,
          title: "Privileged route checks login but not role",
          detail: "auth() is called without roles, so any logged-in customer passes the middleware. Confirm the controller checks the role, or pass roles to auth().",
          evidence: where(r),
        });
      }
      const unresolved = r.roles.filter((x) => x.startsWith("?"));
      if (unresolved.length) {
        findings.push({
          plugin: this.name, severity: "info", category: "quality", target: key,
          title: "Roles passed to auth() could not be resolved statically",
          detail: `Unresolved: ${unresolved.join(", ")}`, evidence: where(r),
        });
      }
    }

    // Shadowing and duplicates are checked per router file, in declaration order
    const byRouter = new Map<string, RouteInfo[]>();
    for (const r of ctx.routes) {
      const k = `${r.routerFile}|${r.method}`;
      if (!byRouter.has(k)) byRouter.set(k, []);
      byRouter.get(k)!.push(r);
    }
    const selected = new Set(routes.map(routeKey));
    for (const list of byRouter.values()) {
      list.sort((a, b) => a.order - b.order);
      for (let j = 0; j < list.length; j++) {
        const later = list[j];
        if (!selected.has(routeKey(later))) continue;
        for (let i = 0; i < j; i++) {
          const earlier = list[i];
          if (earlier.path === later.path) {
            findings.push({
              plugin: this.name, severity: "medium", category: "regression", target: routeKey(later),
              title: "Duplicate route: an earlier identical route handles every request",
              detail: `First defined at ${earlier.source.file}:${earlier.source.line}. The later definition never runs unless the first calls next().`,
              evidence: where(later),
            });
            break;
          }
          if (shadows(earlier.path, later.path)) {
            findings.push({
              plugin: this.name, severity: "high", category: "regression", target: routeKey(later),
              title: "Route is unreachable: shadowed by an earlier parameter route",
              detail: `${earlier.method} ${earlier.apiPath} (${earlier.source.file}:${earlier.source.line}) is declared first and matches this path. Move the specific route above the parameter route.`,
              evidence: where(later),
            });
            break;
          }
        }
      }
    }
    return { findings, stats: { routesAudited: routes.length, publicAllowlisted: routes.filter((r) => !r.authRequired && isPublic(routeKey(r))).length } };
  },
};
