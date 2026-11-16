import { Router, type Request } from "express";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { authApiKey } from "../../middleware/auth.js";
import { audit, deps, scoped } from "../../lib/context.js";
import { ApiError, badRequest, handle, notFound, validate } from "../../lib/http.js";
import type { Query } from "../../db/index.js";
import { artifactQuota } from "../../lib/billing.js";

export const ArtifactUploadRouter = Router();
export const ArtifactUploadSchema = z.object({ name: z.string().min(1).max(180).regex(/^[a-zA-Z0-9_./-]+$/).refine((p) => !p.startsWith("/") && !p.split("/").some((s) => !s || s === ".." || s === "."), "Expected a relative artifact name"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), data: z.string().min(4).max(6990508).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict();

export async function storeArtifact(req: Request, runId: string, projectId: string, orgId: string, scope: <T>(fn: (q: Query) => Promise<T>) => Promise<T>) {
  const store = deps(req).artifacts;
  if (!store) throw new ApiError(503, "storage_disabled", "Evidence storage is not configured");
  const bytes = Buffer.from(req.body.data, "base64");
  if (!bytes.length || bytes.length > 5242880 || bytes.toString("base64") !== req.body.data) throw badRequest("Invalid artifact encoding or size");
  if (createHash("sha256").update(bytes).digest("hex") !== req.body.sha256) throw badRequest("Artifact checksum mismatch");
  const artifact = await scope(async (q) => {
    const [run] = await q("select id from runs where id = $1 and project_id = $2 for update", [runId, projectId]);
    if (!run) throw notFound("Run");
    const retentionDays = Math.min(await artifactQuota(q, bytes.length, deps(req).config), deps(req).config.ARTIFACT_RETENTION_DAYS);
    const [{ count }] = await q<{ count: number }>("select count(*)::int as count from artifacts where run_id = $1", [run.id]);
    if (count >= 100) throw badRequest("A run can hold at most 100 artifacts");
    const [existing] = await q("select id from artifacts where run_id = $1 and name = $2", [run.id, req.body.name]);
    if (existing) throw badRequest("Artifact name already exists; uploaded evidence is immutable");
    const id = randomUUID();
    const objectKey = `${orgId}/${projectId}/${run.id}/${id}`;
    await q("insert into artifacts (id, org_id, project_id, run_id, name, object_key, sha256, size_bytes, expires_at) values ($1, app_org(), $2, $3, $4, $5, $6, $7, now() + $8 * interval '1 day')",
      [id, projectId, run.id, req.body.name, objectKey, req.body.sha256, bytes.length, retentionDays]);
    await audit(q, req, "artifact.created", "artifact", id, { runId: run.id, bytes: bytes.length });
    return { id, objectKey };
  });
  try {
    await store.put(artifact.objectKey, bytes, req.body.name);
    const updated = await scope((q) => q("update artifacts set state = 'ready' where id = $1 and run_id is not null returning id", [artifact.id]));
    if (!updated.length) { await store.delete(artifact.objectKey); throw new Error("Run was deleted during upload"); }
  } catch {
    // Retain the key even if S3 accepted the object but its response was lost.
    await scope((q) => q("update artifacts set expires_at = now() where id = $1", [artifact.id]));
    throw new ApiError(502, "storage_error", "Evidence upload failed; cleanup is queued");
  }
  return { id: artifact.id };
}

ArtifactUploadRouter.post("/runs/:runId/artifacts", authApiKey("runs:write"), validate({ body: ArtifactUploadSchema }), handle(async (req, res) => {
  const r = req.runner!;
  res.status(201).json(await storeArtifact(req, req.params.runId, r.projectId, r.orgId, (fn) => scoped(req, fn)));
}));
