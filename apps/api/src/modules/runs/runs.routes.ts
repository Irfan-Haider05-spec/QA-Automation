import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { handle, notFound, query, validate } from "../../lib/http.js";
import { loadProject, scoped } from "../../lib/context.js";

export const RunsRouter = Router({ mergeParams: true });

const RUN_COLUMNS = `r.id, r.environment_id as "environmentId", r.suite, r.source, r.status, r.target, r.started_at as "startedAt", r.duration_ms as "durationMs",
  r.routes_total as "routesTotal", r.routes_selected as "routesSelected", r.selection_reason as "selectionReason", r.full_coverage as "fullCoverage",
  r.requests, r.gate_fail_on as "gateFailOn", r.blocking, r.new_issues as "newIssues", r.fixed_issues as "fixedIssues", r.env_error as "envError", r.git, r.created_at as "createdAt",
  r.trigger_type as "trigger", r.deployment_id as "deploymentId",
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
      return { ...r, plugins, findings };
    });
    res.json({ run });
  }),
);
