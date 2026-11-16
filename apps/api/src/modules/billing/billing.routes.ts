import { Router } from "express";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { SubscriptionEventSchema } from "@qa/shared";
import { auth } from "../../middleware/auth.js";
import { audit, deps, scoped } from "../../lib/context.js";
import { withContext } from "../../db/index.js";
import { entitlement, lockBilling, paymentGateway } from "../../lib/billing.js";
import { safeEqualHex, sha256 } from "../../lib/crypto.js";
import { ApiError, conflict, handle, notFound, validate } from "../../lib/http.js";

export const BillingRouter = Router({ mergeParams: true });
export const BillingEventsRouter = Router();
BillingRouter.get("/", auth("owner", "admin"), handle(async (req, res) => {
  const config = deps(req).config;
  const data = await scoped(req, async (q) => {
    const plan = await entitlement(q, config);
    const [subscription] = await q("select plan_id as \"planId\", status, period_end as \"periodEnd\" from subscriptions where org_id = app_org()");
    const [usage] = await q("select runs, hosted_ms as \"hostedMs\" from usage_months where org_id = app_org() and month = date_trunc('month',now() at time zone 'UTC')::date");
    const [{ projects }] = await q("select count(*)::int as projects from projects where org_id = app_org()");
    const [{ bytes }] = await q("select coalesce(sum(size_bytes),0)::text as bytes from artifacts where org_id = app_org()");
    return { plan, subscription: subscription ?? null, usage: { runs: usage?.runs ?? 0, hostedMinutes: Number(usage?.hostedMs ?? 0) / 60000, projects, storageBytes: Number(bytes) } };
  });
  res.json({ ...data, plans: config.BILLING_PLANS, paymentsEnabled: !!(config.BILLING_GATEWAY_URL && config.BILLING_GATEWAY_TOKEN && config.BILLING_WEBHOOK_SECRET && config.APP_URL), usagePeriod: "UTC calendar month" });
}));

BillingRouter.post("/checkout", auth("owner"), validate({ body: z.object({ planId: z.string().max(50), requestKey: z.string().uuid() }).strict() }), handle(async (req, res) => {
  const config = deps(req).config, orgId = req.member!.orgId;
  const plan = config.BILLING_PLANS.find((p) => p.id === req.body.planId);
  if (!plan || !plan.checkoutEnabled) throw new ApiError(400, "plan_unavailable", "This plan is not available for checkout");
  const id = await scoped(req, async (q) => {
    await lockBilling(q);
    await q("insert into billing_requests(org_id,plan_id,request_key) values (app_org(),$1,$2) on conflict do nothing", [plan.id, req.body.requestKey]);
    const [row] = await q("select id, plan_id from billing_requests where org_id = app_org() and request_key = $1", [req.body.requestKey]);
    if (row.plan_id !== plan.id) throw conflict("An idempotency key cannot be reused for a different plan");
    await audit(q, req, "billing.checkout_requested", "billing_request", row.id, { planId: plan.id }); return row.id;
  });
  res.json(await paymentGateway(config, "checkout", { orgId, planId: plan.id, idempotencyKey: id, returnUrl: `${config.APP_URL}/o/${orgId}/settings` }));
}));
BillingRouter.post("/portal", auth("owner"), validate({ body: z.object({}).strict() }), handle(async (req, res) => {
  const orgId = req.member!.orgId, config = deps(req).config;
  res.json(await paymentGateway(config, "portal", { orgId, returnUrl: `${config.APP_URL}/o/${orgId}/settings` }));
}));

BillingEventsRouter.post("/events", handle(async (req, res) => {
  const secret = deps(req).config.BILLING_WEBHOOK_SECRET;
  const timestamp = req.get("x-veriq-timestamp") ?? "", signature = req.get("x-veriq-signature") ?? "";
  const denied = () => new ApiError(401, "invalid_signature", "Invalid billing event signature");
  if (!secret || !Buffer.isBuffer(req.body) || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(signature)) throw denied();
  const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(req.body).digest("hex");
  if (!safeEqualHex(signature, digest)) throw denied();
  let json: unknown; try { json = JSON.parse(req.body.toString("utf8")); } catch { throw new ApiError(400, "invalid_event", "Invalid billing event JSON"); }
  const event = SubscriptionEventSchema.parse(json), hash = sha256(req.body.toString("utf8"));
  if (!deps(req).config.BILLING_PLANS.some((p) => p.id === event.planId)) throw new ApiError(400, "unknown_plan", "Unknown plan");
  const result = await withContext(deps(req).db, { orgId: event.orgId }, async (q) => {
    const [org] = await q("select id from orgs where id = app_org() for update"); if (!org) throw notFound("Organization");
    const [seen] = await q("select payload_hash from billing_events where id = $1", [event.id]);
    if (seen) { if (seen.payload_hash !== hash) throw conflict("Event ID already used with another payload"); return { duplicate: true, applied: false }; }
    await q("insert into billing_events(id,org_id,payload_hash,sequence) values ($1,app_org(),$2,$3)", [event.id, hash, event.sequence]);
    const rows = await q(`insert into subscriptions(org_id,plan_id,status,sequence,period_start,period_end) values(app_org(),$1,$2,$3,$4,$5)
      on conflict(org_id) do update set plan_id=excluded.plan_id,status=excluded.status,sequence=excluded.sequence,period_start=excluded.period_start,period_end=excluded.period_end,updated_at=now()
      where subscriptions.sequence < excluded.sequence returning org_id`, [event.planId, event.status, event.sequence, event.periodStart, event.periodEnd]);
    await q("insert into audit_events(org_id,action,entity_type,entity_id,data) values(app_org(),'billing.event_received','org',app_org(),$1)", [JSON.stringify({ eventId: event.id, applied: rows.length > 0, plan: event.planId, status: event.status })]);
    return { duplicate: false, applied: rows.length > 0 };
  });
  res.json(result);
}));
