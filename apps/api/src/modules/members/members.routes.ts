/**
 * Members of an organization (invites: ../invites).
 * Rules: only an owner can make or unmake owners; the last owner can't be
 * removed or demoted; admins can't touch owners; anyone can leave (except the
 * last owner). client_ids limits a member to some clients' projects.
 */
import { Router } from "express";
import { z } from "zod";
import { ROLES } from "@qa/shared";
import { auth } from "../../middleware/auth.js";
import { conflict, forbidden, handle, notFound, validate } from "../../lib/http.js";
import { assertClientsInOrg, zClientIds } from "./members.shared.js";
import { audit, scoped } from "../../lib/context.js";
import type { Query } from "../../db/index.js";

export const MembersRouter = Router({ mergeParams: true });


const ownerCount = async (q: Query) => (await q<{ n: number }>("select count(*)::int as n from memberships where org_id = app_org() and role = 'owner'"))[0].n;

MembersRouter.get(
  "/",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const members = await scoped(req, (q) =>
      q(
        "select u.id as \"userId\", u.name, u.email, m.role, m.client_ids as \"clientIds\", m.created_at as \"joinedAt\" from memberships m join users u on u.id = m.user_id where m.org_id = app_org() order by m.created_at",
      ),
    );
    res.json({ members });
  }),
);

MembersRouter.patch(
  "/:userId",
  auth("owner", "admin"),
  validate({ body: z.object({ role: z.enum(ROLES).optional(), clientIds: zClientIds }) }),
  handle(async (req, res) => {
    const me = req.member!;
    const member = await scoped(req, async (q) => {
      const [target] = await q<{ role: string }>("select role from memberships where org_id = app_org() and user_id = $1", [req.params.userId]);
      if (!target) throw notFound("Member");
      const touchesOwner = target.role === "owner" || req.body.role === "owner";
      if (touchesOwner && me.role !== "owner") throw forbidden("Only an owner can change owners");
      if (target.role === "owner" && req.body.role && req.body.role !== "owner" && (await ownerCount(q)) <= 1) throw conflict("An organization needs at least one owner");
      await assertClientsInOrg(q, req.body.clientIds);
      const [m] = await q(
        "update memberships set role = coalesce($2, role), client_ids = case when $3::boolean then $4::uuid[] else client_ids end where org_id = app_org() and user_id = $1 returning user_id as \"userId\", role, client_ids as \"clientIds\"",
        [req.params.userId, req.body.role ?? null, req.body.clientIds !== undefined, req.body.clientIds ?? null],
      );
      await audit(q, req, "member.updated", "user", req.params.userId, { role: req.body.role, clientIds: req.body.clientIds });
      return m;
    });
    res.json({ member });
  }),
);

MembersRouter.delete(
  "/:userId",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const me = req.member!;
    const self = req.params.userId === req.user!.id;
    if (!self && me.role !== "owner" && me.role !== "admin") throw forbidden();
    await scoped(req, async (q) => {
      const [target] = await q<{ role: string }>("select role from memberships where org_id = app_org() and user_id = $1", [req.params.userId]);
      if (!target) throw notFound("Member");
      if (target.role === "owner" && !self && me.role !== "owner") throw forbidden("Only an owner can remove an owner");
      if (target.role === "owner" && (await ownerCount(q)) <= 1) throw conflict("An organization needs at least one owner");
      await q("delete from memberships where org_id = app_org() and user_id = $1", [req.params.userId]);
      await audit(q, req, self ? "member.left" : "member.removed", "user", req.params.userId);
    });
    res.status(204).end();
  }),
);

