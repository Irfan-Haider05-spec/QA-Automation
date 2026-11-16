import { Router, type Request } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { audit, deps, loadProject, scoped } from "../../lib/context.js";
import { ApiError, handle, notFound, query, validate } from "../../lib/http.js";
import type { Query } from "../../db/index.js";

export const CollaborationRouter = Router({ mergeParams: true });
type CommentCursor = { createdAt: string; id?: string };

function parseCommentCursor(value: string | undefined): CommentCursor | null {
  if (!value) return null;
  if (value.startsWith("c:")) {
    try {
      const parsed = JSON.parse(Buffer.from(value.slice(2), "base64url").toString("utf8"));
      if (typeof parsed.createdAt === "string" && z.string().datetime().safeParse(parsed.createdAt).success && z.string().uuid().safeParse(parsed.id).success) {
        return { createdAt: parsed.createdAt, id: parsed.id };
      }
    } catch { /* reported below */ }
    throw new ApiError(400, "validation_error", "Invalid comment cursor");
  }
  // Keep accepting timestamp-only cursors issued by older clients.
  if (!z.string().datetime().safeParse(value).success) throw new ApiError(400, "validation_error", "Invalid comment cursor");
  return { createdAt: value };
}

async function issue(q: Query, req: Request) {
  await loadProject(q, req, req.params.projectId);
  const [row] = await q("select id, fingerprint, title, target, plugin, severity, status from issues where id = $1 and project_id = $2", [req.params.issueId, req.params.projectId]);
  if (!row) throw notFound("Issue");
  return row;
}

CollaborationRouter.get("/issues/:issueId/comments", auth(), validate({ query: z.object({ before: z.string().optional() }) }), handle(async (req, res) => {
  const { before } = query<{ before?: string }>(req);
  if (before && before.length > 1024) throw new ApiError(400, "validation_error", "Invalid comment cursor");
  const cursor = parseCommentCursor(before);
  const comments = await scoped(req, async (q) => {
    await issue(q, req);
    return q(`select c.id, c.body, c.author_id as "authorId", u.name as "authorName", c.created_at as "createdAt",
      to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorCreatedAt"
      from issue_comments c left join users u on u.id = c.author_id where c.issue_id = $1
      and ($2::timestamptz is null or ($3::uuid is null and c.created_at < $2) or (c.created_at, c.id) < ($2::timestamptz, $3::uuid))
      order by c.created_at desc, c.id desc limit 100`, [req.params.issueId, cursor?.createdAt ?? null, cursor?.id ?? null]);
  });
  const last = comments.at(-1);
  const nextBefore = comments.length === 100 && last
    ? `c:${Buffer.from(JSON.stringify({ createdAt: last.cursorCreatedAt, id: last.id })).toString("base64url")}`
    : null;
  res.json({ comments, nextBefore });
}));
CollaborationRouter.post("/issues/:issueId/comments", auth("owner", "admin", "developer"), validate({ body: z.object({ body: z.string().trim().min(1).max(4000) }).strict() }), handle(async (req, res) => {
  const comment = await scoped(req, async (q) => {
    await issue(q, req);
    const [row] = await q("insert into issue_comments(org_id, issue_id, author_id, body) values(app_org(), $1, app_user(), $2) returning id", [req.params.issueId, req.body.body]);
    await audit(q, req, "issue.commented", "issue", req.params.issueId, { commentId: row.id });
    return row;
  });
  res.status(201).json({ comment });
}));
CollaborationRouter.delete("/issues/:issueId/comments/:commentId", auth("owner", "admin", "developer"), validate({}), handle(async (req, res) => {
  await scoped(req, async (q) => {
    await issue(q, req);
    const [row] = await q("delete from issue_comments where id = $1 and issue_id = $2 and (author_id = app_user() or $3) returning id", [req.params.commentId, req.params.issueId, ["owner", "admin"].includes(req.member!.role)]);
    if (!row) throw notFound("Comment");
    await audit(q, req, "issue.comment_deleted", "issue", req.params.issueId, { commentId: row.id });
  });
  res.status(204).end();
}));

CollaborationRouter.get("/integration", auth("owner", "admin", "developer"), validate({}), handle(async (req, res) => {
  const integration = await scoped(req, async (q) => { await loadProject(q, req, req.params.projectId); return (await q("select destination, enabled from issue_integrations where project_id = $1", [req.params.projectId]))[0] ?? null; });
  res.json({ integration, configured: !!(deps(req).config.ISSUE_GATEWAY_URL && deps(req).config.ISSUE_GATEWAY_TOKEN) });
}));
CollaborationRouter.put("/integration", auth("owner", "admin"), validate({ body: z.object({ destination: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_./:-]+$/), enabled: z.boolean() }).strict() }), handle(async (req, res) => {
  await scoped(req, async (q) => {
    await loadProject(q, req, req.params.projectId);
    await q("insert into issue_integrations(org_id, project_id, destination, enabled) values(app_org(),$1,$2,$3) on conflict(project_id) do update set destination=excluded.destination, enabled=excluded.enabled", [req.params.projectId, req.body.destination, req.body.enabled]);
    await audit(q, req, "issue.integration_updated", "project", req.params.projectId, { enabled: req.body.enabled });
  });
  res.json({ ok: true });
}));
CollaborationRouter.get("/issues/:issueId/sync", auth(), validate({}), handle(async (req, res) => {
  const deliveries = await scoped(req, async (q) => { await issue(q, req); return q(`select id, status, attempts, remote_url as "remoteUrl", last_error as "lastError", created_at as "createdAt" from issue_sync_jobs where issue_id = $1 order by created_at desc limit 10`, [req.params.issueId]); });
  res.json({ deliveries });
}));
CollaborationRouter.post("/issues/:issueId/sync", auth("owner", "admin", "developer"), validate({ body: z.object({}).strict() }), handle(async (req, res) => {
  const config = deps(req).config;
  if (!config.ISSUE_GATEWAY_URL || !config.ISSUE_GATEWAY_TOKEN) throw new ApiError(503, "integration_disabled", "Issue integration is not configured");
  const delivery = await scoped(req, async (q) => {
    const data = await issue(q, req);
    const [integration] = await q("select destination from issue_integrations where project_id = $1 and enabled", [req.params.projectId]);
    if (!integration) throw new ApiError(422, "integration_disabled", "Enable this project's issue integration first");
    let [row] = await q("insert into issue_sync_jobs(org_id, issue_id, project_id, destination, payload) values(app_org(),$1,$2,$3,$4) on conflict (issue_id) where status in ('queued','sending') do nothing returning id, status", [data.id, req.params.projectId, integration.destination, JSON.stringify(data)]);
    if (!row) {
      [row] = await q("select id, status from issue_sync_jobs where issue_id = $1 and status in ('queued','sending') order by created_at desc limit 1", [data.id]);
    } else {
      await audit(q, req, "issue.sync_requested", "issue", data.id, { deliveryId: row.id });
    }
    if (!row) throw new ApiError(409, "sync_conflict", "Issue delivery could not be queued");
    return row;
  });
  res.status(202).json({ delivery });
}));
