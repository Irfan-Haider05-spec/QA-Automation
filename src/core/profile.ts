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
import { HostedSettingsSchema } from "@qa/shared";

export function buildProfile(config: QaConfig, routes: RouteInfo[]) {
  const authUnsupported = config.login.otp || ["oauth2", "custom"].includes(config.login.strategy ?? "")
    ? "This profile uses OTP, OAuth client credentials or custom login code. Run it in your own CI runner; hosted login requires bearer, cookie or API-key credentials." : undefined;
  const settings = Object.fromEntries(Object.entries(config.pluginSettings ?? {}).filter(([name]) => Object.hasOwn(HostedSettingsSchema.shape, name)));
  const parsedSettings = HostedSettingsSchema.safeParse(settings);
  const settingsUnsupported = parsedSettings.success ? undefined : "This profile has plugin settings that cannot be safely represented by hosted runners. Run it in your own CI runner.";
  const template = config.login.bodyTemplate;
  const sensitiveField = /(password|secret|token|api[-_]?key|credential)/i;
  const placeholders = /^\{\{(?:identifier|password|token|accessToken|apiKey)\}\}$/;
  const accountValues = Object.values(config.accounts).flatMap((a) => [a.identifier, a.password, a.accessToken, a.apiKey]).filter((value): value is string => !!value && value.length >= 3);
  const unsafeTemplate = !!template && Object.entries(template).some(([key, value]) =>
    (sensitiveField.test(key) && !placeholders.test(value)) || accountValues.some((secret) => value.includes(secret)));
  const templateUnsupported = unsafeTemplate ? "The login body template contains a literal credential. Use credential placeholders; hosted login is unavailable until it is safe." : undefined;
  const unsupported = authUnsupported ?? settingsUnsupported ?? templateUnsupported;
  return {
    version: 1 as const,
    apiPrefix: config.backend.apiPrefix,
    healthPath: config.backend.healthPath,
    login: { path: config.login.path, tokenPath: config.login.tokenPath, ...(!templateUnsupported && template ? { bodyTemplate: template } : {}),
      ...(!unsupported ? { strategy: config.login.strategy as "bearer" | "cookie" | "api-key" | undefined, headerName: config.login.headerName, cookieNames: config.login.cookieNames } : {}) },
    hostedUnsupportedReason: unsupported,
    hostedSettings: parsedSettings.success ? parsedSettings.data : {},
    accounts: Object.fromEntries(Object.entries(config.accounts).map(([name, a]) => [name, { role: a.role, ...(a.device ? { device: a.device } : {}), credentialType: (a.apiKey ? "api-key" : a.accessToken ? "access-token" : "password") as "api-key" | "access-token" | "password" }])),
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
