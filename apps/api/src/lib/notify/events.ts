/**
 * Which notifications a stored run (or a failed hosted job) causes, written to
 * the outbox in the caller's transaction. Payloads are snapshots: a message says
 * what was true when the run arrived, even if it's sent minutes later.
 */
import type { Query } from "../../db/index.js";
import type { IngestResult } from "../../modules/runner/ingest.js";

import type { NotifyEvent } from "@qa/shared";
export type { NotifyEvent };

export interface NotifyIssue { title: string; severity: string; target: string; url: string | null }
export interface NotifyPayload {
  event: NotifyEvent;
  org: { id: string; name: string };
  project: { id: string; name: string };
  environment: string | null;
  run?: {
    id: string; status: string; suite: string; trigger: string | null; source: string; blocking: number;
    newIssues: number; fixedIssues: number; reopenedIssues: number; envError: string | null; url: string | null;
    git: { ref?: string; sha?: string; pr?: string; repo?: string } | null;
  };
  issues?: NotifyIssue[];
  job?: { id: string; suite: string; error: string };
  occurredAt: string;
  /** Set on test messages from the channel's "Send test" button */
  test?: boolean;
}

const SEVERITY = ["critical", "high", "medium", "low", "info"];

async function context(q: Query, projectId: string, environmentId: string | null) {
  const [p] = await q<{ id: string; name: string; org_id: string; org_name: string }>(
    "select p.id, p.name, p.org_id, o.name as org_name from projects p join orgs o on o.id = p.org_id where p.id = $1",
    [projectId],
  );
  const [e] = environmentId ? await q<{ name: string }>("select name from environments where id = $1", [environmentId]) : [];
  return { org: { id: p.org_id, name: p.org_name }, project: { id: p.id, name: p.name }, environment: e?.name ?? null };
}

async function issueList(q: Query, ids: string[], base: string | null, projectId: string): Promise<NotifyIssue[]> {
  if (!ids.length) return [];
  const rows = await q<{ id: string; title: string; severity: string; target: string }>("select id, title, severity, target from issues where id = any($1::uuid[])", [ids]);
  rows.sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
  return rows.slice(0, 5).map((r) => ({ title: r.title, severity: r.severity, target: r.target, url: base ? `${base}/projects/${projectId}/issues/${r.id}` : null }));
}

/** Insert one delivery per enabled channel that wants this event for this project */
async function enqueue(q: Query, payload: NotifyPayload, source: string) {
  const channels = await q<{ id: string }>(
    `select id from notification_channels
     where enabled and $1 = any(events) and (project_ids is null or $2 = any(project_ids)) and (include_local or $3 <> 'cli')`,
    [payload.event, payload.project.id, source],
  );
  for (const c of channels) {
    await q("insert into notification_deliveries (org_id, channel_id, event, payload) values (app_org(), $1, $2, $3)", [c.id, payload.event, JSON.stringify(payload)]);
  }
  return channels.length;
}

export async function queueRunNotifications(
  q: Query,
  a: { projectId: string; environmentId: string | null; result: IngestResult; suite: string; source: string; trigger: string | null; blocking: number; envError: string | null; git: { ref?: string; sha?: string; pr?: string; repo?: string } | null | undefined; appUrl: string | undefined },
): Promise<number> {
  const ctx = await context(q, a.projectId, a.environmentId);
  const base = a.appUrl ? `${a.appUrl}/o/${ctx.org.id}` : null;
  const run = {
    id: a.result.runId, status: a.result.status, suite: a.suite, trigger: a.trigger, source: a.source, blocking: a.blocking,
    newIssues: a.result.newIssues, fixedIssues: a.result.fixedIssues, reopenedIssues: a.result.reopenedIssues, envError: a.envError,
    url: base ? `${base}/projects/${a.projectId}/runs/${a.result.runId}` : null, git: a.git ?? null,
  };
  const common = { ...ctx, run, occurredAt: new Date().toISOString() };
  let n = 0;
  if (a.result.status === "failed") n += await enqueue(q, { ...common, event: "run.failed", issues: await issueList(q, a.result.newIssueIds, base, a.projectId) }, a.source);
  if (a.result.status === "env_error") n += await enqueue(q, { ...common, event: "run.env_error" }, a.source);
  if (a.result.status === "passed") {
    const [prev] = await q<{ status: string }>(
      "select status from runs where project_id = $1 and environment_id is not distinct from $2 and id <> $3 order by created_at desc limit 1",
      [a.projectId, a.environmentId, a.result.runId],
    );
    if (prev && prev.status !== "passed") n += await enqueue(q, { ...common, event: "run.recovered" }, a.source);
  }
  if (a.result.reopenedIssueIds.length) n += await enqueue(q, { ...common, event: "issue.regression", issues: await issueList(q, a.result.reopenedIssueIds, base, a.projectId) }, a.source);
  return n;
}

export async function queueJobError(q: Query, a: { projectId: string; environmentId: string; jobId: string; suite: string; error: string }) {
  const ctx = await context(q, a.projectId, a.environmentId);
  return enqueue(q, { ...ctx, event: "job.error", job: { id: a.jobId, suite: a.suite, error: a.error.slice(0, 500) }, occurredAt: new Date().toISOString() }, "hosted");
}
