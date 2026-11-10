/**
 * Project API keys, used by runners (CLI, GitHub Action, hosted runner) to upload
 * results. The key is shown once; only its SHA-256 hash and a short prefix are stored.
 */
import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { API_KEY_SCOPES } from "@qa/shared";
import { forbidden, handle, notFound, validate, zName } from "../../lib/http.js";
import { audit, loadProject, scoped } from "../../lib/context.js";
import { newApiKey } from "../../lib/crypto.js";

export const ApiKeysRouter = Router({ mergeParams: true });

const COLUMNS = `id, name, prefix, scopes, created_at as "createdAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt"`;

ApiKeysRouter.get(
  "/",
  auth("owner", "admin", "developer"),
  validate({}),
  handle(async (req, res) => {
    const apiKeys = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      return q(`select ${COLUMNS} from api_keys where project_id = $1 order by created_at desc`, [req.params.projectId]);
    });
    res.json({ apiKeys });
  }),
);

ApiKeysRouter.post(
  "/",
  auth("owner", "admin", "developer"),
  validate({ body: z.object({ name: zName, scopes: z.array(z.enum(API_KEY_SCOPES)).max(API_KEY_SCOPES.length).optional() }) }),
  handle(async (req, res) => {
    const scopes = [...new Set<string>(["runs:write", ...(req.body.scopes ?? [])])];
    // A key that can read passwords is as sensitive as the passwords: developers can set secrets but never read them back
    if (scopes.includes("credentials:read") && !["owner", "admin"].includes(req.member!.role)) throw forbidden("Only owners and admins can create keys that read test-account passwords");
    const k = newApiKey();
    const apiKey = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      const [row] = await q(`insert into api_keys (org_id, project_id, name, prefix, key_hash, created_by, scopes) values (app_org(), $1, $2, $3, $4, $5, $6) returning ${COLUMNS}`, [
        req.params.projectId, req.body.name, k.prefix, k.hash, req.user!.id, scopes,
      ]);
      await audit(q, req, "api_key.created", "api_key", row.id, { name: req.body.name, prefix: k.prefix, scopes });
      return row;
    });
    res.status(201).json({ apiKey, key: k.key });
  }),
);

ApiKeysRouter.delete(
  "/:apiKeyId",
  auth("owner", "admin", "developer"),
  validate({}),
  handle(async (req, res) => {
    await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      const rows = await q("update api_keys set revoked_at = now() where id = $1 and project_id = $2 and revoked_at is null returning id", [req.params.apiKeyId, req.params.projectId]);
      if (!rows.length) throw notFound("API key");
      await audit(q, req, "api_key.revoked", "api_key", req.params.apiKeyId);
    });
    res.status(204).end();
  }),
);
