/**
 * The project profile: the route list discovered from source plus the
 * non-secret parts of the config. CI runs upload it with --upload; the
 * platform's hosted runner uses the latest one to test deployed environments
 * without the source code.
 *
 * Never included: account identifiers or passwords, base URLs, file contents.
 */
import type { QaConfig } from "./config.js";
import type { RouteInfo } from "./types.js";

export function buildProfile(config: QaConfig, routes: RouteInfo[]) {
  return {
    version: 1 as const,
    apiPrefix: config.backend.apiPrefix,
    healthPath: config.backend.healthPath,
    login: { path: config.login.path, tokenPath: config.login.tokenPath, ...(config.login.bodyTemplate ? { bodyTemplate: config.login.bodyTemplate } : {}) },
    accounts: Object.fromEntries(Object.entries(config.accounts).map(([name, a]) => [name, { role: a.role, ...(a.device ? { device: a.device } : {}) }])),
    publicRoutes: config.publicRoutes,
    privilegedPrefixes: config.privilegedPrefixes,
    tenantIsolation: config.tenantIsolation,
    cors: config.cors,
    pathParams: config.target.pathParams ?? {},
    gateFailOn: config.gate.failOn,
    web: {
      slowMs: config.web.slowMs,
      ignoreConsole: config.web.ignoreConsole,
      apps: config.web.apps.map((a) => ({
        name: a.name, loginPath: a.loginPath, account: a.account, seedRoutes: a.seedRoutes, excludePaths: a.excludePaths, maxPages: a.maxPages,
        ...(a.selectors ? { selectors: a.selectors } : {}),
      })),
    },
    // Source locations stay behind: only what's needed to call the routes
    routes: routes.map((r) => ({ method: r.method, path: r.path, apiPath: r.apiPath, module: r.module, authRequired: r.authRequired, roles: r.roles, multipart: r.multipart, middlewares: r.middlewares })),
  };
}
export type ProjectProfile = ReturnType<typeof buildProfile>;

/** Routes from a profile, in the engine's RouteInfo shape (source fields blank) */
export function routesFromProfile(routes: ProjectProfile["routes"]): RouteInfo[] {
  return routes.map((r, i) => ({ ...r, source: { file: "", line: 0 }, order: i, routerFile: "" }));
}
