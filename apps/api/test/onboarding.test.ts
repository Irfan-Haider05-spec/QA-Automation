/**
 * First-run checklist: each setup step flips to done as the organization does it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, addMember, sampleRun, type TestApi } from "./helpers.js";

let api: TestApi;
before(async () => { api = await startApi({ ALLOW_PRIVATE_WEBHOOKS: "true" }); });
after(async () => { await api.close(); });

test("the checklist follows the organization's setup, for owners and admins only", async () => {
  const o = await signup(api, "onb", "Onboard Co");
  const status = async () => (await api.call("GET", `/orgs/${o.orgId}/onboarding`, { token: o.token })).body;
  let s = await status();
  assert.equal(s.done, 0);
  assert.equal(s.total, 8);
  assert.equal(s.firstProjectId, null);

  const p = (await api.call("POST", `/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Shop API" } })).body.project;
  const e = (await api.call("POST", `/orgs/${o.orgId}/projects/${p.id}/environments`, { token: o.token, body: { name: "staging", apiBaseUrl: "https://staging.shop.test/api" } })).body.environment;
  s = await status();
  assert.deepEqual([s.steps.project, s.steps.environment, s.steps.verified], [true, true, false]);
  assert.equal(s.firstProjectId, p.id);

  await api.db.raw(`update environments set verified_at = now() where id = '${e.id}'`);
  const cred = await api.call("POST", `/orgs/${o.orgId}/projects/${p.id}/environments/${e.id}/credentials`, { token: o.token, body: { name: "merchantA", role: "MERCHANT", identifier: "a@shop.test", secret: "pw-123456" } });
  assert.equal(cred.status, 201, JSON.stringify(cred.body));
  const key = (await api.call("POST", `/orgs/${o.orgId}/projects/${p.id}/api-keys`, { token: o.token, body: { name: "CI" } })).body;
  s = await status();
  assert.deepEqual([s.steps.verified, s.steps.accounts, s.steps.connected, s.steps.firstRun], [true, true, true, false]);

  const up = await api.call("POST", "/runner/runs", { token: key.key ?? key.token, body: sampleRun([]) });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  await api.call("POST", `/orgs/${o.orgId}/notifications`, { token: o.token, body: { kind: "webhook", name: "Hook", url: "http://127.0.0.1:9/hook", events: ["run.failed"] } });
  const viewer = await addMember(api, o, "viewer");
  s = await status();
  assert.deepEqual(s.steps, { project: true, environment: true, verified: true, accounts: true, connected: true, firstRun: true, notifications: true, team: true });
  assert.equal(s.done, 8);

  assert.equal((await api.call("GET", `/orgs/${o.orgId}/onboarding`, { token: viewer.token })).status, 403);
  const other = await signup(api, "other");
  assert.equal((await api.call("GET", `/orgs/${o.orgId}/onboarding`, { token: other.token })).status, 404);
});
