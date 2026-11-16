import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { startApi, signup, sampleRun, addMember, type TestApi } from "./helpers.js";
import { paymentGateway } from "../src/lib/billing.js";
import { loadConfig } from "../src/config.js";
let api: TestApi;
const secret = "billing-test-signature-secret-0123456789";
const plans = [{ id: "free", name: "Free", projects: 1, monthlyRuns: 2, monthlyHostedMinutes: 1, storageBytes: 1024, retentionDays: 7, checkoutEnabled: false },
  { id: "team", name: "Team", projects: 3, monthlyRuns: 10, monthlyHostedMinutes: 100, storageBytes: 2048, retentionDays: 30, checkoutEnabled: true },
  { id: "enterprise", name: "Enterprise", projects: 10, monthlyRuns: 100, monthlyHostedMinutes: 1000, storageBytes: 4096, retentionDays: 90, checkoutEnabled: true }];
before(async () => { api = await startApi({ BILLING_PLANS: JSON.stringify(plans), BILLING_WEBHOOK_SECRET: secret }); });
after(async () => { await api.close(); });
function event(orgId: string, sequence = 1) { return { id: randomUUID(), orgId, sequence, planId: "team", status: "active", periodStart: new Date().toISOString(), periodEnd: new Date(Date.now() + 86400000).toISOString() }; }
async function deliver(body: object, options: { timestamp?: string; tamper?: boolean } = {}) {
  const raw = JSON.stringify(body), timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  const r = await fetch(`${api.url}/api/v1/billing/events`, { method: "POST", headers: { "content-type": "application/json", "x-veriq-timestamp": timestamp, "x-veriq-signature": signature }, body: options.tamper ? raw + " " : raw });
  return { status: r.status, body: await r.json() as any };
}
test("Concurrent project creation and run uploads enforce organization quotas", async () => {
  const user = await signup(api, "quota");
  const create = () => api.call("POST", `/orgs/${user.orgId}/projects`, { token: user.token, body: { name: randomUUID() } });
  const responses = await Promise.all([create(), create()]); assert.deepEqual(responses.map((r) => r.status).sort(), [201, 402]);
  const project = responses.find((r) => r.status === 201)!.body.project.id;
  const key = (await api.call("POST", `/orgs/${user.orgId}/projects/${project}/api-keys`, { token: user.token, body: { name: "CI" } })).body.key;
  for (let i = 0; i < 2; i++) assert.equal((await api.call("POST", "/runner/runs", { token: key, body: sampleRun([]) })).status, 201);
  const forged = { ...sampleRun([]), source: "hosted" }; assert.equal((await api.call("POST", "/runner/runs", { token: key, body: forged })).status, 402);
  const usage = await api.call("GET", `/orgs/${user.orgId}/billing`, { token: user.token }); assert.equal(usage.body.usage.runs, 2);
  assert.equal((await deliver(event(user.orgId))).status, 200);
  assert.equal((await create()).status, 201);
  const member = await addMember(api, user, "viewer");
  assert.equal((await api.call("GET", `/orgs/${user.orgId}/billing`, { token: member.token })).status, 403);
});
test("Queued hosted jobs reserve monthly run quota before runner completion", async () => {
  const user = await signup(api, "reserved");
  const project = (await api.call("POST", `/orgs/${user.orgId}/projects`, { token: user.token, body: { name: "Reserved quota" } })).body.project;
  const env = (await api.call("POST", `/orgs/${user.orgId}/projects/${project.id}/environments`, { token: user.token, body: { name: "staging", apiBaseUrl: "https://staging.example.test" } })).body.environment;
  const key = (await api.call("POST", `/orgs/${user.orgId}/projects/${project.id}/api-keys`, { token: user.token, body: { name: "CI" } })).body.key;
  for (let i = 0; i < 2; i++) await api.db.raw("insert into run_jobs(org_id, project_id, environment_id, suite, trigger_type) values ($1,$2,$3,'staging','manual')", [user.orgId, project.id, env.id]);
  const blocked = await api.call("POST", "/runner/runs", { token: key, body: sampleRun([]) });
  assert.equal(blocked.status, 402);
  assert.equal(blocked.body.error.code, "quota_exceeded");
});
test("Billing events verify raw signatures and timestamps, deduplicate and reject stale state", async () => {
  const user = await signup(api, "billing"); const first = event(user.orgId, 2);
  assert.equal((await deliver(first, { tamper: true })).status, 401);
  assert.equal((await deliver(first, { timestamp: String(Math.floor(Date.now() / 1000) - 600) })).status, 401);
  assert.equal((await deliver(first)).body.applied, true);
  assert.equal((await deliver(first)).body.duplicate, true);
  assert.equal((await deliver({ ...first, status: "cancelled" })).status, 409);
  assert.equal((await deliver({ ...event(user.orgId, 1), status: "cancelled" })).body.applied, false);
  assert.equal((await api.call("GET", `/orgs/${user.orgId}/billing`, { token: user.token })).body.plan.id, "team");
  assert.equal((await deliver({ ...event(user.orgId, 3), status: "cancelled" })).body.applied, true);
  assert.equal((await api.call("GET", `/orgs/${user.orgId}/billing`, { token: user.token })).body.plan.id, "free");
  const expired = event(user.orgId, 4); expired.periodStart = new Date(Date.now() - 2 * 86400000).toISOString(); expired.periodEnd = new Date(Date.now() - 86400000).toISOString();
  assert.equal((await deliver(expired)).body.applied, true);
  assert.equal((await api.call("GET", `/orgs/${user.orgId}/billing`, { token: user.token })).body.plan.id, "free", "An active status with an expired period must not grant paid entitlements");
  const other = await signup(api, "other-billing");
  assert.equal((await api.call("GET", `/orgs/${user.orgId}/billing`, { token: other.token })).status, 404);
});
test("Payments stay disabled without a configured provider and request keys cannot change plan", async () => {
  const user = await signup(api, "checkout");
  const requestKey = randomUUID();
  const r = await api.call("POST", `/orgs/${user.orgId}/billing/checkout`, { token: user.token, body: { planId: "team", requestKey } });
  assert.equal(r.status, 503); assert.equal(r.body.error.code, "billing_disabled");
  assert.equal((await api.call("POST", `/orgs/${user.orgId}/billing/checkout`, { token: user.token, body: { planId: "free", requestKey: randomUUID() } })).status, 400);
  const mismatch = await api.call("POST", `/orgs/${user.orgId}/billing/checkout`, { token: user.token, body: { planId: "enterprise", requestKey } });
  assert.equal(mismatch.status, 409, "Reusing an idempotency key for another valid plan must be rejected");
});

test("Payment gateway bounds responses and rejects provider errors and unsafe checkout URLs", async () => {
  const config = loadConfig({ NODE_ENV: "test", JWT_SECRET: "j".repeat(32), VAULT_MASTER_KEY: Buffer.alloc(32, 2).toString("base64"), BILLING_GATEWAY_URL: "https://billing.example", BILLING_GATEWAY_TOKEN: "gateway-token-0123456789-abcdefghij", BILLING_WEBHOOK_SECRET: secret, APP_URL: "https://app.example" });
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("x".repeat(20001), { status: 200 });
    await assert.rejects(paymentGateway(config, "checkout", {}), (e: any) => e.status === 502 && e.code === "billing_unavailable");
    globalThis.fetch = async () => new Response("provider failure", { status: 503 });
    await assert.rejects(paymentGateway(config, "checkout", {}), (e: any) => e.status === 502 && e.code === "billing_unavailable");
    for (const payload of [null, "unexpected", [], ...["http://evil.example/pay", "https://user:pass@pay.example/", "https://localhost/pay", "https://127.0.0.1/pay", "not a URL"].map((url) => ({ url }))]) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
      await assert.rejects(paymentGateway(config, "checkout", {}), (e: any) => e.status === 502 && e.code === "billing_unavailable", JSON.stringify(payload));
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ url: "https://pay.example/session/123" }), { status: 200 });
    assert.deepEqual(await paymentGateway(config, "checkout", {}), { url: "https://pay.example/session/123" });
  } finally { globalThis.fetch = original; }
});
