/**
 * Projects (one codebase/product under test). A member limited to some clients
 * can only see and create projects of those clients.
 */
import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { badRequest, handle, validate, zName } from "../../lib/http.js";
import { audit, loadProject, scoped } from "../../lib/context.js";
import type { Query } from "../../db/index.js";

export const ProjectsRouter = Router({ mergeParams: true });

const STACKS = ["node-express", "nestjs", "fastapi", "django", "laravel", "openapi-only", "other"] as const;
const zProjectBody = z.object({
  name: zName,
  clientId: z.string().uuid().nullable().optional(),
  repoUrl: z.string().url().max(500).nullable().optional(),
  stack: z.enum(STACKS).optional(),
});

const PROJECT_COLUMNS = `p.id, p.name, p.client_id as "clientId", c.name as "clientName", p.repo_url as "repoUrl", p.stack, p.created_at as "createdAt", p.updated_at as "updatedAt",
  (select json_build_object('id', r.id, 'status', r.status, 'suite', r.suite, 'createdAt', r.created_at) from runs r where r.project_id = p.id order by r.created_at desc limit 1) as "lastRun",
  (select coalesce(json_agg(json_build_object('id', x.id, 'status', x.status, 'suite', x.suite, 'blocking', x.blocking, 'createdAt', x.created_at) order by x.created_at), '[]'::json)
     from (select id, status, suite, blocking, created_at from runs r where r.project_id = p.id order by r.created_at desc limit 14) x) as "recentRuns",
  (select count(*)::int from issues i where i.project_id = p.id and i.status = 'open') as "openIssues",
  (select count(*)::int from issues i where i.project_id = p.id and i.status = 'open' and i.severity = 'critical') as "openCritical"`;

async function checkClient(q: Query, clientId: string | null | undefined, scope: string[] | null) {
  if (scope && !clientId) throw badRequest("Pick one of your clients for this project");
  if (!clientId) return;
  if (scope && !scope.includes(clientId)) throw badRequest("You can only use clients you have access to");
  const [c] = await q("select id from clients where id = $1", [clientId]);
  if (!c) throw badRequest("clientId doesn't exist in this organization");
}

ProjectsRouter.get(
  "/",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const projects = await scoped(req, (q) =>
      q(`select ${PROJECT_COLUMNS} from projects p left join clients c on c.id = p.client_id where ($1::uuid[] is null or p.client_id = any($1::uuid[])) order by lower(p.name)`, [req.member!.clientIds]),
    );
    res.json({ projects });
  }),
);

ProjectsRouter.post(
  "/",
  auth("owner", "admin", "developer"),
  validate({ body: zProjectBody }),
  handle(async (req, res) => {
    const b = req.body;
    const project = await scoped(req, async (q) => {
      await checkClient(q, b.clientId, req.member!.clientIds);
      const [p] = await q("insert into projects (org_id, client_id, name, repo_url, stack) values (app_org(), $1, $2, $3, coalesce($4, 'node-express')) returning id", [b.clientId ?? null, b.name, b.repoUrl ?? null, b.stack ?? null]);
      await audit(q, req, "project.created", "project", p.id, { name: b.name });
      const [full] = await q(`select ${PROJECT_COLUMNS} from projects p left join clients c on c.id = p.client_id where p.id = $1`, [p.id]);
      return full;
    });
    res.status(201).json({ project });
  }),
);

ProjectsRouter.get(
  "/:projectId",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const project = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      const [p] = await q(`select ${PROJECT_COLUMNS} from projects p left join clients c on c.id = p.client_id where p.id = $1`, [req.params.projectId]);
      const environments = await q("select id, name, api_base_url as \"apiBaseUrl\", disposable, verified_at as \"verifiedAt\" from environments where project_id = $1 order by created_at", [req.params.projectId]);
      return { ...p, environments };
    });
    res.json({ project });
  }),
);

ProjectsRouter.patch(
  "/:projectId",
  auth("owner", "admin", "developer"),
  validate({ body: zProjectBody.partial() }),
  handle(async (req, res) => {
    const b = req.body;
    const project = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      if (b.clientId !== undefined) await checkClient(q, b.clientId, req.member!.clientIds);
      await q(
        `update projects set name = coalesce($2, name), repo_url = case when $3::boolean then $4 else repo_url end,
           client_id = case when $5::boolean then $6::uuid else client_id end, stack = coalesce($7, stack), updated_at = now() where id = $1`,
        [req.params.projectId, b.name ?? null, b.repoUrl !== undefined, b.repoUrl ?? null, b.clientId !== undefined, b.clientId ?? null, b.stack ?? null],
      );
      await audit(q, req, "project.updated", "project", req.params.projectId, b);
      const [p] = await q(`select ${PROJECT_COLUMNS} from projects p left join clients c on c.id = p.client_id where p.id = $1`, [req.params.projectId]);
      return p;
    });
    res.json({ project });
  }),
);

ProjectsRouter.delete(
  "/:projectId",
  auth("owner", "admin"),
  validate({}),
  handle(async (req, res) => {
    await scoped(req, async (q) => {
      const p = await loadProject(q, req, req.params.projectId);
      await q("delete from projects where id = $1", [p.id]);
      await audit(q, req, "project.deleted", "project", p.id, { name: p.name });
    });
    res.status(204).end();
  }),
);
