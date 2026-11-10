/**
 * Accepting an invite: the logged-in user must have the invited email address.
 */
import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { ApiError, conflict, handle, isUuid, validate } from "../../lib/http.js";
import { deps } from "../../lib/context.js";
import { sha256, safeEqualHex } from "../../lib/crypto.js";
import { withContext } from "../../db/index.js";

export const InviteAcceptRouter = Router();

InviteAcceptRouter.post(
  "/accept",
  auth(),
  validate({ body: z.object({ token: z.string().min(40).max(300) }) }),
  handle(async (req, res) => {
    const [orgId, inviteId, secret] = req.body.token.split(".");
    const invalid = new ApiError(400, "invalid_invite", "This invite link is not valid or has expired");
    if (!isUuid(orgId) || !isUuid(inviteId) || !secret) throw invalid;
    const out = await withContext(deps(req).db, { orgId, userId: req.user!.id }, async (q) => {
      const [inv] = await q("select * from invites where id = $1", [inviteId]);
      if (!inv || inv.accepted_at || new Date(inv.expires_at) < new Date() || !safeEqualHex(inv.token_hash, sha256(secret))) throw invalid;
      const [user] = await q("select email from users where id = $1", [req.user!.id]);
      if (user.email.toLowerCase() !== inv.email.toLowerCase()) throw new ApiError(403, "wrong_account", `This invite is for ${inv.email}. Log in with that account to accept it.`);
      const inserted = await q("insert into memberships (org_id, user_id, role, client_ids) values ($1, $2, $3, $4) on conflict do nothing returning role", [orgId, req.user!.id, inv.role, inv.client_ids]);
      if (!inserted.length) throw conflict("You are already a member of this organization");
      await q("update invites set accepted_at = now() where id = $1", [inviteId]);
      await q("insert into audit_events (org_id, actor_user_id, action, entity_type, entity_id) values ($1, $2, 'invite.accepted', 'invite', $3)", [orgId, req.user!.id, inviteId]);
      const [org] = await q("select id, name from orgs where id = $1", [orgId]);
      return { org: { ...org, role: inv.role, clientIds: inv.client_ids } };
    });
    res.json(out);
  }),
);
