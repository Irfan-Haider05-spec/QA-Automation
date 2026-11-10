/**
 * Deployments of a project, newest first, each with the result of the run that
 * checked it (if any). Reported by CI through POST /runner/deployments.
 */
import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { handle, query, validate } from "../../lib/http.js";
import { loadProject, scoped } from "../../lib/context.js";

export const DeploymentsRouter = Router({ mergeParams: true });

DeploymentsRouter.get(
  "/",
  auth(),
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }) }),
  handle(async (req, res) => {
    const { limit } = query<{ limit: number }>(req);
    const deployments = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      return q(
        `select d.id, d.environment_id as "environmentId", e.name as "environmentName", d.sha, d.ref, d.version, d.url, d.description, d.source, d.created_at as "createdAt",
           (select json_build_object('id', r.id, 'status', r.status, 'blocking', r.blocking, 'createdAt', r.created_at)
              from runs r where r.deployment_id = d.id order by r.created_at desc limit 1) as "lastRun"
         from deployments d left join environments e on e.id = d.environment_id
         where d.project_id = $1 order by d.created_at desc limit $2`,
        [req.params.projectId, limit],
      );
    });
    res.json({ deployments });
  }),
);
