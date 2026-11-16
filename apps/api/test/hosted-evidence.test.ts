import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startApi, signup, sampleRun, type TestApi } from "./helpers.js";
import type { ArtifactStore } from "../src/lib/artifacts.js";
import { PlatformClient } from "../../runner/src/platform.js";

const RUNNER_TOKEN = "hosted-evidence-runner-token-for-tests";
const bytes = Buffer.from("hosted evidence fixture");
const payload = (name: string) => ({ name, data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
const objects = new Map<string, Uint8Array>();
const store: ArtifactStore = {
  async put(key, value) { objects.set(key, value); },
  async download(key) { return `https://evidence.invalid/${key}`; },
  async delete(key) { objects.delete(key); },
};

let api: TestApi;
let user: Awaited<ReturnType<typeof signup>>;
let projectId: string;
let environmentId: string;
let jobId: string;
let runId: string;
const runner = "evidence-runner";
const callRunner = (method: string, path: string, body?: unknown, id = runner) => api.call(method, path, { body, token: RUNNER_TOKEN, headers: { "x-runner-id": id } });

before(async () => {
  objects.clear();
  api = await startApi({ RUNNER_TOKEN }, store);
  user = await signup(api, "hosted-evidence");
  projectId = (await api.call("POST", `/orgs/${user.orgId}/projects`, { token: user.token, body: { name: "Hosted evidence" } })).body.project.id;
  environmentId = (await api.call("POST", `/orgs/${user.orgId}/projects/${projectId}/environments`, { token: user.token, body: { name: "staging", webApps: [{ name: "web", baseUrl: "https://staging.example.test", loginPath: "/login" }] } })).body.environment.id;
  await api.db.raw("update environments set verified_at = now() where id = $1", [environmentId]);
  const queued = await api.call("POST", `/orgs/${user.orgId}/projects/${projectId}/jobs`, { token: user.token, body: { environmentId, suite: "staging" } });
  assert.equal(queued.status, 201, JSON.stringify(queued.body));
  jobId = queued.body.job.id;
  const claimed = await callRunner("POST", "/hosted/jobs/claim");
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.job.id, jobId);
  const completed = await callRunner("POST", `/hosted/jobs/${jobId}/complete`, { run: sampleRun([]) });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  runId = completed.body.runId;
  const recovered = await callRunner("GET", `/hosted/jobs/${jobId}/result`);
  assert.deepEqual(recovered.body, { status: "done", runId });
  assert.equal((await callRunner("GET", `/hosted/jobs/${jobId}/result`, undefined, "other-runner")).status, 404);
});

after(async () => api.close());

test("Hosted evidence status is assigned-run scoped and records a generic visible failure", async () => {
  const [initial] = await api.db.raw<{ evidence_status: string; evidence_error: string | null }>("select evidence_status, evidence_error from runs where id = $1", [runId]);
  assert.deepEqual(initial, { evidence_status: "pending", evidence_error: null });
  const [accounted] = await api.db.raw<{ usage_accounted_at: Date | null }>("select usage_accounted_at from run_jobs where id = $1", [jobId]);
  assert.ok(accounted.usage_accounted_at, "successful completion records its usage transactionally");
  assert.equal((await callRunner("POST", `/hosted/jobs/${jobId}/evidence-status`, { status: "failed" }, "other-runner")).status, 404);
  assert.equal((await callRunner("POST", `/hosted/jobs/${jobId}/evidence-status`, { status: "failed", error: "secret" })).status, 400);
  assert.equal((await callRunner("POST", `/hosted/jobs/${jobId}/evidence-status`, { status: "failed" })).status, 200);
  const run = await api.call("GET", `/orgs/${user.orgId}/projects/${projectId}/runs/${runId}`, { token: user.token });
  assert.equal(run.body.run.evidenceStatus, "failed");
  assert.equal(run.body.run.evidenceError, "Evidence upload failed. Review the hosted runner log for details.");
  assert.equal(JSON.stringify(run.body).includes("secret"), false);
  assert.equal((await callRunner("POST", `/hosted/jobs/${jobId}/evidence-status`, { status: "complete" })).status, 200);
  const [finished] = await api.db.raw<{ evidence_status: string; evidence_error: string | null }>("select evidence_status, evidence_error from runs where id = $1", [runId]);
  assert.deepEqual(finished, { evidence_status: "complete", evidence_error: null });
});

test("runner recovers a committed completion after its HTTP response is lost", async () => {
  const originalFetch = globalThis.fetch;
  let dropOnce = true;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (dropOnce && String(input).includes(`/jobs/${jobId}/complete`)) {
      dropOnce = false;
      throw new Error("simulated lost response after server commit");
    }
    return response;
  };
  try {
    const client = new PlatformClient(api.url, RUNNER_TOKEN, runner);
    const recovered = await client.complete(jobId, { error: "ignored duplicate completion" });
    assert.deepEqual(recovered, { status: "done", runId });
  } finally { globalThis.fetch = originalFetch; }
});

test("Hosted error and cancellation terminal paths account server time exactly once", async () => {
  const usage = async () => {
    const [row] = await api.db.raw<{ runs: number }>("select runs from usage_months where org_id = $1 and month = date_trunc('month', now() at time zone 'UTC')::date", [user.orgId]);
    return row.runs;
  };
  let before = await usage();
  const failed = await api.call("POST", `/orgs/${user.orgId}/projects/${projectId}/jobs`, { token: user.token, body: { environmentId, suite: "staging" } });
  const failedId = failed.body.job.id;
  assert.equal((await callRunner("POST", "/hosted/jobs/claim")).body.job.id, failedId);
  assert.equal((await callRunner("POST", `/hosted/jobs/${failedId}/complete`, { error: "Engine failed" })).body.status, "error");
  assert.equal(await usage(), before + 1);
  const [failedAccounting] = await api.db.raw<{ usage_accounted_at: Date | null }>("select usage_accounted_at from run_jobs where id = $1", [failedId]);
  assert.ok(failedAccounting.usage_accounted_at);
  assert.equal((await callRunner("POST", `/hosted/jobs/${failedId}/complete`, { error: "retry" })).status, 409);
  assert.equal(await usage(), before + 1);

  before = await usage();
  const cancelled = await api.call("POST", `/orgs/${user.orgId}/projects/${projectId}/jobs`, { token: user.token, body: { environmentId, suite: "staging" } });
  const cancelledId = cancelled.body.job.id;
  assert.equal((await callRunner("POST", "/hosted/jobs/claim")).body.job.id, cancelledId);
  await api.db.raw("update run_jobs set cancel_requested = true where id = $1", [cancelledId]);
  assert.equal((await callRunner("POST", `/hosted/jobs/${cancelledId}/complete`, { error: "Cancelled" })).body.status, "cancelled");
  assert.equal(await usage(), before + 1);
  const [cancelAccounting] = await api.db.raw<{ usage_accounted_at: Date | null }>("select usage_accounted_at from run_jobs where id = $1", [cancelledId]);
  assert.ok(cancelAccounting.usage_accounted_at);
});

test("Hosted artifacts enforce assignment, checksum, readiness, immutability, and count limit", async () => {
  const upload = (body: unknown, id = runner) => callRunner("POST", `/hosted/jobs/${jobId}/artifacts`, body, id);
  assert.equal((await upload(payload("evidence.png"), "other-runner")).status, 404);
  assert.equal((await upload({ ...payload("bad.png"), sha256: "0".repeat(64) })).status, 400);
  assert.equal((await upload(payload("../escape.png"))).status, 400);
  assert.equal((await upload(payload("evidence.png"))).status, 201);
  assert.equal((await upload(payload("evidence.png"))).status, 400, "artifact name is immutable");
  const [{ state }] = await api.db.raw<{ state: string }>("select state from artifacts where run_id = $1", [runId]);
  assert.equal(state, "ready");
  for (let i = 1; i < 100; i++) assert.equal((await upload(payload(`evidence-${i}.png`))).status, 201);
  assert.equal((await upload(payload("evidence-over-limit.png"))).status, 400);
  assert.equal(objects.size, 100);
});

test("Hosted artifacts and evidence status expire after the assignment recovery window", async () => {
  await api.db.raw("update run_jobs set finished_at = now() - interval '16 minutes' where id = $1", [jobId]);
  assert.equal((await callRunner("POST", `/hosted/jobs/${jobId}/artifacts`, payload("late.png"))).status, 404);
  assert.equal((await callRunner("POST", `/hosted/jobs/${jobId}/evidence-status`, { status: "failed" })).status, 404);
});
