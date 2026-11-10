/**
 * Contracts shared by the QA engine (runner), the platform API and the dashboard.
 * Anything that crosses a process boundary is described here once, as a zod
 * schema, so all three sides validate the same shape.
 */
import { z } from "zod";

// ─── Roles & permissions ──────────────────────────────────────────────────────

export const ROLES = ["owner", "admin", "developer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** What each role may do. Client-scoped members get the same actions, limited to their clients' projects. */
export const PERMISSIONS = {
  "org.update": ["owner", "admin"],
  "org.delete": ["owner"],
  "members.manage": ["owner", "admin"],
  "clients.manage": ["owner", "admin"],
  "projects.create": ["owner", "admin", "developer"],
  "projects.update": ["owner", "admin", "developer"],
  "projects.delete": ["owner", "admin"],
  "environments.manage": ["owner", "admin", "developer"],
  "environments.setDisposable": ["owner", "admin"],
  "credentials.manage": ["owner", "admin", "developer"],
  "apiKeys.manage": ["owner", "admin", "developer"],
  "issues.triage": ["owner", "admin", "developer"],
  "runs.start": ["owner", "admin", "developer"],
  "schedules.manage": ["owner", "admin", "developer"],
  "notifications.manage": ["owner", "admin"],
  "reports.share": ["owner", "admin"],
  "audit.read": ["owner", "admin"],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;
export const can = (role: Role, p: Permission) => (PERMISSIONS[p] as readonly Role[]).includes(role);

// ─── Engine → platform: run upload ───────────────────────────────────────────

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingUploadSchema = z.object({
  plugin: z.string().min(1).max(100),
  severity: SeveritySchema,
  title: z.string().min(1).max(500),
  detail: z.string().max(5000).optional(),
  target: z.string().max(500),
  category: z.string().max(40),
  fingerprint: z.string().min(6).max(64),
  evidence: z.record(z.unknown()).optional(),
  known: z.object({ reason: z.string(), since: z.string().optional() }).optional(),
});

export const PluginResultUploadSchema = z.object({
  plugin: z.string().min(1).max(100),
  status: z.enum(["passed", "failed", "skipped", "errored"]),
  reason: z.string().max(2000).optional(),
  durationMs: z.number().int().nonnegative(),
  findings: z.array(FindingUploadSchema).max(5000),
  stats: z.record(z.union([z.number(), z.string()])).optional(),
});

export const RUN_TRIGGERS = ["pr", "push", "deploy", "schedule", "manual"] as const;
export const RunTriggerSchema = z.enum(RUN_TRIGGERS);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

/** Where the code under test came from. All optional: local runs may have none of it. */
export const GitInfoSchema = z.object({
  sha: z.string().max(64).optional(),
  ref: z.string().max(255).optional(),
  pr: z.string().max(20).optional(),
  /** "owner/repo" on GitHub */
  repo: z.string().max(200).optional(),
  /** Link to the CI job that produced the run */
  ciUrl: z.string().url().max(500).optional(),
});
export type GitInfo = z.infer<typeof GitInfoSchema>;

// ─── CI → platform: a deployment went live ───────────────────────────────────

export const DeploymentUploadSchema = z.object({
  environmentId: z.string().uuid().optional(),
  sha: z.string().max(64).optional(),
  ref: z.string().max(255).optional(),
  version: z.string().max(100).optional(),
  url: z.string().url().max(500).optional(),
  description: z.string().max(500).optional(),
  source: z.enum(["cli", "ci", "hosted"]).default("ci"),
});
export type DeploymentUpload = z.infer<typeof DeploymentUploadSchema>;

// ─── API key scopes ──────────────────────────────────────────────────────────

/** runs:write is always included; credentials:read lets a CI runner fetch test-account passwords */
export const API_KEY_SCOPES = ["runs:write", "credentials:read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

// ─── Project profile: what a hosted runner needs, sent by CI runs ────────────
// The route list from source plus the non-secret parts of qa.config.ts. Hosted
// runs test deployed environments without the source code, from this profile.

export const ProfileRouteSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().max(500),
  apiPath: z.string().max(500),
  module: z.string().max(200),
  authRequired: z.boolean(),
  roles: z.array(z.string().max(100)).max(50),
  multipart: z.boolean(),
  middlewares: z.array(z.string().max(200)).max(50),
}).passthrough();

export const ProjectProfileSchema = z.object({
  version: z.literal(1),
  apiPrefix: z.string().max(200),
  healthPath: z.string().max(200),
  login: z.object({ path: z.string().max(300), tokenPath: z.string().max(200), bodyTemplate: z.record(z.string().max(200)).optional() }),
  /** Account names with their app role; never identifiers or passwords */
  accounts: z.record(z.object({ role: z.string().max(100), device: z.string().max(100).optional() })),
  publicRoutes: z.array(z.string().max(500)).max(1000),
  privilegedPrefixes: z.array(z.string().max(300)).max(200),
  tenantIsolation: z.object({
    owner: z.string().max(100), attacker: z.string().max(100),
    sharedResources: z.array(z.string().max(500)).max(500),
    pairs: z.array(z.object({ list: z.string().max(500), detail: z.string().max(500) })).max(500),
    maxIdsPerRoute: z.number().int().min(1).max(20),
  }),
  cors: z.object({ allowedOrigins: z.array(z.string().max(300)).max(50), probeOrigin: z.string().max(300) }),
  pathParams: z.record(z.string().max(300)),
  gateFailOn: SeveritySchema,
  web: z.object({
    slowMs: z.number().int().positive(),
    ignoreConsole: z.array(z.string().max(500)).max(100),
    apps: z.array(z.object({
      name: z.string().max(60), loginPath: z.string().max(300), account: z.string().max(100),
      seedRoutes: z.array(z.string().max(500)).max(200), excludePaths: z.array(z.string().max(500)).max(200), maxPages: z.number().int().positive(),
      selectors: z.object({ identifier: z.string().max(300).optional(), password: z.string().max(300).optional(), submit: z.string().max(300).optional() }).optional(),
    })).max(20),
  }),
  routes: z.array(ProfileRouteSchema).max(5000),
});
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

export const NOTIFY_EVENTS = ["run.failed", "run.recovered", "run.env_error", "issue.regression", "job.error"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** Which checks a hosted run can do, by suite */
export const HOSTED_SUITES = ["staging", "nightly"] as const;
export type HostedSuite = (typeof HOSTED_SUITES)[number];
/** api: needs the project profile (routes); web: needs dashboards; any: runs whenever there's something to test */
export const HOSTED_PLUGINS: Record<HostedSuite, { api: string[]; web: string[]; any: string[] }> = {
  staging: { api: ["health-cors", "api-auth", "api-smoke", "tenant-isolation"], web: ["web-crawl"], any: [] },
  nightly: { api: ["health-cors", "api-auth", "api-smoke", "tenant-isolation", "load-smoke"], web: ["web-crawl", "web-a11y", "lighthouse"], any: ["zap-baseline"] },
};

/** Matches the engine's RunSummary (src/core/report.ts) plus platform-only fields */
export const RunUploadSchema = z.object({
  project: z.string().max(200),
  suite: z.string().max(40),
  target: z.string().max(500).optional(),
  startedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  routesTotal: z.number().int().nonnegative(),
  routesSelected: z.number().int().nonnegative(),
  selectionReason: z.string().max(500),
  requests: z.number().int().nonnegative(),
  results: z.array(PluginResultUploadSchema).max(100),
  gate: z.object({ failOn: SeveritySchema, passed: z.boolean(), blocking: z.number().int().nonnegative(), envError: z.string().optional() }),
  git: GitInfoSchema.optional(),
  /** Platform-only */
  environmentId: z.string().uuid().optional(),
  source: z.enum(["cli", "ci", "hosted"]).default("cli"),
  /** Why the run happened */
  trigger: RunTriggerSchema.optional(),
  /** The deployment this run checked (from POST /runner/deployments) */
  deploymentId: z.string().uuid().optional(),
  /** Route list + non-secret config, from CI runs that read the source */
  profile: ProjectProfileSchema.optional(),
});
export type RunUpload = z.infer<typeof RunUploadSchema>;

export const ISSUE_STATUSES = ["open", "known", "ignored", "fixed"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
