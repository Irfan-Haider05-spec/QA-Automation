import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { handle, notFound, query, validate } from "../../lib/http.js";
import { deps, loadProject, scoped } from "../../lib/context.js";

export const RunsRouter = Router({ mergeParams: true });

RunsRouter.get("/trends", auth(), validate({ query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30), environmentId: z.string().uuid().optional(), suite: z.string().max(40).optional() }) }), handle(async (req, res) => {
  const filter = query<{ days: number; environmentId?: string; suite?: string }>(req);
  const data = await scoped(req, async (q) => {
    await loadProject(q, req, req.params.projectId);
    const args = [req.params.projectId, filter.days, filter.environmentId ?? null, filter.suite ?? null];
    const days = await q(`select to_char(created_at at time zone 'UTC','YYYY-MM-DD') as day, count(*)::int as runs,
      count(*) filter(where status='passed')::int as passed, count(*) filter(where status='failed')::int as failed,
      count(*) filter(where env_error is not null)::int as "envErrors", round(avg(duration_ms))::int as "averageDurationMs",
      coalesce(sum(new_issues),0)::int as "newIssues", coalesce(sum(fixed_issues),0)::int as "fixedIssues"
      from runs where project_id=$1 and created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC' - ($2-1)*interval '1 day'
      and ($3::uuid is null or environment_id=$3) and ($4::text is null or suite=$4) group by day order by day`, args);
    const plugins = await q(`select p.plugin, count(*)::int as executions, count(*) filter(where p.status='failed')::int as failed,
      count(*) filter(where p.status='errored')::int as errored, count(*) filter(where p.status='skipped')::int as skipped,
      coalesce(sum(p.finding_count),0)::int as findings from plugin_results p join runs r on r.id=p.run_id
      where r.project_id=$1 and r.created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC' - ($2-1)*interval '1 day'
      and ($3::uuid is null or r.environment_id=$3) and ($4::text is null or r.suite=$4) group by p.plugin order by findings desc, p.plugin limit 100`, args);
    return { days, plugins };
  });
  res.json({ ...data, windowDays: filter.days, timezone: "UTC", generatedAt: new Date().toISOString() });
}));

const RUN_COLUMNS = `r.id, r.environment_id as "environmentId", r.suite, r.source, r.status, r.target, r.started_at as "startedAt", r.duration_ms as "durationMs",
  r.routes_total as "routesTotal", r.routes_selected as "routesSelected", r.selection_reason as "selectionReason", r.full_coverage as "fullCoverage",
  r.requests, r.gate_fail_on as "gateFailOn", r.blocking, r.new_issues as "newIssues", r.fixed_issues as "fixedIssues", r.env_error as "envError", r.git, r.created_at as "createdAt",
  r.trigger_type as "trigger", r.deployment_id as "deploymentId", r.evidence_status as "evidenceStatus", r.evidence_error as "evidenceError",
  (select json_build_object('id', d.id, 'sha', d.sha, 'ref', d.ref, 'version', d.version, 'url', d.url, 'createdAt', d.created_at) from deployments d where d.id = r.deployment_id) as deployment`;

RunsRouter.get(
  "/",
  auth(),
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), before: z.string().datetime().optional() }) }),
  handle(async (req, res) => {
    const { limit, before } = query<{ limit: number; before?: string }>(req);
    const runs = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      return q(`select ${RUN_COLUMNS} from runs r where r.project_id = $1 and ($2::timestamptz is null or r.created_at < $2) order by r.created_at desc limit $3`, [req.params.projectId, before ?? null, limit]);
    });
    res.json({ runs, nextBefore: runs.length === limit ? runs[runs.length - 1].createdAt : null });
  }),
);

RunsRouter.get(
  "/:runId",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const run = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      const [r] = await q(`select ${RUN_COLUMNS} from runs r where r.id = $1 and r.project_id = $2`, [req.params.runId, req.params.projectId]);
      if (!r) throw notFound("Run");
      const plugins = await q(`select plugin, status, reason, duration_ms as "durationMs", stats, finding_count as "findingCount" from plugin_results where run_id = $1 order by plugin`, [r.id]);
      const findings = await q(
        `select f.id, f.plugin, f.severity, f.category, f.title, f.detail, f.target, f.fingerprint, f.evidence, f.known, f.issue_id as "issueId", i.status as "issueStatus"
         from findings f left join issues i on i.id = f.issue_id where f.run_id = $1
         order by array_position(array['critical','high','medium','low','info'], f.severity), f.plugin`,
        [r.id],
      );
      const artifacts = await q("select id, name, size_bytes as size, expires_at as \"expiresAt\", object_key from artifacts where run_id = $1 and state = 'ready' and expires_at > now() order by created_at", [r.id]);
      return { ...r, plugins, findings, artifacts };
    });
    const store = deps(req).artifacts;
    const artifacts = await Promise.all(run.artifacts.map(async ({ object_key, ...a }: any) => ({ ...a, downloadUrl: store ? await store.download(object_key, a.name) : null })));
    res.setHeader("Cache-Control", "no-store");
    res.json({ run: { ...run, artifacts } });
  }),
);
