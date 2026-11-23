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
  /**
   * Exact identity of the problem when title + target alone are not unique (for example a
   * scanner rule matching twice in one file, or two removed parameters of one operation).
   * Used verbatim in the fingerprint; never shown and not uploaded.
   */
  key?: string;
  category: "regression" | "security" | "config" | "performance" | "env" | "quality";
  evidence?: Evidence;
  /** Filled by triage */
  fingerprint?: string;
  known?: { reason: string; since?: string };
  confidence?: "high" | "medium" | "low";
  cwe?: string[];
  owasp?: string[];
  remediation?: string;
  flaky?: boolean;
}

/** One named test a check ran (an API scenario), for evidence such as UAT criteria. */
export interface CaseResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  tags?: string[];
  ms?: number;
}

export interface PluginResult {
  plugin: string;
  status: "passed" | "failed" | "skipped" | "errored";
  reason?: string;
  durationMs: number;
  findings: Finding[];
  stats?: Record<string, number | string>;
  /** Named tests the check ran and their outcome (at most 2000). */
  cases?: CaseResult[];
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
}

export interface QaPlugin {
  /** SDK major version. Local plugins execute with the same privileges as the CLI. */
  apiVersion?: 1;
  name: string;
  layer: Layer;
  description: string;
  /** Requirements the runner checks before calling run() */
  needs?: Array<"baseUrl" | "accounts" | "backendDir" | "openapi" | "webApps">;
  /** Return a string to skip with that reason, or null to run */
  skipReason?(ctx: import("./context.js").RunContext): string | null;
  /**
   * Whether this run of the plugin talks to the target API (decides whether the CLI
   * health-checks the target first). Default: it declares the baseUrl need, or its layer
   * is not "static". Set it when the answer depends on settings or differs from the default.
   */
  usesTarget?(ctx: import("./context.js").RunContext): boolean;
  /** Only explicitly read-only checks may implement confirmation. Never rerun a write/flow implicitly. */
  confirm?(ctx: import("./context.js").RunContext, finding: Finding): Promise<"confirmed" | "cleared" | "inconclusive">;
  run(ctx: import("./context.js").RunContext): Promise<Finding[] | { findings: Finding[]; stats?: PluginResult["stats"]; cases?: CaseResult[] }>;
}

/** Throw from run() when a plugin finds out only while running that it can't run here (e.g. no device) */
export class SkipError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipError";
  }
}
