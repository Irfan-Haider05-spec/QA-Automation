/**
 * Hosted runs of a project: "Run now", the queue, cancelling.
 *
 *   GET  …/projects/:projectId/jobs                   recent jobs, queued and running first
 *   POST …/projects/:projectId/jobs                   { environmentId, suite } → queued job
 *   POST …/projects/:projectId/jobs/:jobId/cancel     queued: cancelled now; running: the runner stops it
 */
import { Router } from "express";
import { z } from "zod";
import { HOSTED_SUITES } from "@qa/shared";
import { auth } from "../../middleware/auth.js";
import { conflict, handle, notFound, unprocessable, validate } from "../../lib/http.js";
import { audit, loadEnvironment, loadProject, scoped } from "../../lib/context.js";
import { readiness } from "./readiness.js";

export const JobsRouter = Router({ mergeParams: true });

export const JOB_COLUMNS = `j.id, j.environment_id as "environmentId", e.name as "environmentName", j.schedule_id as "scheduleId", j.suite, j.trigger_type as "trigger",
  j.status, j.cancel_requested as "cancelRequested", j.attempts, j.runner_id as "runnerId", j.created_at as "createdAt", j.claimed_at as "startedAt",
  j.finished_at as "finishedAt", j.run_id as "runId", j.error, u.name as "requestedBy",
  (select json_build_object('status', r.status, 'blocking', r.blocking, 'newIssues', r.new_issues) from runs r where r.id = j.run_id) as run`;
const FROM = "from run_jobs j join environments e on e.id = j.environment_id left join users u on u.id = j.requested_by";

JobsRouter.get(
  "/",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const jobs = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      return q(`select ${JOB_COLUMNS} ${FROM} where j.project_id = $1
                order by (j.status in ('queued', 'running')) desc, j.created_at desc limit 30`, [req.params.projectId]);
    });
    res.json({ jobs });
  }),
);

JobsRouter.post(
  "/",
  auth("owner", "admin", "developer"),
  validate({ body: z.object({ environmentId: z.string().uuid(), suite: z.enum(HOSTED_SUITES).default("staging") }) }),
  handle(async (req, res) => {
    const { environmentId, suite } = req.body;
    const job = await scoped(req, async (q) => {
      const env = await loadEnvironment(q, req, req.params.projectId, environmentId);
      const r = await readiness(q, req.params.projectId, env);
      if (!r.canRun) throw unprocessable(r.reasons.join(" "));
      const [dup] = await q("select id from run_jobs where environment_id = $1 and suite = $2 and status in ('queued', 'running')", [environmentId, suite]);
      if (dup) throw conflict(`A ${suite} run of ${env.name} is already queued or running`);
      const [{ id }] = await q<{ id: string }>(
        "insert into run_jobs (org_id, project_id, environment_id, suite, trigger_type, requested_by) values (app_org(), $1, $2, $3, 'manual', $4) returning id",
        [req.params.projectId, environmentId, suite, req.user!.id],
      );
      await audit(q, req, "job.requested", "run_job", id, { environment: env.name, suite });
      const [row] = await q(`select ${JOB_COLUMNS} ${FROM} where j.id = $1`, [id]);
      return row;
    });
    res.status(201).json({ job });
  }),
);

JobsRouter.post(
  "/:jobId/cancel",
  auth("owner", "admin", "developer"),
  validate({}),
  handle(async (req, res) => {
    const job = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      const [j] = await q<{ id: string; status: string }>("select id, status from run_jobs where id = $1 and project_id = $2 for update", [req.params.jobId, req.params.projectId]);
      if (!j) throw notFound("Job");
      if (j.status === "queued") await q("update run_jobs set status = 'cancelled', cancel_requested = true, finished_at = now() where id = $1", [j.id]);
      else if (j.status === "running") await q("update run_jobs set cancel_requested = true where id = $1", [j.id]);
      else throw conflict("This run has already finished");
      await audit(q, req, "job.cancelled", "run_job", j.id, { was: j.status });
      const [row] = await q(`select ${JOB_COLUMNS} ${FROM} where j.id = $1`, [j.id]);
      return row;
    });
    res.json({ job });
  }),
);
