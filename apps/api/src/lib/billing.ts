import type { BillingPlan } from "@qa/shared";
import { DEFAULT_PLAN } from "@qa/shared";
import type { Config } from "../config.js";
import type { Query } from "../db/index.js";
import { ApiError } from "./http.js";
import { readBoundedText } from "@qa/shared/http";
import { isIP } from "node:net";

export type BillingConfig = Pick<Config, "BILLING_PLANS">;
export async function entitlement(q: Query, config?: BillingConfig): Promise<BillingPlan> {
  const plans = config?.BILLING_PLANS ?? [DEFAULT_PLAN];
  const [sub] = await q("select plan_id, status, period_end from subscriptions where org_id = app_org()");
  if (!sub || !["active", "trialing"].includes(sub.status) || new Date(sub.period_end).getTime() <= Date.now()) return plans[0];
  const plan = plans.find((p) => p.id === sub.plan_id);
  if (!plan) throw new ApiError(503, "unknown_plan", "The subscription plan needs administrator configuration");
  return plan;
}
export const quotaError = (resource: string) => new ApiError(402, "quota_exceeded", `Your plan's ${resource} limit has been reached`);
/** Organization row lock serializes all quota-consuming changes across workers. */
export async function lockBilling(q: Query) { await q("select id from orgs where id = app_org() for update"); }
export async function projectQuota(q: Query, config?: BillingConfig) {
  await lockBilling(q); const plan = await entitlement(q, config);
  const [{ n }] = await q("select count(*)::int as n from projects where org_id = app_org()");
  if (plan.projects !== null && n >= plan.projects) throw quotaError("projects");
}
export async function recordRunUsage(q: Query, durationMs: number, hosted: boolean, config?: BillingConfig) {
  await lockBilling(q); const plan = await entitlement(q, config);
  await q("insert into usage_months(org_id, month) values (app_org(), date_trunc('month',now() at time zone 'UTC')::date) on conflict do nothing");
  const [usage] = await q("select * from usage_months where org_id = app_org() and month = date_trunc('month',now() at time zone 'UTC')::date for update");
  if (!hosted && plan.monthlyRuns !== null) {
    const [{ pending }] = await q("select count(*)::int as pending from run_jobs where org_id = app_org() and (status in ('queued','running') or (status in ('cancelled','error') and usage_accounted_at is null))");
    if (usage.runs + pending >= plan.monthlyRuns) throw quotaError("monthly runs");
  }
  // Never discard the evidence of an already-completed hosted job for crossing its
  // minute budget. Record actual duration; admission blocks the next job.
  await q("update usage_months set runs = runs + 1, hosted_ms = hosted_ms + $1 where org_id = app_org() and month = date_trunc('month',now() at time zone 'UTC')::date", [hosted ? durationMs : 0]);
}
export async function hostedQuota(q: Query, config?: BillingConfig) {
  await lockBilling(q); const plan = await entitlement(q, config);
  const [usage] = await q("select runs, hosted_ms from usage_months where org_id = app_org() and month = date_trunc('month',now() at time zone 'UTC')::date");
  const [{ pending }] = await q("select count(*)::int as pending from run_jobs where org_id = app_org() and (status in ('queued','running') or (status in ('cancelled','error') and usage_accounted_at is null))");
  if (plan.monthlyRuns !== null && (usage?.runs ?? 0) + pending >= plan.monthlyRuns) throw quotaError("monthly runs");
  if (plan.monthlyHostedMinutes !== null && Number(usage?.hosted_ms ?? 0) >= plan.monthlyHostedMinutes * 60000) throw quotaError("hosted minutes");
}
export async function artifactQuota(q: Query, bytes: number, config?: BillingConfig) {
  await lockBilling(q); const plan = await entitlement(q, config);
  const [{ bytes: used }] = await q("select coalesce(sum(size_bytes),0)::text as bytes from artifacts where org_id = app_org()");
  if (plan.storageBytes !== null && Number(used) + bytes > plan.storageBytes) throw quotaError("evidence storage");
  return plan.retentionDays;
}

export async function paymentGateway(config: Config, operation: "checkout" | "portal", body: Record<string, unknown>) {
  if (!config.BILLING_GATEWAY_URL || !config.BILLING_GATEWAY_TOKEN || !config.BILLING_WEBHOOK_SECRET || !config.APP_URL) throw new ApiError(503, "billing_disabled", "Payments are not configured; no charge was made");
  let res: Response, text: string;
  try {
  res = await fetch(`${config.BILLING_GATEWAY_URL.replace(/\/+$/, "")}/${operation}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { "content-type": "application/json", authorization: `Bearer ${config.BILLING_GATEWAY_TOKEN}` }, body: JSON.stringify(body) });
  text = await readBoundedText(res, 20000);
  } catch { throw new ApiError(502, "billing_unavailable", "Billing service is unavailable"); }
  if (!res.ok || text.length > 20000) throw new ApiError(502, "billing_unavailable", "Billing service is unavailable");
  let result: unknown; try { result = JSON.parse(text); } catch { throw new ApiError(502, "billing_unavailable", "Billing service returned an invalid response"); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new ApiError(502, "billing_unavailable", "Billing service returned an invalid response");
  const checkoutUrl = (result as { url?: unknown }).url;
  if (typeof checkoutUrl !== "string" || checkoutUrl.length > 2048) throw new ApiError(502, "billing_unavailable", "Billing service returned an invalid URL");
  let url: URL; try { url = new URL(checkoutUrl); } catch { throw new ApiError(502, "billing_unavailable", "Billing service returned an invalid URL"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !host || url.username || url.password || url.hash || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isIP(host.replace(/^\[|\]$/g, ""))) {
    throw new ApiError(502, "billing_unavailable", "Billing service returned an unsafe URL");
  }
  return { url: url.href };
}
