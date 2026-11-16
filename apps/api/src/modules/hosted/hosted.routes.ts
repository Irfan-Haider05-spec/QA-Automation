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
import { ArtifactUploadSchema, storeArtifact } from "../artifacts/artifacts.routes.js";
import { recordRunUsage } from "../../lib/billing.js";

export const HostedRouter = Router();

HostedRouter.post("/jobs/:jobId/artifacts", authRunner(), validate({ body: ArtifactUploadSchema }), handle(async (req, res) => {
  const job = await inJobOrg(req, async (q) => {
    const [row] = await q("select org_id, project_id, run_id from run_jobs where id = $1 and runner_id = $2 and status = 'done' and run_id is not null and finished_at > now() - interval '15 minutes'", [req.params.jobId, req.hostedRunner!.id]);
    if (!row) throw notFound("Completed job");
    return row;
  });
  res.status(201).json(await storeArtifact(req, job.run_id, job.project_id, job.org_id, (fn) => inJobOrg(req, fn)));
}));

// Mark evidence complete only after all report-linked files were considered,
// or persist a fixed safe message if one or more uploads failed.
HostedRouter.post("/jobs/:jobId/evidence-status", authRunner(), validate({ body: z.object({ status: z.enum(["complete", "failed"]) }).strict() }), handle(async (req, res) => {
  const updated = await inJobOrg(req, async (q) => q<{ id: string }>(
    `update runs r set evidence_status = $1, evidence_error = $2
     from run_jobs j where j.id = $3 and j.runner_id = $4 and j.status = 'done'
       and j.run_id = r.id and j.finished_at > now() - interval '15 minutes'
     returning r.id`,
    [req.body.status, req.body.status === "failed" ? "Evidence upload failed. Review the hosted runner log for details." : null, req.params.jobId, req.hostedRunner!.id],
  ));
  if (!updated.length) throw notFound("Completed job");
  res.json({ status: req.body.status });
}));

// A runner may lose the HTTP response after completion committed. Keep the
// completion endpoint's conflict semantics; this read-only recovery endpoint
// lets that runner recover the stored run id and upload its local evidence.
HostedRouter.get("/jobs/:jobId/result", authRunner(), validate({}), handle(async (req, res) => {
  const result = await inJobOrg(req, async (q) => {
    const [row] = await q<{ status: string; run_id: string | null; finished_at: string | null }>(
      "select status, run_id, finished_at from run_jobs where id = $1 and runner_id = $2",
      [req.params.jobId, req.hostedRunner!.id],
    );
    if (!row || row.status !== "done" || !row.run_id || !row.finished_at || Date.now() - new Date(row.finished_at).getTime() > 15 * 60_000) throw notFound("Completed job result");
    return { status: row.status, runId: row.run_id };
  });
  res.set("cache-control", "no-store").json(result);
}));

interface JobRow { id: string; org_id: string; project_id: string; environment_id: string; suite: string; trigger_type: "manual" | "schedule" | "deploy"; attempts: number; cancel_requested: boolean; status: string; claimed_at: string; runtime_ms: number | string }

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
      const currentAttemptMs = job.claimed_at ? Math.max(0, Date.now() - new Date(job.claimed_at).getTime()) : 0;
      const elapsedMs = Math.max(0, Number(job.runtime_ms ?? 0)) + currentAttemptMs;
      if (job.cancel_requested) {
        const changed = await q("update run_jobs set status = 'cancelled', runtime_ms = $1, finished_at = now(), usage_accounted_at = now() where id = $2 and status = 'running' returning id", [elapsedMs, job.id]);
        if (changed.length) await recordRunUsage(q, elapsedMs, true, deps(req).config);
        return { status: "cancelled" as const, runId: null };
      }
      if (!req.body.run) {
        const changed = await q("update run_jobs set status = 'error', error = $1, runtime_ms = $2, finished_at = now(), usage_accounted_at = now() where id = $3 and status = 'running' returning id", [req.body.error, elapsedMs, job.id]);
        if (changed.length) await recordRunUsage(q, elapsedMs, true, deps(req).config);
        await queueJobError(q, { projectId: job.project_id, environmentId: job.environment_id, jobId: job.id, suite: job.suite, error: String(req.body.error) });
        await audit(q, req, "job.failed", "run_job", job.id, { error: String(req.body.error).slice(0, 300) });
        return { status: "error" as const, runId: null };
      }
      // Hosted results are stored exactly like uploads, attributed to the job's environment and trigger
      const { profile: _ignored, ...run } = req.body.run;
      const result = await ingestRun(q, job.project_id, null, { ...run, durationMs: elapsedMs, source: "hosted", trigger: job.trigger_type, environmentId: job.environment_id, deploymentId: undefined }, deps(req).config);
      await q("update runs set evidence_status = 'pending', evidence_error = null where id = $1", [result.runId]);
      await q("update run_jobs set status = 'done', run_id = $1, runtime_ms = $2, finished_at = now(), usage_accounted_at = now() where id = $3 and status = 'running'", [result.runId, elapsedMs, job.id]);
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
