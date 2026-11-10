/**
 * Test-account credentials for an environment (e.g. merchantA, merchantB, admin).
 * Secrets are write-only: stored envelope-encrypted, never returned by any
 * endpoint, never written to the audit log. Phase B gives runners a one-run
 * decrypted copy.
 */
import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { handle, notFound, validate } from "../../lib/http.js";
import { audit, deps, loadEnvironment, scoped } from "../../lib/context.js";

export const CredentialsRouter = Router({ mergeParams: true });

const zAccountName = z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "letters, digits, - and _ only, starting with a letter");
const zCredBody = z.object({
  name: zAccountName,
  role: z.string().trim().min(1).max(60),
  identifier: z.string().trim().min(1).max(254),
  device: z.string().trim().max(40).nullable().optional(),
  secret: z.string().min(1).max(1000),
});

const PUBLIC_COLUMNS = `id, name, role, identifier, device, created_at as "createdAt", updated_at as "updatedAt", last_used_at as "lastUsedAt"`;

CredentialsRouter.get(
  "/",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const credentials = await scoped(req, async (q) => {
      await loadEnvironment(q, req, req.params.projectId, req.params.environmentId);
      return q(`select ${PUBLIC_COLUMNS} from credentials where environment_id = $1 order by name`, [req.params.environmentId]);
    });
    res.json({ credentials });
  }),
);

CredentialsRouter.post(
  "/",
  auth("owner", "admin", "developer"),
  validate({ body: zCredBody }),
  handle(async (req, res) => {
    const b = req.body;
    const { vault } = deps(req);
    const credential = await scoped(req, async (q) => {
      await loadEnvironment(q, req, req.params.projectId, req.params.environmentId);
      const id = crypto.randomUUID();
      const blob = vault.encrypt(b.secret, `${req.member!.orgId}:${id}`);
      const [c] = await q(
        `insert into credentials (id, org_id, environment_id, name, role, identifier, device, secret_blob) values ($1, app_org(), $2, $3, $4, $5, $6, $7) returning ${PUBLIC_COLUMNS}`,
        [id, req.params.environmentId, b.name, b.role, b.identifier, b.device ?? null, blob],
      );
      await audit(q, req, "credential.created", "credential", id, { name: b.name, role: b.role, environmentId: req.params.environmentId });
      return c;
    });
    res.status(201).json({ credential });
  }),
);

CredentialsRouter.put(
  "/:credentialId",
  auth("owner", "admin", "developer"),
  validate({ body: zCredBody.omit({ name: true }).partial() }),
  handle(async (req, res) => {
    const b = req.body;
    const { vault } = deps(req);
    const credential = await scoped(req, async (q) => {
      await loadEnvironment(q, req, req.params.projectId, req.params.environmentId);
      const blob = b.secret ? vault.encrypt(b.secret, `${req.member!.orgId}:${req.params.credentialId}`) : null;
      const [c] = await q(
        `update credentials set role = coalesce($3, role), identifier = coalesce($4, identifier), device = case when $5::boolean then $6 else device end,
           secret_blob = coalesce($7, secret_blob), updated_at = now() where id = $1 and environment_id = $2 returning ${PUBLIC_COLUMNS}`,
        [req.params.credentialId, req.params.environmentId, b.role ?? null, b.identifier ?? null, b.device !== undefined, b.device ?? null, blob],
      );
      if (!c) throw notFound("Credential");
      await audit(q, req, "credential.updated", "credential", c.id, { fields: Object.keys(b).filter((k) => k !== "secret").concat(b.secret ? ["secret (changed)"] : []) });
      return c;
    });
    res.json({ credential });
  }),
);

CredentialsRouter.delete(
  "/:credentialId",
  auth("owner", "admin", "developer"),
  validate({}),
  handle(async (req, res) => {
    await scoped(req, async (q) => {
      await loadEnvironment(q, req, req.params.projectId, req.params.environmentId);
      const rows = await q("delete from credentials where id = $1 and environment_id = $2 returning name", [req.params.credentialId, req.params.environmentId]);
      if (!rows.length) throw notFound("Credential");
      await audit(q, req, "credential.deleted", "credential", req.params.credentialId, { name: rows[0].name });
    });
    res.status(204).end();
  }),
);
