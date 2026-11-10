/**
 * Notification channels of an organization: Slack, email, signed webhooks.
 *
 *   GET    /orgs/:orgId/notifications                      channels (secrets never returned)
 *   POST   /orgs/:orgId/notifications                      new channel; a webhook's signing secret is shown once
 *   PATCH  /orgs/:orgId/notifications/:channelId
 *   DELETE /orgs/:orgId/notifications/:channelId
 *   POST   /orgs/:orgId/notifications/:channelId/test      send a sample message now
 *   GET    /orgs/:orgId/notifications/:channelId/deliveries the last 20 messages and what happened
 */
import crypto from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { NOTIFY_EVENTS } from "@qa/shared";
import { auth } from "../../middleware/auth.js";
import { handle, notFound, unprocessable, validate, zEmail, zName } from "../../lib/http.js";
import { audit, deps, scoped } from "../../lib/context.js";
import type { Query } from "../../db/index.js";
import { assertOutboundUrl, urlHint } from "../../lib/outbound.js";
import { sendNotification } from "../../lib/notify/send.js";
import type { NotifyPayload } from "../../lib/notify/events.js";

export const NotificationsRouter = Router({ mergeParams: true });

const COLUMNS = `id, name, kind, recipients, target_hint as "targetHint", events, project_ids as "projectIds", include_local as "includeLocal",
  enabled, last_delivery_at as "lastDeliveryAt", last_error as "lastError", created_at as "createdAt"`;

const zEvents = z.array(z.enum(NOTIFY_EVENTS)).min(1).max(NOTIFY_EVENTS.length).transform((e) => [...new Set(e)]);
const zProjects = z.array(z.string().uuid()).max(200).nullable();

async function checkProjects(q: Query, ids: string[] | null | undefined) {
  if (!ids?.length) return;
  const rows = await q("select id from projects where id = any($1::uuid[])", [ids]);
  if (rows.length !== new Set(ids).size) throw notFound("Project");
}

async function sealUrl(req: Request, kind: "slack" | "webhook", url: string, channelId: string, signingSecret?: string) {
  const { config, vault } = deps(req);
  await assertOutboundUrl(url, { allowPrivate: config.ALLOW_PRIVATE_WEBHOOKS, slack: kind === "slack" });
  return { blob: vault.encrypt(JSON.stringify({ url, ...(signingSecret ? { signingSecret } : {}) }), `${req.member!.orgId}:${channelId}`), hint: urlHint(url) };
}

NotificationsRouter.get(
  "/",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const channels = await scoped(req, (q) => q(`select ${COLUMNS} from notification_channels order by created_at`));
    res.json({ channels, emailAvailable: !!deps(req).config.SMTP_URL });
  }),
);

NotificationsRouter.post(
  "/",
  auth("owner", "admin"),
  validate({
    body: z.object({
      name: zName, kind: z.enum(["slack", "email", "webhook"]), url: z.string().trim().max(1000).optional(),
      recipients: z.array(zEmail).min(1).max(20).optional(), events: zEvents, projectIds: zProjects.default(null), includeLocal: z.boolean().default(false),
    }),
  }),
  handle(async (req, res) => {
    const b = req.body;
    const id = crypto.randomUUID();
    let blob: string | null = null;
    let hint: string | null = null;
    let signingSecret: string | undefined;
    if (b.kind === "email") {
      if (!deps(req).config.SMTP_URL) throw unprocessable("Email isn't set up on this platform yet. Use Slack or a webhook, or ask the platform admin to set SMTP_URL.");
      if (!b.recipients?.length) throw unprocessable("Add at least one email address");
      hint = b.recipients.join(", ");
    } else {
      if (!b.url) throw unprocessable(b.kind === "slack" ? "Paste the Slack incoming-webhook URL" : "Add the webhook URL");
      if (b.kind === "webhook") signingSecret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
      ({ blob, hint } = await sealUrl(req, b.kind, b.url, id, signingSecret));
    }
    const channel = await scoped(req, async (q) => {
      await checkProjects(q, b.projectIds);
      const [row] = await q(
        `insert into notification_channels (id, org_id, name, kind, recipients, secret_blob, target_hint, events, project_ids, include_local, created_by)
         values ($1, app_org(), $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${COLUMNS}`,
        [id, b.name, b.kind, b.kind === "email" ? b.recipients : null, blob, hint, b.events, b.projectIds, b.includeLocal, req.user!.id],
      );
      await audit(q, req, "notification.created", "notification_channel", id, { name: b.name, kind: b.kind, events: b.events });
      return row;
    });
    res.status(201).json({ channel, ...(signingSecret ? { signingSecret } : {}) });
  }),
);

NotificationsRouter.patch(
  "/:channelId",
  auth("owner", "admin"),
  validate({
    body: z.object({
      name: zName.optional(), url: z.string().trim().max(1000).optional(), recipients: z.array(zEmail).min(1).max(20).optional(),
      events: zEvents.optional(), projectIds: zProjects.optional(), includeLocal: z.boolean().optional(), enabled: z.boolean().optional(),
    }).refine((b) => Object.keys(b).length > 0, "Nothing to change"),
  }),
  handle(async (req, res) => {
    const b = req.body;
    const channel = await scoped(req, async (q) => {
      const [cur] = await q<{ id: string; kind: "slack" | "email" | "webhook"; secret_blob: string | null }>("select id, kind, secret_blob from notification_channels where id = $1", [req.params.channelId]);
      if (!cur) throw notFound("Channel");
      await checkProjects(q, b.projectIds);
      let blob = cur.secret_blob;
      let hint: string | null = null;
      if (b.url !== undefined && cur.kind !== "email") {
        // Keep the webhook's signing secret when only the URL changes
        const old = cur.secret_blob ? JSON.parse(deps(req).vault.decrypt(cur.secret_blob, `${req.member!.orgId}:${cur.id}`)) : {};
        ({ blob, hint } = await sealUrl(req, cur.kind, b.url, cur.id, old.signingSecret));
      }
      if (b.recipients && cur.kind === "email") hint = b.recipients.join(", ");
      const [row] = await q(
        `update notification_channels set name = coalesce($2, name), recipients = coalesce($3, recipients), secret_blob = $4, target_hint = coalesce($5, target_hint),
           events = coalesce($6, events), project_ids = case when $7 then $8::uuid[] else project_ids end, include_local = coalesce($9, include_local),
           enabled = coalesce($10, enabled), last_error = case when $10 then null else last_error end, updated_at = now()
         where id = $1 returning ${COLUMNS}`,
        [cur.id, b.name ?? null, cur.kind === "email" ? b.recipients ?? null : null, blob, hint, b.events ?? null, b.projectIds !== undefined, b.projectIds ?? null, b.includeLocal ?? null, b.enabled ?? null],
      );
      const { url: _secret, ...changes } = b;
      await audit(q, req, "notification.updated", "notification_channel", cur.id, { ...changes, ...(b.url !== undefined ? { url: "changed" } : {}) });
      return row;
    });
    res.json({ channel });
  }),
);

NotificationsRouter.delete(
  "/:channelId",
  auth("owner", "admin"),
  validate({}),
  handle(async (req, res) => {
    await scoped(req, async (q) => {
      const [d] = await q<{ id: string; name: string }>("delete from notification_channels where id = $1 returning id, name", [req.params.channelId]);
      if (!d) throw notFound("Channel");
      await audit(q, req, "notification.deleted", "notification_channel", d.id, { name: d.name });
    });
    res.status(204).end();
  }),
);

NotificationsRouter.post(
  "/:channelId/test",
  auth("owner", "admin"),
  validate({}),
  handle(async (req, res) => {
    const { config, vault } = deps(req);
    const out = await scoped(req, async (q) => {
      const [c] = await q<any>("select c.*, o.name as org_name from notification_channels c join orgs o on o.id = c.org_id where c.id = $1", [req.params.channelId]);
      if (!c) throw notFound("Channel");
      const base = config.APP_URL ? `${config.APP_URL}/o/${c.org_id}` : null;
      const sample: NotifyPayload = {
        event: "run.failed", test: true, org: { id: c.org_id, name: c.org_name }, project: { id: "00000000-0000-0000-0000-000000000000", name: "Sample project" }, environment: "staging",
        run: { id: "sample", status: "failed", suite: "staging", trigger: "manual", source: "hosted", blocking: 1, newIssues: 1, fixedIssues: 0, reopenedIssues: 0, envError: null, url: base, git: null },
        issues: [{ title: "Route answers without a token (sample)", severity: "critical", target: "GET /api/v1/orders", url: null }],
        occurredAt: new Date().toISOString(),
      };
      try {
        const secret = c.secret_blob ? JSON.parse(vault.decrypt(c.secret_blob, `${c.org_id}:${c.id}`)) : null;
        await sendNotification({ kind: c.kind, recipients: c.recipients, secret }, sample, `test-${crypto.randomUUID()}`, config);
        await q("update notification_channels set last_delivery_at = now(), last_error = null where id = $1", [c.id]);
        return { ok: true as const };
      } catch (e: any) {
        const error = String(e?.message ?? e).slice(0, 500);
        await q("update notification_channels set last_error = $2 where id = $1", [c.id, error]);
        return { ok: false as const, error };
      }
    });
    if (!out.ok) throw unprocessable(`The test message wasn't delivered: ${out.error}`);
    res.json(out);
  }),
);

NotificationsRouter.get(
  "/:channelId/deliveries",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const deliveries = await scoped(req, async (q) => {
      const [c] = await q("select id from notification_channels where id = $1", [req.params.channelId]);
      if (!c) throw notFound("Channel");
      return q(
        `select id, event, status, attempts, last_error as "lastError", created_at as "createdAt", sent_at as "sentAt", next_attempt_at as "nextAttemptAt",
           payload->'project'->>'name' as "projectName", payload->'run'->>'url' as "runUrl"
         from notification_deliveries where channel_id = $1 order by created_at desc limit 20`,
        [req.params.channelId],
      );
    });
    res.json({ deliveries });
  }),
);
