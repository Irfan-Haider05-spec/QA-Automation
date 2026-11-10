import { mergeAccounts, type PlatformAccount } from "./upload.js";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { Severity, Suite } from "./types.js";

export interface AccountConfig {
  /** Email or phone used on POST /auth/login */
  identifier?: string;
  password?: string;
  /** Role the account has in the backend (USER, MERCHANT, ADMIN, ...) */
  role: string;
  /** "device" field the login endpoint expects: merchant | admin | user */
  device: string;
}

export interface WebAppConfig {
  /** Short name used in findings, e.g. "admin" or "business" */
  name: string;
  baseUrl?: string;
  /** Login page path, e.g. "/login" */
  loginPath: string;
  /** Account key from `accounts` used to log in */
  account: string;
  /** CSS selectors for the login form; leave empty to auto-detect email/password/submit */
  selectors?: { identifier?: string; password?: string; submit?: string };
  /** Pages to start crawling from, e.g. ["/", "/dashboard"] */
  seedRoutes: string[];
  /** Dashboard repo checkout: static route paths found there are added to the crawl */
  sourceDir?: string;
  /** Glob patterns of paths never visited (logout, destructive pages) */
  excludePaths: string[];
  maxPages: number;
}

export interface SocketTrigger { account?: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown; event: string }

export interface SocketConfig {
  /** Socket.IO server URL of every backend instance. Default: [target.baseUrl] */
  urls: string[];
  /** Socket.IO path on the server */
  path: string;
  /** Where the server reads the token: handshake auth, a request header, or the query string */
  tokenIn: "auth" | "header" | "query";
  /** Name of the token field / header / query parameter */
  tokenKey: string;
  /** Account key from `accounts` that connects */
  account: string;
  connectTimeoutMs: number;
  /** How long a connection must stay open to count as accepted */
  settleMs: number;
  eventTimeoutMs: number;
  /** Events the server sends before refusing a connection */
  authErrorEvents: string[];
  /**
   * Requests that make the server emit an event to the account (`event` may be a glob, e.g. "salesActivation::*").
   * Each is checked for fan-out across instances and for leaking to `attacker`. Non-GET runs only with allowMutations.
   */
  triggers: SocketTrigger[];
  /** Second account that must not receive the account's events. Default: tenantIsolation.attacker */
  attacker?: string;
  /** The server's per-user connection cap, if it has one */
  maxConnectionsPerUser?: number;
}

export interface QaConfig {
  project: string;
  backend: {
    /** Path to the backend repo checkout (static plugins + route discovery) */
    dir: string;
    /** File that mounts all module routers */
    routesIndex: string;
    /** Main express app file (for app-level routes such as /health) */
    appFile?: string;
    /** Prefix where the routes index is mounted */
    apiPrefix: string;
    healthPath: string;
    envExample: string;
    /** Folder that holds each module, used to map changed files to routes */
    modulesDir: string;
    /** No backend source to read (dashboard-only or mobile-only projects): set by `backend: false` */
    none?: boolean;
  };
  target: {
    baseUrl?: string;
    /** Max requests per minute the agent sends (backend limiter is 120/min/IP) */
    requestsPerMinute: number;
    timeoutMs: number;
    slowMs: number;
    /** Real values for route params (e.g. { orgId: "…" }); unknown params get a non-existent id */
    pathParams: Record<string, string>;
  };
  login: {
    path: string;
    /** Dot path to the access token in the login response */
    tokenPath: string;
    /**
     * JSON body sent to the login endpoint. Placeholders {{identifier}}, {{password}}
     * and {{device}} are replaced per account. Default: { identifier, password, device }.
     */
    bodyTemplate?: Record<string, string>;
  };
  accounts: Record<string, AccountConfig>;
  /** Routes that are meant to be callable without a token, as "METHOD /apiPath" (":param" style) */
  publicRoutes: string[];
  /** Route prefixes that should always declare explicit roles */
  privilegedPrefixes: string[];
  tenantIsolation: {
    owner: string;
    attacker: string;
    /** Detail routes that are intentionally visible across tenants, e.g. "GET /promo-merchant/:id" */
    sharedResources: string[];
    /** Extra list → detail pairs the auto-matcher can't infer */
    pairs: Array<{ list: string; detail: string }>;
    maxIdsPerRoute: number;
  };
  cors: { allowedOrigins: string[]; probeOrigin: string };
  /** Files that affect every route; a change here selects all routes */
  globalPaths: string[];
  secrets: { ignorePaths: string[] };
  envDrift: { ignoreKeys: string[] };
  fuzz: { maxExamples: number; account: string };
  suites: Record<Suite, string[]>;
  gate: { failOn: Severity };
  /** Allow plugins to send POST/PATCH/DELETE with real tokens. Only true on throwaway databases. */
  allowMutations: boolean;
  knownIssuesFile: string;
  /** Maestro mobile flows (mobile) */
  mobile: {
    /** Folder of Maestro YAML flows, relative to the config */
    flowsDir: string;
    maestroPath: string;
    /** App id passed to the flows as ${APP_ID} */
    appId?: string;
    /** Device/emulator id (maestro --device); default: the only connected one */
    device?: string;
    /** Variables for the flows; "{{account.identifier}}" / "{{account.password}}" are filled from accounts */
    env: Record<string, string>;
    includeTags: string[];
    excludeTags: string[];
    timeoutMin: number;
    /** Report flows slower than this (seconds); 0 = off */
    maxSeconds: number;
    severity: Severity;
  };
  /** Business flows (flows): one file per flow in `dir`, relative to the config */
  flows: { dir: string; timeoutMs: number; stepTimeoutMs: number; maxMs: number; severity: Severity };
  /** Lighthouse on dashboard pages (lighthouse) */
  lighthouse: {
    /** Pages per dashboard name, e.g. { admin: ["/", "/merchants"] }. Default: the app's seedRoutes */
    pages: Record<string, string[]>;
    maxPages: number;
    formFactor: "desktop" | "mobile";
    thresholds: { performance: number; bestPractices: number; lcpMs: number; tbtMs: number; cls: number };
  };
  /** Passive security scan (zap-baseline) */
  zap: {
    /** auto: OWASP ZAP if installed, built-in rules otherwise */
    engine: "auto" | "zap" | "builtin";
    /** Run ZAP through Docker (image below) instead of a local zap-baseline.py */
    docker: boolean;
    image: string;
    spiderMinutes: number;
    /** More URLs to scan besides the API and the dashboards */
    extraTargets: string[];
    /** ZAP rule ids or alert titles to ignore */
    ignore: string[];
    /** Folders checked for directory listings (built-in rules) */
    listingPaths: string[];
  };
  /** Load smoke (load-smoke): GET only, capped at maxRps in total */
  load: {
    /** "GET /path" keys to load; empty = parameter-free GET routes (up to maxRoutes) */
    routes: string[];
    maxRoutes: number;
    /** Concurrent clients */
    vus: number;
    durationSec: number;
    /** Seconds to ramp from 1 request/s to maxRps */
    rampSec: number;
    /** Hard cap on requests per second, all clients together */
    maxRps: number;
    /** Account preferred for authenticated routes (falls back to any account with an allowed role) */
    account?: string;
    thresholds: { p95Ms: number; errorRate: number; slowdownFactor: number };
  };
  /** Realtime checks (socket-fanout). Leave unset if the backend has no Socket.IO. */
  socket?: SocketConfig;
  web: {
    apps: WebAppConfig[];
    /** Page load time above which a page is reported as slow */
    slowMs: number;
    /** Regexes for console errors to ignore (third-party noise) */
    ignoreConsole: string[];
    viewport: { width: number; height: number };
    visual: { baselineDir: string; maxDiffRatio: number; mask: string[] };
  };
}

export type UserConfig = Partial<Omit<QaConfig, "backend" | "target" | "login" | "tenantIsolation" | "cors" | "fuzz" | "gate" | "web" | "socket" | "load" | "zap" | "lighthouse" | "flows" | "mobile">> & {
  mobile?: Partial<QaConfig["mobile"]>;
  flows?: Partial<QaConfig["flows"]>;
  lighthouse?: Partial<Omit<QaConfig["lighthouse"], "thresholds">> & { thresholds?: Partial<QaConfig["lighthouse"]["thresholds"]> };
  zap?: Partial<QaConfig["zap"]>;
  load?: Partial<Omit<QaConfig["load"], "thresholds">> & { thresholds?: Partial<QaConfig["load"]["thresholds"]> };
  socket?: Partial<SocketConfig> & { /** shorthand for one trigger */ trigger?: SocketTrigger };
  web?: Partial<Omit<QaConfig["web"], "apps" | "visual">> & { apps?: Array<Partial<WebAppConfig> & Pick<WebAppConfig, "name" | "account">>; visual?: Partial<QaConfig["web"]["visual"]> };
  /** false: no backend source (dashboard- or app-only project) */
  backend?: Partial<QaConfig["backend"]> | false;
  target?: Partial<QaConfig["target"]>;
  login?: Partial<QaConfig["login"]>;
  tenantIsolation?: Partial<QaConfig["tenantIsolation"]>;
  cors?: Partial<QaConfig["cors"]>;
  fuzz?: Partial<QaConfig["fuzz"]>;
  gate?: Partial<QaConfig["gate"]>;
};

export const defineConfig = (c: UserConfig) => c;

const DEFAULTS: QaConfig = {
  project: "backend",
  backend: {
    dir: "../backend",
    routesIndex: "src/app/routes/index.ts",
    appFile: "src/app.ts",
    apiPrefix: "/api/v1",
    healthPath: "/health",
    envExample: ".env.example",
    modulesDir: "src/app/modules",
  },
  target: { requestsPerMinute: 90, timeoutMs: 15000, slowMs: 2000, pathParams: {} },
  login: { path: "/api/v1/auth/login", tokenPath: "data.accessToken" },
  accounts: {},
  publicRoutes: [],
  privilegedPrefixes: [],
  tenantIsolation: { owner: "merchantA", attacker: "merchantB", sharedResources: [], pairs: [], maxIdsPerRoute: 3 },
  cors: { allowedOrigins: [], probeOrigin: "https://qa-evil-origin.example" },
  globalPaths: [],
  secrets: { ignorePaths: [] },
  envDrift: { ignoreKeys: [] },
  fuzz: { maxExamples: 25, account: "merchantA" },
  suites: { pr: [], staging: [], nightly: [], local: [] },
  gate: { failOn: "high" },
  allowMutations: false,
  knownIssuesFile: "known-issues.json",
  mobile: { flowsDir: "qa-mobile", maestroPath: "maestro", env: {}, includeTags: [], excludeTags: [], timeoutMin: 30, maxSeconds: 0, severity: "high" },
  flows: { dir: "qa-flows", timeoutMs: 120000, stepTimeoutMs: 15000, maxMs: 60000, severity: "high" },
  lighthouse: { pages: {}, maxPages: 3, formFactor: "desktop", thresholds: { performance: 50, bestPractices: 80, lcpMs: 4000, tbtMs: 600, cls: 0.1 } },
  zap: { engine: "auto", docker: false, image: "ghcr.io/zaproxy/zaproxy:stable", spiderMinutes: 1, extraTargets: [], ignore: [], listingPaths: ["/uploads/", "/public/", "/static/", "/files/"] },
  load: { routes: [], maxRoutes: 10, vus: 4, durationSec: 30, rampSec: 5, maxRps: 10, thresholds: { p95Ms: 1500, errorRate: 0.01, slowdownFactor: 4 } },
  web: {
    apps: [],
    slowMs: 5000,
    ignoreConsole: [],
    viewport: { width: 1366, height: 900 },
    visual: { baselineDir: "visual-baselines", maxDiffRatio: 0.01, mask: [] },
  },
};

const SOCKET_DEFAULTS: Omit<SocketConfig, "urls" | "account" | "triggers"> = {
  path: "/socket.io", tokenIn: "auth", tokenKey: "token", connectTimeoutMs: 5000, settleMs: 1500, eventTimeoutMs: 5000,
  authErrorEvents: ["auth_error", "unauthorized", "error"],
};

function socketConfig(user: UserConfig): SocketConfig {
  const { trigger, ...rest } = user.socket!;
  return {
    ...SOCKET_DEFAULTS,
    urls: [],
    account: user.tenantIsolation?.owner ?? DEFAULTS.tenantIsolation.owner,
    attacker: user.tenantIsolation?.attacker ?? DEFAULTS.tenantIsolation.attacker,
    ...rest,
    triggers: [...(rest.triggers ?? []), ...(trigger ? [trigger] : [])],
  };
}

const WEB_APP_DEFAULTS = { loginPath: "/login", seedRoutes: ["/"], excludePaths: ["**/*logout*", "**/*log-out*", "**/*sign-out*", "**/*signout*", "**/*delete*"], maxPages: 60 };

export async function loadConfig(
  configPath: string,
  overrides: Partial<{ baseUrl: string; backendDir: string; allowMutations: boolean; platformAccounts: PlatformAccount[] }>,
): Promise<{ config: QaConfig; configDir: string; fromPlatform: string[] }> {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) throw new Error(`Config file not found: ${abs}`);
  const mod = await import(pathToFileURL(abs).href);
  const user: UserConfig = mod.default ?? mod;
  const config: QaConfig = {
    ...DEFAULTS,
    ...user,
    backend: user.backend === false ? { ...DEFAULTS.backend, dir: ".", none: true } : { ...DEFAULTS.backend, ...user.backend },
    target: { ...DEFAULTS.target, ...user.target },
    login: { ...DEFAULTS.login, ...user.login },
    tenantIsolation: { ...DEFAULTS.tenantIsolation, ...user.tenantIsolation },
    cors: { ...DEFAULTS.cors, ...user.cors },
    fuzz: { ...DEFAULTS.fuzz, ...user.fuzz },
    gate: { ...DEFAULTS.gate, ...user.gate },
    suites: { ...DEFAULTS.suites, ...(user.suites ?? {}) },
    secrets: { ...DEFAULTS.secrets, ...(user.secrets ?? {}) },
    envDrift: { ...DEFAULTS.envDrift, ...(user.envDrift ?? {}) },
    web: {
      ...DEFAULTS.web,
      ...(user.web ?? {}),
      visual: { ...DEFAULTS.web.visual, ...(user.web?.visual ?? {}) },
      apps: (user.web?.apps ?? []).map((a) => ({ ...WEB_APP_DEFAULTS, ...a, excludePaths: [...WEB_APP_DEFAULTS.excludePaths, ...(a.excludePaths ?? [])] }) as WebAppConfig),
    },
    socket: user.socket ? socketConfig(user) : undefined,
    zap: { ...DEFAULTS.zap, ...(user.zap ?? {}) },
    flows: { ...DEFAULTS.flows, ...(user.flows ?? {}) },
    mobile: { ...DEFAULTS.mobile, ...(user.mobile ?? {}) },
    lighthouse: { ...DEFAULTS.lighthouse, ...(user.lighthouse ?? {}), thresholds: { ...DEFAULTS.lighthouse.thresholds, ...(user.lighthouse?.thresholds ?? {}) } },
    load: { ...DEFAULTS.load, ...(user.load ?? {}), thresholds: { ...DEFAULTS.load.thresholds, ...(user.load?.thresholds ?? {}) } },
  } as QaConfig;
  const configDir = path.dirname(abs);
  if (overrides.backendDir) config.backend.dir = overrides.backendDir;
  config.backend.dir = path.resolve(configDir, config.backend.dir);
  if (overrides.baseUrl) config.target.baseUrl = overrides.baseUrl;
  if (config.target.baseUrl) config.target.baseUrl = config.target.baseUrl.replace(/\/+$/, "");
  if (config.socket) {
    if (!config.socket.urls.length && config.target.baseUrl) config.socket.urls = [config.target.baseUrl];
    config.socket.urls = config.socket.urls.filter(Boolean).map((u) => u.replace(/\/+$/, ""));
  }
  for (const a of config.web.apps) {
    if (a.baseUrl) a.baseUrl = a.baseUrl.replace(/\/+$/, "");
    if (a.sourceDir) a.sourceDir = path.resolve(configDir, a.sourceDir);
  }
  if (overrides.allowMutations !== undefined) config.allowMutations = overrides.allowMutations;
  // Logins from the platform's vault fill what env vars didn't provide
  config.accounts = structuredClone(config.accounts);
  const fromPlatform = overrides.platformAccounts ? mergeAccounts(config.accounts, overrides.platformAccounts) : [];
  // Drop accounts whose credentials are not provided (e.g. secrets missing locally)
  for (const [k, a] of Object.entries(config.accounts)) {
    if (!a.identifier || !a.password) delete config.accounts[k];
  }
  return { config, configDir, fromPlatform };
}
