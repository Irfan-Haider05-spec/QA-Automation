/**
 * CI integration: API key scopes, deployments, runs linked to deployments and
 * triggers, credential hand-out to runners, and links back to the dashboard.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, addMember, sampleRun, type TestApi } from "./helpers.js";

let api: TestApi;
let o: Awaited<ReturnType<typeof signup>>;
let projectId: string;
let envId: string;
let uploadKey: string;
let readKey: string;

before(async () => {
  api = await startApi({ APP_URL: "https://qa.example.com/" });
  o = await signup(api, "ci");
  projectId = (await api.call("POST", `/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Shop" } })).body.project.id;
  envId = (await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/environments`, { token: o.token, body: { name: "staging", apiBaseUrl: "https://staging.shop.test" } })).body.environment.id;
  for (const [name, secret] of [["merchantA", "pass-A-123"], ["merchantB", "pass-B-456"]]) {
    const c = await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/environments/${envId}/credentials`, { token: o.token, body: { name, role: "MERCHANT", identifier: `${name}@shop.test`, device: "merchant", secret } });
    assert.equal(c.status, 201);
  }
  const k1 = await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/api-keys`, { token: o.token, body: { name: "upload only" } });
  assert.deepEqual(k1.body.apiKey.scopes, ["runs:write"]);
  uploadKey = k1.body.key;
  const k2 = await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/api-keys`, { token: o.token, body: { name: "CI with accounts", scopes: ["credentials:read"] } });
  assert.equal(k2.status, 201, JSON.stringify(k2.body));
  assert.deepEqual(k2.body.apiKey.scopes, ["runs:write", "credentials:read"]);
  readKey = k2.body.key;
});
after(async () => { await api.close(); });

test("only owners and admins can create keys that read passwords; unknown scopes are rejected", async () => {
  const dev = await addMember(api, o, "developer");
  const path = `/orgs/${o.orgId}/projects/${projectId}/api-keys`;
  assert.equal((await api.call("POST", path, { token: dev.token, body: { name: "x", scopes: ["credentials:read"] } })).status, 403);
  assert.equal((await api.call("POST", path, { token: dev.token, body: { name: "x" } })).status, 201);
  assert.equal((await api.call("POST", path, { token: o.token, body: { name: "x", scopes: ["admin:all"] } })).status, 400);
  const list = await api.call("GET", path, { token: o.token });
  assert.ok(list.body.apiKeys.every((k: any) => Array.isArray(k.scopes) && k.scopes.includes("runs:write")));
});

test("credentials: a credentials:read key gets decrypted accounts; an upload-only key gets 403", async () => {
  const path = `/runner/environments/${envId}/credentials`;
  const denied = await api.call("GET", path, { token: uploadKey });
  assert.equal(denied.status, 403);
  assert.match(denied.body.error.message, /credentials:read/);
  const ok = await api.call("GET", path, { token: readKey });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.credentials.map((c: any) => [c.name, c.secret, c.device]), [["merchantA", "pass-A-123", "merchant"], ["merchantB", "pass-B-456", "merchant"]]);
  // A user token is not an API key, and an unknown environment is 404
  assert.equal((await api.call("GET", path, { token: o.token })).status, 401);
  assert.equal((await api.call("GET", "/runner/environments/00000000-0000-4000-8000-000000000000/credentials", { token: readKey })).status, 404);
  // The hand-out is audited by account name, without secrets; last-used is recorded
  const ev = (await api.call("GET", `/orgs/${o.orgId}/audit`, { token: o.token })).body.events.find((e: any) => e.action === "credentials.fetched");
  assert.deepEqual(ev.data.accounts, ["merchantA", "merchantB"]);
  assert.equal(JSON.stringify(ev).includes("pass-A"), false);
  const creds = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/environments/${envId}/credentials`, { token: o.token })).body.credentials;
  assert.ok(creds.every((c: any) => c.lastUsedAt));
});

test("credentials: another project's environment is not reachable with this key", async () => {
  const other = await signup(api, "other");
  const p2 = (await api.call("POST", `/orgs/${other.orgId}/projects`, { token: other.token, body: { name: "P2" } })).body.project.id;
  const e2 = (await api.call("POST", `/orgs/${other.orgId}/projects/${p2}/environments`, { token: other.token, body: { name: "s" } })).body.environment.id;
  assert.equal((await api.call("GET", `/runner/environments/${e2}/credentials`, { token: readKey })).status, 404);
});

test("deployments: report, link a run to it, list with the run's result", async () => {
  const d = await api.call("POST", "/runner/deployments", { token: uploadKey, body: { environmentId: envId, sha: "abc1234def", ref: "staging", version: "v1.4.0", url: "https://staging.shop.test" } });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const deploymentId = d.body.deployment.id;
  const run = await api.call("POST", "/runner/runs", { token: uploadKey, body: { ...sampleRun([{ fp: "deploy01" }]), environmentId: envId, deploymentId, git: { sha: "abc1234def", ref: "staging", repo: "acme/shop", ciUrl: "https://github.com/acme/shop/actions/runs/1" } } });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  assert.equal(run.body.runUrl, `https://qa.example.com/o/${o.orgId}/projects/${projectId}/runs/${run.body.runId}`);

  const r = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/runs/${run.body.runId}`, { token: o.token })).body.run;
  assert.equal(r.trigger, "deploy");
  assert.equal(r.deployment.version, "v1.4.0");
  assert.equal(r.git.repo, "acme/shop");

  const list = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/deployments`, { token: o.token })).body.deployments;
  assert.equal(list.length, 1);
  assert.equal(list[0].environmentName, "staging");
  assert.equal(list[0].lastRun.status, "failed");
});

test("deployments: foreign deployment or environment ids are refused", async () => {
  assert.equal((await api.call("POST", "/runner/deployments", { token: uploadKey, body: { environmentId: "00000000-0000-4000-8000-000000000000" } })).status, 404);
  const run = await api.call("POST", "/runner/runs", { token: uploadKey, body: { ...sampleRun([]), deploymentId: "00000000-0000-4000-8000-000000000000" } });
  assert.equal(run.status, 404);
  assert.equal((await api.call("POST", "/runner/deployments", { token: uploadKey, body: { url: "not a url" } })).status, 400);
});

test("runs record their trigger; invalid triggers are rejected", async () => {
  const pr = await api.call("POST", "/runner/runs", { token: uploadKey, body: { ...sampleRun([]), trigger: "pr", git: { sha: "f00d", pr: "42", repo: "acme/shop" } } });
  assert.equal(pr.status, 201);
  const r = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/runs/${pr.body.runId}`, { token: o.token })).body.run;
  assert.equal(r.trigger, "pr");
  assert.equal(r.git.pr, "42");
  assert.equal(r.deployment, null);
  assert.equal((await api.call("POST", "/runner/runs", { token: uploadKey, body: { ...sampleRun([]), trigger: "cron" } })).status, 400);
});

test("without APP_URL the run link is null", async () => {
  const api2 = await startApi();
  try {
    const u = await signup(api2, "nourl");
    const p = (await api2.call("POST", `/orgs/${u.orgId}/projects`, { token: u.token, body: { name: "P" } })).body.project.id;
    const k = (await api2.call("POST", `/orgs/${u.orgId}/projects/${p}/api-keys`, { token: u.token, body: { name: "k" } })).body.key;
    const r = await api2.call("POST", "/runner/runs", { token: k, body: sampleRun([]) });
    assert.equal(r.status, 201);
    assert.equal(r.body.runUrl, null);
  } finally {
    await api2.close();
  }
});

test("viewers can list deployments but not create keys", async () => {
  const v = await addMember(api, o, "viewer");
  assert.equal((await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/deployments`, { token: v.token })).status, 200);
  assert.equal((await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/api-keys`, { token: v.token, body: { name: "x" } })).status, 403);
});
