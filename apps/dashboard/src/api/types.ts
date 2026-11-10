import type { ApiKeyScope, HostedSuite, NotifyEvent, Role, Severity, IssueStatus, RunTrigger } from "@qa/shared";
export type { ApiKeyScope, HostedSuite, NotifyEvent, Role, Severity, IssueStatus, RunTrigger };

export interface User { id: string; email: string; name: string; emailVerified?: boolean }
export interface OrgSummary { id: string; name: string; role: Role; clientIds: string[] | null }
export interface Org extends OrgSummary { createdAt: string; counts: { members: number; clients: number; projects: number } }
export interface Client { id: string; name: string; createdAt: string; projectCount: number }
export type RunStatus = "passed" | "failed" | "env_error";
export interface RunMini { id: string; status: RunStatus; suite: string; blocking?: number; createdAt: string }
export interface Project {
  id: string; name: string; clientId: string | null; clientName: string | null; repoUrl: string | null; stack: string;
  createdAt: string; updatedAt: string; lastRun: RunMini | null; recentRuns: RunMini[]; openIssues: number; openCritical: number;
  environments?: Array<{ id: string; name: string; apiBaseUrl: string | null; disposable: boolean; verifiedAt: string | null }>;
}
export interface WebApp { name: string; baseUrl: string; loginPath: string; account?: string }
export interface Environment {
  id: string; projectId: string; name: string; apiBaseUrl: string | null; webApps: WebApp[]; disposable: boolean;
  domain: string | null; verifiedAt: string | null; createdAt: string;
}
export interface Verification {
  verified: boolean; verifiedAt: string | null;
  instructions: null | { domain: string; dns: { type: string; name: string; value: string }; file: { url: string; content: string }; httpAllowed: boolean };
}
export interface Credential { id: string; name: string; role: string; identifier: string; device: string | null; createdAt: string; updatedAt: string; lastUsedAt: string | null }
export interface ApiKey { id: string; name: string; prefix: string; scopes: ApiKeyScope[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
export interface Run {
  id: string; environmentId: string | null; suite: string; source: string; status: RunStatus; target: string | null; startedAt: string; durationMs: number;
  routesTotal: number; routesSelected: number; selectionReason: string; fullCoverage: boolean; requests: number; gateFailOn: Severity; blocking: number;
  newIssues: number; fixedIssues: number; envError: string | null; git: GitInfo | null; createdAt: string;
  trigger: RunTrigger | null; deploymentId: string | null; deployment: { id: string; sha: string | null; ref: string | null; version: string | null; url: string | null; createdAt: string } | null;
}
export interface GitInfo { sha?: string; ref?: string; pr?: string; repo?: string; ciUrl?: string }
export interface Deployment {
  id: string; environmentId: string | null; environmentName: string | null; sha: string | null; ref: string | null; version: string | null; url: string | null;
  description: string | null; source: string; createdAt: string; lastRun: { id: string; status: RunStatus; blocking: number; createdAt: string } | null;
}
export interface PluginResult { plugin: string; status: "passed" | "failed" | "skipped" | "errored"; reason: string | null; durationMs: number; stats: Record<string, unknown> | null; findingCount: number }
export interface Finding {
  id: string; plugin: string; severity: Severity; category: string; title: string; detail: string | null; target: string; fingerprint: string;
  evidence: Record<string, any> | null; known: boolean; issueId: string | null; issueStatus: IssueStatus | null;
}
export interface RunDetail extends Run { plugins: PluginResult[]; findings: Finding[] }
export interface Issue {
  id: string; fingerprint: string; plugin: string; severity: Severity; category: string; title: string; target: string; status: IssueStatus;
  statusReason: string | null; statusUntil: string | null; assigneeId: string | null; assigneeName: string | null; firstSeenAt: string; lastSeenAt: string;
  occurrences: number; firstSeenRunId: string | null; lastSeenRunId: string | null;
}
export interface IssueOccurrence { id: string; runId: string; runAt: string; suite: string; detail: string | null; evidence: Record<string, any> | null }
export interface IssueDetail extends Issue { history: IssueOccurrence[] }
export interface Member { userId: string; name: string; email: string; role: Role; clientIds: string[] | null; joinedAt: string }
export interface Invite { id: string; email: string; role: Role; clientIds: string[] | null; expiresAt: string; createdAt: string }
export interface AuditEvent { id: string; action: string; entityType: string; entityId: string | null; data: any; createdAt: string; actorUserId: string | null; actorName: string | null; actorApiKeyId: string | null }

export type JobStatus = "queued" | "running" | "done" | "cancelled" | "error";
export interface Job {
  id: string; environmentId: string; environmentName: string; scheduleId: string | null; suite: HostedSuite; trigger: "manual" | "schedule" | "deploy";
  status: JobStatus; cancelRequested: boolean; attempts: number; runnerId: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
  runId: string | null; error: string | null; requestedBy: string | null; run: { status: RunStatus; blocking: number; newIssues: number } | null;
}
export interface Schedule {
  id: string; environmentId: string; environmentName: string; suite: HostedSuite; cron: string; timezone: string; enabled: boolean;
  nextRunAt: string | null; lastRunAt: string | null; lastError: string | null; createdAt: string;
  lastJob: { id: string; status: JobStatus; runId: string | null; runStatus: RunStatus | null; createdAt: string } | null;
}
export interface EnvReadiness { id: string; name: string; canRun: boolean; api: boolean; web: boolean; reasons: string[] }
export interface HostedStatus {
  enabled: boolean;
  profile: { routesCount: number; uploadedAt: string; git: GitInfo | null; authRoutes: number; accounts: Array<{ name: string; role: string }> } | null;
  environments: EnvReadiness[];
}

export interface Channel {
  id: string; name: string; kind: "slack" | "email" | "webhook"; recipients: string[] | null; targetHint: string | null; events: NotifyEvent[];
  projectIds: string[] | null; includeLocal: boolean; enabled: boolean; lastDeliveryAt: string | null; lastError: string | null; createdAt: string;
}
export interface Delivery { id: string; event: NotifyEvent; status: "queued" | "sending" | "sent" | "failed"; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null; nextAttemptAt: string; projectName: string | null; runUrl: string | null }

type SevCounts = Record<Severity, number>;
export interface Report {
  version: 1; org: { name: string }; scope: { type: "project" | "client"; id: string; name: string }; period: { from: string; to: string }; generatedAt: string;
  totals: { projects: number; runs: number; passed: number; failed: number; envErrors: number; passRate: number | null; openIssues: number; openBySeverity: SevCounts; newIssues: number; fixedIssues: number; regressions: number };
  days: Array<{ date: string; passed: number; failed: number; envError: number }>;
  projects: Array<{ id: string; name: string; clientName: string | null; runs: number; passed: number; passRate: number | null; lastRun: { status: RunStatus; at: string } | null; open: SevCounts; accepted: number; newInPeriod: number; fixedInPeriod: number; regressions: number }>;
  openIssues: Array<{ project: string; title: string; severity: Severity; target: string; status: "open" | "accepted"; acceptedUntil: string | null; acceptedReason: string | null; firstSeenAt: string; occurrences: number }>;
  fixedIssues: Array<{ project: string; title: string; severity: Severity; target: string; fixedAt: string }>;
}
export interface ReportShare { id: string; scopeType: "project" | "client"; scopeId: string; scopeName: string; from: string; to: string; expiresAt: string; revokedAt: string | null; viewCount: number; lastViewedAt: string | null; createdAt: string; createdBy: string | null }
