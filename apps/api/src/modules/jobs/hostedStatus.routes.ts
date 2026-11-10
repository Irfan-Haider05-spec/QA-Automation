/**
 * What the hosted runner can do for a project: whether hosted runs are enabled,
 * the route list it works from, and per environment whether a run can start.
 *
 *   GET …/projects/:projectId/hosted
 */
import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import { handle, validate } from "../../lib/http.js";
import { deps, loadProject, scoped } from "../../lib/context.js";
import { readiness } from "./readiness.js";

export const HostedStatusRouter = Router({ mergeParams: true });

HostedStatusRouter.get(
  "/",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const out = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      const [p] = await q<{ routes_count: number; uploaded_at: Date; git: unknown; profile: any }>(
        "select routes_count, uploaded_at, git, profile from project_profiles where project_id = $1",
        [req.params.projectId],
      );
      const envs = await q<any>("select * from environments where project_id = $1 order by created_at", [req.params.projectId]);
      const environments = [];
      for (const e of envs) environments.push({ id: e.id, name: e.name, ...(await readiness(q, req.params.projectId, e)) });
      return {
        enabled: !!deps(req).config.RUNNER_TOKEN,
        profile: p ? {
          routesCount: p.routes_count, uploadedAt: p.uploaded_at, git: p.git,
          authRoutes: p.profile.routes.filter((r: any) => r.authRequired).length,
          accounts: Object.entries(p.profile.accounts ?? {}).map(([name, a]: [string, any]) => ({ name, role: a.role })),
        } : null,
        environments,
      };
    });
    res.json(out);
  }),
);
