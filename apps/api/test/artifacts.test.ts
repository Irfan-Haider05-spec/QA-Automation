import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startApi, signup, sampleRun, type TestApi } from "./helpers.js";
import { cleanupArtifacts, type ArtifactStore } from "../src/lib/artifacts.js";

let api: TestApi, owner: Awaited<ReturnType<typeof signup>>, projectId: string, key: string, runId: string;
let failUpload = false, failDelete = false;
let pauseUpload: (() => Promise<void>) | undefined;
const objects = new Map<string, Uint8Array>();
const store: ArtifactStore = {
  async put(key, data) { await pauseUpload?.(); objects.set(key, data); if (failUpload) throw new Error("Simulate ambiguous storage timeout"); },
  async download(key) { return `https://private-storage.example/${key}?signed=fixture`; },
  async delete(key) { if (failDelete) throw new Error("Simulate storage deletion outage"); objects.delete(key); },
};
const payload = (name = "web/screenshot.png") => { const data = Buffer.from("fixture-evidence"); return { name, data: data.toString("base64"), sha256: createHash("sha256").update(data).digest("hex") }; };
const upload = (body: unknown, apiKey = key, run = runId) => api.call("POST", `/runner/runs/${run}/artifacts`, { token: apiKey, body });
before(async () => {
  api = await startApi({}, store); owner = await signup(api, "artifacts");
  projectId = (await api.call("POST", `/orgs/${owner.orgId}/projects`, { token: owner.token, body: { name: "Evidence" } })).body.project.id;
  key = (await api.call("POST", `/orgs/${owner.orgId}/projects/${projectId}/api-keys`, { token: owner.token, body: { name: "CI" } })).body.key;
  runId = (await api.call("POST", "/runner/runs", { token: key, body: sampleRun([]) })).body.runId;
});
after(async () => api.close());
test("Evidence uploads are immutable, checksummed and visible through authorized signed links", async () => {
  const r = await upload(payload()); assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(objects.size, 1);
  const detail = await api.call("GET", `/orgs/${owner.orgId}/projects/${projectId}/runs/${runId}`, { token: owner.token });
  assert.equal(detail.body.run.artifacts.length, 1); assert.match(detail.body.run.artifacts[0].downloadUrl, /^https:\/\/private-storage/);
  assert.equal(detail.body.run.artifacts[0].object_key, undefined);
  assert.equal((await upload(payload())).status, 400);
  assert.equal((await upload({ ...payload("bad.png"), sha256: "0".repeat(64) })).status, 400);
  assert.equal((await upload(payload("../secrets.env"))).status, 400);
});
test("Foreign project keys and foreign org users cannot upload/read evidence", async () => {
  const stranger = await signup(api, "other-artifacts");
  const p = (await api.call("POST", `/orgs/${stranger.orgId}/projects`, { token: stranger.token, body: { name: "Other" } })).body.project.id;
  const foreign = (await api.call("POST", `/orgs/${stranger.orgId}/projects/${p}/api-keys`, { token: stranger.token, body: { name: "CI" } })).body.key;
  assert.equal((await upload(payload("foreign.png"), foreign)).status, 404);
  assert.equal((await api.call("GET", `/orgs/${owner.orgId}/projects/${projectId}/runs/${runId}`, { token: stranger.token })).status, 404);
});
test("Ambiguous upload failure leaves a cleanup record; deletion errors retain it for retry", async () => {
  failUpload = true; assert.equal((await upload(payload("failed.png"))).status, 502); failUpload = false;
  assert.equal(objects.size, 2);
  failDelete = true; await assert.rejects(cleanupArtifacts(api.db, store)); failDelete = false;
  const [{ n }] = await api.db.raw<{ n: number }>("select count(*)::int as n from artifacts where state = 'pending'"); assert.equal(n, 1);
  assert.equal(await cleanupArtifacts(api.db, store), 1); assert.equal(objects.size, 1);
});
test("Deleting a run retains tombstones until private evidence is deleted", async () => {
  await api.db.raw("delete from runs where id = $1", [runId]);
  assert.equal(await cleanupArtifacts(api.db, store), 1); assert.equal(objects.size, 0);
  assert.equal((await api.db.raw("select id from artifacts")).length, 0);
});

test("Retention cannot orphan an upload still in flight when its run is deleted", async () => {
  const run = (await api.call("POST", "/runner/runs", { token: key, body: sampleRun([]) })).body.runId;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  pauseUpload = async () => { entered(); await pending; };
  const response = upload(payload("in-flight.png"), key, run);
  try {
    await started;
    await api.db.raw("delete from runs where id = $1", [run]);
    assert.equal(await cleanupArtifacts(api.db, store), 0);
    assert.equal((await api.db.raw("select id from artifacts where run_id is null")).length, 1);
  } finally { pauseUpload = undefined; release(); }
  assert.equal((await response).status, 502);
  await cleanupArtifacts(api.db, store);
  assert.equal(objects.size, 0);
  assert.equal((await api.db.raw("select id from artifacts")).length, 0);
});
test("Flaky findings retain metadata without opening issues; errored uploads cannot claim success", async () => {
  const body = sampleRun([{ fp: "flaky01" }]); const finding = body.results[0].findings[0];
  Object.assign(finding, { flaky: true, confidence: "high", cwe: ["CWE-200"], remediation: "Remove sensitive fields" });
  body.gate = { failOn: "high", passed: true, blocking: 0 };
  const response = await api.call("POST", "/runner/runs", { token: key, body });
  assert.equal(response.status, 201); assert.equal(response.body.newIssues, 0);
  const detail = await api.call("GET", `/orgs/${owner.orgId}/projects/${projectId}/runs/${response.body.runId}`, { token: owner.token });
  assert.equal(detail.body.run.findings[0].evidence.veriq.flaky, true); assert.equal(detail.body.run.findings[0].issueId, null);
  const broken = sampleRun([]); broken.results[0].status = "errored";
  const error = await api.call("POST", "/runner/runs", { token: key, body: broken }); assert.equal(error.body.status, "failed");
});
