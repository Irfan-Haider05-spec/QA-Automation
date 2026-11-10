/**
 * Endpoints for runners (CLI, GitHub Action, hosted runner), authenticated with
 * a project API key instead of a user login.
 *
 *   POST /runner/runs                                upload a finished run
 *   POST /runner/deployments                         "this version is now live" (before a post-deploy run)
 *   GET  /runner/environments/:id/credentials        test-account passwords, for keys with credentials:read
 */
import { Router, type Request } from "express";
import { DeploymentUploadSchema, RunUploadSchema } from "@qa/shared";
import { authApiKey } from "../../middleware/auth.js";
import { handle, notFound, validate } from "../../lib/http.js";
import { audit, deps, scoped } from "../../lib/context.js";
import type { Query } from "../../db/index.js";
import { ingestRun } from "./ingest.js";
import { queueRunNotifications } from "../../lib/notify/events.js";

export const RunnerRouter = Router();

async function assertEnvironment(q: Query, projectId: string, environmentId: string | undefined) {
  if (!environmentId) return;
  const [e] = await q("select id from environments where id = $1 and project_id = $2", [environmentId, projectId]);
  if (!e) throw notFound("Environment");
}

const touchKey = (q: Query, req: Request) => q("update api_keys set last_used_at = now() where id = $1", [req.runner!.apiKeyId]);

RunnerRouter.post(
  "/runs",
  authApiKey("runs:write"),
  validate({ body: RunUploadSchema }),
  handle(async (req, res) => {
    const runner = req.runner!;
    const out = await scoped(req, async (q) => {
      await assertEnvironment(q, runner.projectId, req.body.environmentId);
      if (req.body.deploymentId) {
        const [d] = await q("select id from deployments where id = $1 and project_id = $2", [req.body.deploymentId, runner.projectId]);
        if (!d) throw notFound("Deployment");
      }
      const result = await ingestRun(q, runner.projectId, runner.apiKeyId, req.body);
      if (req.body.profile) {
        // Latest route list + non-secret config, for hosted runs
        await q(
          `insert into project_profiles (project_id, org_id, profile, routes_count, git, api_key_id, uploaded_at) values ($1, app_org(), $2, $3, $4, $5, now())
           on conflict (project_id) do update set profile = excluded.profile, routes_count = excluded.routes_count, git = excluded.git, api_key_id = excluded.api_key_id, uploaded_at = now()`,
          [runner.projectId, JSON.stringify(req.body.profile), req.body.profile.routes.length, req.body.git ? JSON.stringify(req.body.git) : null, runner.apiKeyId],
        );
      }
      await queueRunNotifications(q, {
        projectId: runner.projectId, environmentId: req.body.environmentId ?? null, result, suite: req.body.suite, source: req.body.source,
        trigger: req.body.trigger ?? (req.body.deploymentId ? "deploy" : null), blocking: req.body.gate.blocking, envError: req.body.gate.envError ?? null,
        git: req.body.git, appUrl: deps(req).config.APP_URL,
      });
      await touchKey(q, req);
      await audit(q, req, "run.uploaded", "run", result.runId, { suite: req.body.suite, status: result.status, newIssues: result.newIssues, fixedIssues: result.fixedIssues });
      return result;
    });
    const appUrl = deps(req).config.APP_URL;
    const { newIssueIds: _n, reopenedIssueIds: _r, ...summary } = out;
    res.status(201).json({
      ...summary,
      projectId: runner.projectId,
      orgId: runner.orgId,
      runUrl: appUrl ? `${appUrl}/o/${runner.orgId}/projects/${runner.projectId}/runs/${out.runId}` : null,
    });
  }),
);

RunnerRouter.post(
  "/deployments",
  authApiKey("runs:write"),
  validate({ body: DeploymentUploadSchema }),
  handle(async (req, res) => {
    const runner = req.runner!;
    const b = req.body;
    const deployment = await scoped(req, async (q) => {
      await assertEnvironment(q, runner.projectId, b.environmentId);
      const [d] = await q(
        `insert into deployments (org_id, project_id, environment_id, api_key_id, sha, ref, version, url, description, source)
         values (app_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id, environment_id as "environmentId", sha, ref, version, url, description, source, created_at as "createdAt"`,
        [runner.projectId, b.environmentId ?? null, runner.apiKeyId, b.sha ?? null, b.ref ?? null, b.version ?? null, b.url ?? null, b.description ?? null, b.source],
      );
      await touchKey(q, req);
      await audit(q, req, "deployment.reported", "deployment", d.id, { sha: b.sha, version: b.version, environmentId: b.environmentId });
      return d;
    });
    res.status(201).json({ deployment });
  }),
);

RunnerRouter.get(
  "/environments/:environmentId/credentials",
  authApiKey("credentials:read"),
  validate({}),
  handle(async (req, res) => {
    const runner = req.runner!;
    const { vault } = deps(req);
    const credentials = await scoped(req, async (q) => {
      await assertEnvironment(q, runner.projectId, req.params.environmentId);
      const rows = await q<{ id: string; name: string; role: string; identifier: string; device: string | null; secret_blob: string }>(
        "select id, name, role, identifier, device, secret_blob from credentials where environment_id = $1 order by name",
        [req.params.environmentId],
      );
      if (rows.length) await q("update credentials set last_used_at = now() where environment_id = $1", [req.params.environmentId]);
      await touchKey(q, req);
      // Which accounts were handed out, never the secrets
      await audit(q, req, "credentials.fetched", "environment", req.params.environmentId, { accounts: rows.map((r) => r.name) });
      return rows.map((r) => ({ name: r.name, role: r.role, identifier: r.identifier, device: r.device, secret: vault.decrypt(r.secret_blob, `${runner.orgId}:${r.id}`) }));
    });
    res.set("cache-control", "no-store").json({ credentials });
  }),
);
