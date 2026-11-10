/**
 * Invites to an organization. The token ("<orgId>.<inviteId>.<secret>") is shown
 * once; only its hash is stored.
 */
import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { conflict, handle, notFound, validate, zEmail } from "../../lib/http.js";
import { audit, deps, scoped } from "../../lib/context.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { assertClientsInOrg, zClientIds } from "../members/members.shared.js";

export const InvitesRouter = Router({ mergeParams: true });

InvitesRouter.get(
  "/",
  auth("owner", "admin"),
  validate({}),
  handle(async (req, res) => {
    const invites = await scoped(req, (q) =>
      q("select id, email, role, client_ids as \"clientIds\", expires_at as \"expiresAt\", created_at as \"createdAt\" from invites where accepted_at is null and expires_at > now() order by created_at desc"),
    );
    res.json({ invites });
  }),
);

InvitesRouter.post(
  "/",
  auth("owner", "admin"),
  validate({ body: z.object({ email: zEmail, role: z.enum(["admin", "developer", "viewer"]), clientIds: zClientIds }) }),
  handle(async (req, res) => {
    const secret = randomToken(24);
    const out = await scoped(req, async (q) => {
      await assertClientsInOrg(q, req.body.clientIds);
      const [already] = await q("select 1 from memberships m join users u on u.id = m.user_id where m.org_id = app_org() and lower(u.email) = $1", [req.body.email]);
      if (already) throw conflict("This person is already a member");
      const [inv] = await q(
        "insert into invites (org_id, email, role, client_ids, token_hash, invited_by, expires_at) values (app_org(), $1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning id, email, role, client_ids as \"clientIds\", expires_at as \"expiresAt\"",
        [req.body.email, req.body.role, req.body.clientIds ?? null, sha256(secret), req.user!.id, deps(req).config.INVITE_TTL_DAYS],
      );
      await audit(q, req, "invite.created", "invite", inv.id, { email: req.body.email, role: req.body.role });
      return inv;
    });
    // The token is shown once. Phase B emails it; until then the inviter shares it.
    res.status(201).json({ invite: out, token: `${req.member!.orgId}.${out.id}.${secret}` });
  }),
);

InvitesRouter.delete(
  "/:inviteId",
  auth("owner", "admin"),
  validate({}),
  handle(async (req, res) => {
    const n = await scoped(req, async (q) => {
      const rows = await q("delete from invites where id = $1 and accepted_at is null returning id", [req.params.inviteId]);
      if (rows.length) await audit(q, req, "invite.revoked", "invite", req.params.inviteId);
      return rows.length;
    });
    if (!n) throw notFound("Invite");
    res.status(204).end();
  }),
);

