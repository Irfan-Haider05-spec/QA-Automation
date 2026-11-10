/**
 * Turning an uploaded run into issues.
 *
 * - Every finding belongs to one issue per (project, fingerprint).
 * - New fingerprint → new issue (status "known" if the engine's baseline already knew it).
 * - A "fixed" issue that appears again is reopened (regression).
 * - A "known" issue whose until-date has passed is reopened.
 * - An open issue is marked fixed only by a run with full route coverage in which
 *   its plugin actually ran and did not report it. Partial (diff-selected) PR runs
 *   and skipped/errored plugins never close issues.
 */
import type { RunUpload } from "@qa/shared";
import type { Query } from "../../db/index.js";

export interface IngestResult {
  runId: string;
  status: "passed" | "failed" | "env_error";
  newIssues: number;
  fixedIssues: number;
  reopenedIssues: number;
  findings: number;
  newIssueIds: string[];
  reopenedIssueIds: string[];
}

export async function ingestRun(q: Query, projectId: string, apiKeyId: string | null, run: RunUpload): Promise<IngestResult> {
  const status = run.gate.envError ? "env_error" : run.gate.passed ? "passed" : "failed";
  const fullCoverage = run.routesSelected >= run.routesTotal;
  const [r] = await q<{ id: string }>(
    `insert into runs (org_id, project_id, environment_id, api_key_id, suite, source, status, target, started_at, duration_ms, routes_total, routes_selected,
       selection_reason, full_coverage, requests, gate_fail_on, blocking, env_error, git, trigger_type, deployment_id)
     values (app_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) returning id`,
    [
      projectId, run.environmentId ?? null, apiKeyId, run.suite, run.source, status, run.target ?? null, run.startedAt, run.durationMs,
      run.routesTotal, run.routesSelected, run.selectionReason, fullCoverage, run.requests, run.gate.failOn, run.gate.blocking,
      run.gate.envError ?? null, run.git ? JSON.stringify(run.git) : null, run.trigger ?? (run.deploymentId ? "deploy" : null), run.deploymentId ?? null,
    ],
  );
  const runId = r.id;

  let newIssues = 0;
  let reopenedIssues = 0;
  let findingCount = 0;
  const seen = new Set<string>();
  const newIssueIds: string[] = [];
  const reopenedIssueIds: string[] = [];

  for (const pr of run.results) {
    await q(
      "insert into plugin_results (org_id, run_id, plugin, status, reason, duration_ms, stats, finding_count) values (app_org(), $1, $2, $3, $4, $5, $6, $7)",
      [runId, pr.plugin, pr.status, pr.reason ?? null, pr.durationMs, pr.stats ? JSON.stringify(pr.stats) : null, pr.findings.length],
    );
    for (const f of pr.findings) {
      if (seen.has(f.fingerprint)) continue;
      seen.add(f.fingerprint);
      findingCount++;
      const [issue] = await q<{ id: string; inserted: boolean; reopened: boolean }>(
        `with prev as (select status, status_until from issues where project_id = $1 and fingerprint = $2)
         insert into issues (org_id, project_id, fingerprint, plugin, severity, category, title, target, status, status_reason, first_seen_run_id, last_seen_run_id)
         values (app_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         on conflict (project_id, fingerprint) do update set
           severity = excluded.severity, category = excluded.category, title = excluded.title, target = excluded.target,
           last_seen_run_id = excluded.last_seen_run_id, last_seen_at = now(), occurrences = issues.occurrences + 1, updated_at = now(),
           reopened_at = case when issues.status = 'fixed' then now() else issues.reopened_at end,
           fixed_at = case when issues.status = 'fixed' then null else issues.fixed_at end,
           status = case
             when issues.status = 'fixed' then 'open'
             when issues.status = 'known' and issues.status_until is not null and issues.status_until < current_date then 'open'
             else issues.status end,
           status_reason = case
             when issues.status = 'fixed' then 'Regression: found again after being fixed'
             when issues.status = 'known' and issues.status_until is not null and issues.status_until < current_date then 'Accepted-until date passed'
             else issues.status_reason end
         returning id, (xmax = 0) as inserted,
           (select p.status = 'fixed' or (p.status = 'known' and p.status_until is not null and p.status_until < current_date) from prev p) as reopened`,
        [projectId, f.fingerprint, f.plugin, f.severity, f.category, f.title, f.target, f.known ? "known" : "open", f.known ? f.known.reason : null, runId],
      );
      if (issue.inserted) { newIssues++; newIssueIds.push(issue.id); }
      else if (issue.reopened) { reopenedIssues++; reopenedIssueIds.push(issue.id); }
      await q(
        "insert into findings (org_id, run_id, issue_id, plugin, severity, category, title, detail, target, fingerprint, evidence, known) values (app_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        [runId, issue.id, f.plugin, f.severity, f.category, f.title, f.detail ?? null, f.target, f.fingerprint, f.evidence ? JSON.stringify(f.evidence) : null, !!f.known],
      );
    }
  }

  let fixedIssues = 0;
  const ranPlugins = run.results.filter((p) => p.status === "passed" || p.status === "failed").map((p) => p.plugin);
  if (fullCoverage && !run.gate.envError && ranPlugins.length) {
    const fixed = await q(
      `update issues set status = 'fixed', status_reason = 'Not found in a full run', updated_at = now(), fixed_at = now()
       where project_id = $1 and status = 'open' and plugin = any($2::text[]) and not (fingerprint = any($3::text[])) returning id`,
      [projectId, ranPlugins, [...seen]],
    );
    fixedIssues = fixed.length;
  }

  await q("update runs set new_issues = $2, fixed_issues = $3 where id = $1", [runId, newIssues, fixedIssues]);
  return { runId, status, newIssues, fixedIssues, reopenedIssues, findings: findingCount, newIssueIds, reopenedIssueIds };
}
