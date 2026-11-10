/**
 * Endpoints for hosted runners (platform infrastructure, RUNNER_TOKEN):
 *
 *   POST /hosted/jobs/claim               next runnable job with everything needed to run it, or 204
 *   POST /hosted/jobs/:jobId/heartbeat    "still working"; answers { cancel } when the user cancelled
 *   POST /hosted/jobs/:jobId/complete     { run } or { error }; the run is stored like any upload
 *
 * Claims go through qa_claim_job (only verified environments, one running job
 * per environment). After the claim every query runs inside the job's
 * organization, so row-level security still applies.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { RunUploadSchema } from "@qa/shared";
import { authRunner } from "../../middleware/auth.js";
import { conflict, handle, notFound, validate } from "../../lib/http.js";
import { audit, deps } from "../../lib/context.js";
import { withContext, type Query } from "../../db/index.js";
import { ingestRun } from "../runner/ingest.js";
import { readiness } from "../jobs/readiness.js";
import { queueJobError, queueRunNotifications } from "../../lib/notify/events.js";

export const HostedRouter = Router();

interface JobRow { id: string; org_id: string; project_id: string; environment_id: string; suite: string; trigger_type: "manual" | "schedule" | "deploy"; attempts: number; cancel_requested: boolean; status: string }

/** Run fn inside the org of a job this runner holds; 404 if it doesn't hold it */
async function inJobOrg<T>(req: Request, fn: (q: Query) => Promise<T>): Promise<T> {
  const { db } = deps(req);
  const [row] = await withContext(db, {}, (q) => q<{ org: string | null }>("select qa_job_org($1, $2) as org", [req.params.jobId, req.hostedRunner!.id]));
  if (!row?.org) throw notFound("Job");
  return withContext(db, { orgId: row.org }, fn);
}

HostedRouter.post(
  "/jobs/claim",
  authRunner(),
  validate({}),
  handle(async (req, res) => {
    const { db, vault } = deps(req);
    const [job] = await withContext(db, {}, (q) => q<JobRow>("select * from qa_claim_job($1)", [req.hostedRunner!.id]));
    if (!job) return void res.status(204).end();
    const payload = await withContext(db, { orgId: job.org_id }, async (q) => {
      const [project] = await q<{ id: string; name: string }>("select id, name from projects where id = $1", [job.project_id]);
      const [env] = await q<any>("select * from environments where id = $1", [job.environment_id]);
      const [profile] = await q<{ profile: unknown }>("select profile from project_profiles where project_id = $1", [job.project_id]);
      const creds = await q<{ id: string; name: string; role: string; identifier: string; device: string | null; secret_blob: string }>(
        "select id, name, role, identifier, device, secret_blob from credentials where environment_id = $1 order by name",
        [job.environment_id],
      );
      if (creds.length) await q("update credentials set last_used_at = now() where environment_id = $1", [job.environment_id]);
      await q(
        "insert into audit_events (org_id, action, entity_type, entity_id, data) values (app_org(), 'credentials.fetched', 'environment', $1, $2)",
        [env.id, JSON.stringify({ accounts: creds.map((c) => c.name), hostedRunner: req.hostedRunner!.id, jobId: job.id })],
      );
      const r = await readiness(q, job.project_id, env);
      return {
        job: { id: job.id, suite: job.suite, trigger: job.trigger_type, attempts: job.attempts },
        project: { id: project.id, name: project.name },
        environment: { id: env.id, name: env.name, apiBaseUrl: env.api_base_url, webApps: env.web_apps ?? [], disposable: env.disposable, domain: env.domain },
        profile: profile?.profile ?? null,
        checks: { api: r.api, web: r.web },
        accounts: creds.map((c) => ({ name: c.name, role: c.role, identifier: c.identifier, device: c.device, secret: vault.decrypt(c.secret_blob, `${job.org_id}:${c.id}`) })),
      };
    });
    res.set("cache-control", "no-store").json(payload);
  }),
);

HostedRouter.post(
  "/jobs/:jobId/heartbeat",
  authRunner(),
  validate({}),
  handle(async (req, res) => {
    const out = await inJobOrg(req, async (q) => {
      const [j] = await q<{ cancel_requested: boolean }>(
        "update run_jobs set heartbeat_at = now() where id = $1 and runner_id = $2 and status = 'running' returning cancel_requested",
        [req.params.jobId, req.hostedRunner!.id],
      );
      // Not running for this runner any more (finished, or retried elsewhere after a long silence): stop
      if (!j) throw conflict("This job is no longer assigned to this runner");
      return { cancel: j.cancel_requested };
    });
    res.json(out);
  }),
);

HostedRouter.post(
  "/jobs/:jobId/complete",
  authRunner(),
  validate({ body: z.object({ run: RunUploadSchema.optional(), error: z.string().max(4000).optional() }).refine((b) => b.run || b.error, "Send run or error") }),
  handle(async (req, res) => {
    const out = await inJobOrg(req, async (q) => {
      const [job] = await q<JobRow>("select * from run_jobs where id = $1 and runner_id = $2 and status = 'running' for update", [req.params.jobId, req.hostedRunner!.id]);
      if (!job) throw conflict("This job is no longer assigned to this runner");
      if (job.cancel_requested) {
        await q("update run_jobs set status = 'cancelled', finished_at = now() where id = $1", [job.id]);
        return { status: "cancelled" as const, runId: null };
      }
      if (!req.body.run) {
        await q("update run_jobs set status = 'error', error = $1, finished_at = now() where id = $2", [req.body.error, job.id]);
        await queueJobError(q, { projectId: job.project_id, environmentId: job.environment_id, jobId: job.id, suite: job.suite, error: String(req.body.error) });
        await audit(q, req, "job.failed", "run_job", job.id, { error: String(req.body.error).slice(0, 300) });
        return { status: "error" as const, runId: null };
      }
      // Hosted results are stored exactly like uploads, attributed to the job's environment and trigger
      const { profile: _ignored, ...run } = req.body.run;
      const result = await ingestRun(q, job.project_id, null, { ...run, source: "hosted", trigger: job.trigger_type, environmentId: job.environment_id, deploymentId: undefined });
      await q("update run_jobs set status = 'done', run_id = $1, finished_at = now() where id = $2", [result.runId, job.id]);
      await queueRunNotifications(q, {
        projectId: job.project_id, environmentId: job.environment_id, result, suite: run.suite, source: "hosted", trigger: job.trigger_type,
        blocking: run.gate.blocking, envError: run.gate.envError ?? null, git: run.git, appUrl: deps(req).config.APP_URL,
      });
      await audit(q, req, "run.uploaded", "run", result.runId, { suite: job.suite, status: result.status, newIssues: result.newIssues, fixedIssues: result.fixedIssues, hostedRunner: req.hostedRunner!.id, jobId: job.id });
      return { status: "done" as const, runId: result.runId, newIssues: result.newIssues };
    });
    res.json(out);
  }),
);
