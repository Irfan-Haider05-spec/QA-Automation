import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BillingPlan } from "@qa/shared";
import { api } from "../api/client";
import { useCurrentOrg } from "../lib/org";
import { Button, ErrorAlert } from "../components/ui";
interface Billing { plan: BillingPlan; plans: BillingPlan[]; paymentsEnabled: boolean; usagePeriod: string; usage: { projects: number; runs: number; hostedMinutes: number; storageBytes: number }; subscription: { status: string; periodEnd: string } | null }
export function BillingSettings() {
  const { orgId, org } = useCurrentOrg();
  const allowed = org?.role === "owner" || org?.role === "admin";
  const q = useQuery({ queryKey: ["org", orgId, "billing"], queryFn: () => api<Billing>("GET", `/orgs/${orgId}/billing`), enabled: allowed });
  const requests = useRef(new Map<string, string>()), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  if (!allowed) return null;
  const checkout = async (planId?: string) => {
    setBusy(true); setError(undefined);
    try {
      if (planId && !requests.current.has(planId)) requests.current.set(planId, crypto.randomUUID());
      const r = await api<{ url: string }>("POST", `/orgs/${orgId}/billing/${planId ? "checkout" : "portal"}`, planId ? { planId, requestKey: requests.current.get(planId) } : {});
      if (new URL(r.url).protocol !== "https:") throw new Error("Unsafe billing URL"); location.assign(r.url);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const limit = (n: number | null) => n === null ? "Unlimited" : n.toLocaleString();
  return <section className="panel" aria-labelledby="billing-title"><div className="panel-head"><h2 id="billing-title">Plan and usage</h2></div><div className="panel-body">
    <ErrorAlert error={q.error || error} />{q.data && <>
      <h3>{q.data.plan.name}</h3><p>{q.data.subscription?.status ?? "Local plan"} · Usage: {q.data.usagePeriod}</p>
      <dl className="kv"><dt>Projects</dt><dd>{q.data.usage.projects} / {limit(q.data.plan.projects)}</dd><dt>Runs</dt><dd>{q.data.usage.runs} / {limit(q.data.plan.monthlyRuns)}</dd><dt>Hosted minutes</dt><dd>{q.data.usage.hostedMinutes.toFixed(1)} / {limit(q.data.plan.monthlyHostedMinutes)}</dd><dt>Evidence storage</dt><dd>{q.data.usage.storageBytes.toLocaleString()} / {limit(q.data.plan.storageBytes)} bytes</dd><dt>Evidence retention</dt><dd>Up to {q.data.plan.retentionDays} days, subject to the server retention limit</dd></dl>
      {!q.data.paymentsEnabled ? <p className="muted">Payments are not enabled. Contact your administrator to configure plans and pricing.</p> : org?.role === "owner" && <div className="form"><Button type="button" busy={busy} onClick={() => checkout()}>Manage subscription</Button>{q.data.plans.filter((p) => p.checkoutEnabled).map((p) => <Button key={p.id} type="button" busy={busy} onClick={() => checkout(p.id)}>{p.name}{p.priceLabel ? ` — ${p.priceLabel}` : " — view checkout"}</Button>)}</div>}
    </>}
  </div></section>;
}
