import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { handle, query, validate } from "../../lib/http.js";
import { scoped } from "../../lib/context.js";

export const AuditRouter = Router({ mergeParams: true });

AuditRouter.get(
  "/",
  auth("owner", "admin"),
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.string().datetime().optional() }) }),
  handle(async (req, res) => {
    const { limit, before } = query<{ limit: number; before?: string }>(req);
    const events = await scoped(req, (q) =>
      q(
        `select a.id, a.action, a.entity_type as "entityType", a.entity_id as "entityId", a.data, a.created_at as "createdAt",
           a.actor_user_id as "actorUserId", u.name as "actorName", a.actor_api_key_id as "actorApiKeyId"
         from audit_events a left join users u on u.id = a.actor_user_id
         where ($1::timestamptz is null or a.created_at < $1) order by a.created_at desc limit $2`,
        [before ?? null, limit],
      ),
    );
    res.json({ events, nextBefore: events.length === limit ? events[events.length - 1].createdAt : null });
  }),
);
