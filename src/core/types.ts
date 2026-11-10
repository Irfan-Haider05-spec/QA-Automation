/**
 * Core contracts shared by the orchestrator and every plugin.
 * A plugin wraps one tool or one check and returns Finding objects.
 * Nothing in here calls a language model.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
export const severityRank = (s: Severity) => SEVERITY_ORDER.indexOf(s); // 0 = worst

export type Suite = "pr" | "staging" | "nightly" | "local";
export type Layer = "static" | "api" | "web" | "security" | "perf";

/** One HTTP route found in the backend source. */
export interface RouteInfo {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Full path as mounted, e.g. /api/v1/promo-merchant/:id */
  path: string;
  /** Path relative to the API prefix, e.g. /promo-merchant/:id (used in config allowlists) */
  apiPath: string;
  module: string;
  authRequired: boolean;
  roles: string[];
  multipart: boolean;
  validation?: { file: string; exportName: string; key: string };
  middlewares: string[];
  source: { file: string; line: number };
  /** Index of this route inside its router, used for shadowing analysis */
  order: number;
  routerFile: string;
}

export interface Evidence {
  url?: string;
  curl?: string;
  status?: number;
  responseSnippet?: string;
  file?: string;
  line?: number;
  log?: string;
  /** Screenshot or diff image, relative to the report folder */
  image?: string;
}

export interface Finding {
  plugin: string;
  severity: Severity;
  title: string;
  detail?: string;
  /** Route or file the finding is about; part of the fingerprint */
  target: string;
  category: "regression" | "security" | "config" | "performance" | "env" | "quality";
  evidence?: Evidence;
  /** Filled by triage */
  fingerprint?: string;
  known?: { reason: string; since?: string };
}

export interface PluginResult {
  plugin: string;
  status: "passed" | "failed" | "skipped" | "errored";
  reason?: string;
  durationMs: number;
  findings: Finding[];
  stats?: Record<string, number | string>;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
}

export interface QaPlugin {
  name: string;
  layer: Layer;
  description: string;
  /** Requirements the runner checks before calling run() */
  needs?: Array<"baseUrl" | "accounts" | "backendDir" | "openapi" | "webApps">;
  /** Return a string to skip with that reason, or null to run */
  skipReason?(ctx: import("./context.js").RunContext): string | null;
  run(ctx: import("./context.js").RunContext): Promise<Finding[] | { findings: Finding[]; stats?: PluginResult["stats"] }>;
}

/** Throw from run() when a plugin finds out only while running that it can't run here (e.g. no device) */
export class SkipError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipError";
  }
}
