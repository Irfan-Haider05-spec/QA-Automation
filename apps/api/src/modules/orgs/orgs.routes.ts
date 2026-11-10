import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { handle, notFound, validate, zName } from "../../lib/http.js";
import { audit, deps, scoped } from "../../lib/context.js";
import { withContext } from "../../db/index.js";

const router = Router();

router.get(
  "/",
  auth(),
  handle(async (req, res) => {
    const orgs = await scoped(req, (q) =>
      q("select o.id, o.name, m.role, m.client_ids as \"clientIds\", o.created_at as \"createdAt\" from memberships m join orgs o on o.id = m.org_id where m.user_id = $1 order by o.created_at", [req.user!.id]),
    );
    res.json({ orgs });
  }),
);

router.post(
  "/",
  auth(),
  validate({ body: z.object({ name: zName }) }),
  handle(async (req, res) => {
    const orgId = crypto.randomUUID();
    const org = await withContext(deps(req).db, { orgId, userId: req.user!.id }, async (q) => {
      const [o] = await q("insert into orgs (id, name, created_by) values ($1, $2, $3) returning id, name, created_at as \"createdAt\"", [orgId, req.body.name, req.user!.id]);
      await q("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, req.user!.id]);
      await audit(q, req, "org.created", "org", orgId);
      return o;
    });
    res.status(201).json({ org: { ...org, role: "owner" } });
  }),
);

/** First-run checklist: which setup steps this organization has done */
router.get(
  "/:orgId/onboarding",
  auth("owner", "admin"),
  handle(async (req, res) => {
    const out = await scoped(req, async (q) => {
      const [r] = await q(`select
        (select id from projects order by created_at limit 1) as "firstProjectId",
        (select count(*)::int from projects) as projects,
        (select count(*)::int from environments) as environments,
        (select count(*)::int from environments where verified_at is not null) as verified,
        (select count(*)::int from credentials) as accounts,
        (select count(*)::int from api_keys where revoked_at is null) as keys,
        (select count(*)::int from schedules) as schedules,
        (select count(*)::int from runs) as runs,
        (select count(*)::int from notification_channels) as channels,
        (select count(*)::int from memberships) as members,
        (select count(*)::int from invites where accepted_at is null and expires_at > now()) as invites`);
      return r;
    });
    const steps = {
      project: out.projects > 0,
      environment: out.environments > 0,
      verified: out.verified > 0,
      accounts: out.accounts > 0,
      connected: out.keys > 0 || out.schedules > 0,
      firstRun: out.runs > 0,
      notifications: out.channels > 0,
      team: out.members > 1 || out.invites > 0,
    };
    res.json({ steps, firstProjectId: out.firstProjectId ?? null, done: Object.values(steps).filter(Boolean).length, total: Object.keys(steps).length });
  }),
);

router.get(
  "/:orgId",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const out = await scoped(req, async (q) => {
      const [o] = await q("select id, name, created_at as \"createdAt\" from orgs where id = $1", [req.params.orgId]);
      if (!o) throw notFound("Organization");
      const [counts] = await q(
        "select (select count(*)::int from memberships) as members, (select count(*)::int from clients) as clients, (select count(*)::int from projects) as projects",
      );
      return { ...o, role: req.member!.role, clientIds: req.member!.clientIds, counts };
    });
    res.json({ org: out });
  }),
);

router.patch(
  "/:orgId",
  auth("owner", "admin"),
  validate({ body: z.object({ name: zName }) }),
  handle(async (req, res) => {
    const org = await scoped(req, async (q) => {
      const [o] = await q("update orgs set name = $1 where id = $2 returning id, name", [req.body.name, req.params.orgId]);
      await audit(q, req, "org.updated", "org", req.params.orgId, { name: req.body.name });
      return o;
    });
    res.json({ org });
  }),
);

router.delete(
  "/:orgId",
  auth("owner"),
  validate({}),
  handle(async (req, res) => {
    await scoped(req, (q) => q("delete from orgs where id = $1", [req.params.orgId]));
    res.status(204).end();
  }),
);

export const OrgRoutes = router;
