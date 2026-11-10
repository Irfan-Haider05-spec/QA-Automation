/**
 * Clients: an agency's customers. Members limited to some clients only see those.
 */
import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { conflict, handle, notFound, validate, zName } from "../../lib/http.js";
import { audit, scoped } from "../../lib/context.js";

export const ClientsRouter = Router({ mergeParams: true });

ClientsRouter.get(
  "/",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const scope = req.member!.clientIds;
    const clients = await scoped(req, (q) =>
      q(
        "select c.id, c.name, c.created_at as \"createdAt\", (select count(*)::int from projects p where p.client_id = c.id) as \"projectCount\" from clients c where ($1::uuid[] is null or c.id = any($1::uuid[])) order by lower(c.name)",
        [scope],
      ),
    );
    res.json({ clients });
  }),
);

ClientsRouter.post(
  "/",
  auth("owner", "admin"),
  validate({ body: z.object({ name: zName }) }),
  handle(async (req, res) => {
    const client = await scoped(req, async (q) => {
      const [c] = await q("insert into clients (org_id, name) values (app_org(), $1) returning id, name, created_at as \"createdAt\"", [req.body.name]);
      await audit(q, req, "client.created", "client", c.id, { name: req.body.name });
      return c;
    });
    res.status(201).json({ client });
  }),
);

ClientsRouter.patch(
  "/:clientId",
  auth("owner", "admin"),
  validate({ body: z.object({ name: zName }) }),
  handle(async (req, res) => {
    const client = await scoped(req, async (q) => {
      const [c] = await q("update clients set name = $1 where id = $2 returning id, name", [req.body.name, req.params.clientId]);
      if (!c) throw notFound("Client");
      await audit(q, req, "client.updated", "client", c.id, { name: req.body.name });
      return c;
    });
    res.json({ client });
  }),
);

ClientsRouter.delete(
  "/:clientId",
  auth("owner", "admin"),
  validate({}),
  handle(async (req, res) => {
    await scoped(req, async (q) => {
      const [{ n }] = await q<{ n: number }>("select count(*)::int as n from projects where client_id = $1", [req.params.clientId]);
      if (n > 0) throw conflict(`Move or delete this client's ${n} project(s) first`);
      const rows = await q("delete from clients where id = $1 returning id", [req.params.clientId]);
      if (!rows.length) throw notFound("Client");
      await audit(q, req, "client.deleted", "client", req.params.clientId);
    });
    res.status(204).end();
  }),
);
