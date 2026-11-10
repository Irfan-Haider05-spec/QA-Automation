/**
 * Hosted runs: readiness, "Run now", the job queue as runners see it (claim,
 * heartbeat, cancel, complete, retry after silence), schedules and the scheduler.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, addMember, sampleRun, type TestApi } from "./helpers.js";
import { schedulerTick } from "../src/lib/scheduler.js";

const TOKEN = "runner-token-0123456789-0123456789-abcdef";
let api: TestApi;
let o: Awaited<ReturnType<typeof signup>>;
let projectId: string;
let envA: string; // verified, API URL
let envB: string; // verified, dashboard only
let envC: string; // not verified
let key: string;

const runner = (id = "runner-1", token = TOKEN) => ({ authorization: `Bearer ${token}`, "x-runner-id": id });
async function hosted(method: string, p: string, body?: unknown, headers = runner()) {
  return api.call(method, `/hosted${p}`, { headers, body });
}
const verify = (envId: string) => api.db.raw("update environments set verified_at = now() where id = $1", [envId]);
const profile = (routes = 3) => ({
  version: 1, apiPrefix: "/api/v1", healthPath: "/health",
  login: { path: "/api/v1/auth/login", tokenPath: "data.accessToken" },
  accounts: { merchantA: { role: "MERCHANT", device: "merchant" }, merchantB: { role: "MERCHANT" } },
  publicRoutes: ["GET /health"], privilegedPrefixes: ["/admin"],
  tenantIsolation: { owner: "merchantA", attacker: "merchantB", sharedResources: [], pairs: [], maxIdsPerRoute: 3 },
  cors: { allowedOrigins: [], probeOrigin: "https://evil.example" }, pathParams: {}, gateFailOn: "high",
  web: { slowMs: 3000, ignoreConsole: [], apps: [] },
  routes: Array.from({ length: routes }, (_, i) => ({ method: "GET", path: `/api/v1/r${i}`, apiPath: `/r${i}`, module: "m", authRequired: i > 0, roles: [], multipart: false, middlewares: [] })),
});

before(async () => {
  api = await startApi({ RUNNER_TOKEN: TOKEN, JOB_STALE_SECONDS: "60" });
  o = await signup(api, "hosted");
  projectId = (await api.call("POST", `/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Shop" } })).body.project.id;
  const mk = async (body: object) => (await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/environments`, { token: o.token, body })).body.environment.id;
  envA = await mk({ name: "staging", apiBaseUrl: "https://staging.shop.test" });
  envB = await mk({ name: "dash", webApps: [{ name: "admin", baseUrl: "https://dash.shop.test/admin", loginPath: "/login" }] });
  envC = await mk({ name: "unverified", apiBaseUrl: "https://other.shop.test" });
  await verify(envA);
  await verify(envB);
  await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/environments/${envA}/credentials`, { token: o.token, body: { name: "merchantA", role: "MERCHANT", identifier: "a@shop.test", device: "merchant", secret: "s3cret-A" } });
  key = (await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/api-keys`, { token: o.token, body: { name: "ci" } })).body.key;
});
after(async () => { await api.close(); });

const jobs = (body: object, token = o.token) => api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/jobs`, { token, body });

test("readiness: reasons until verified, profiled and testable", async () => {
  const s = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/hosted`, { token: o.token })).body;
  assert.equal(s.enabled, true);
  assert.equal(s.profile, null);
  const by = Object.fromEntries(s.environments.map((e: any) => [e.name, e]));
  assert.equal(by.staging.canRun, false);
  assert.match(by.staging.reasons.join(" "), /route list/);
  assert.equal(by.dash.canRun, true);
  assert.equal(by.dash.web, true);
  assert.match(by.dash.reasons.join(" "), /No test accounts/);
  assert.equal(by.unverified.canRun, false);
  assert.match(by.unverified.reasons.join(" "), /Verify the domain of unverified/);

  const refused = await jobs({ environmentId: envA, suite: "staging" });
  assert.equal(refused.status, 422);
  assert.match(refused.body.error.message, /route list/);
  assert.equal((await jobs({ environmentId: envC })).status, 422);
});

test("a CI upload with a profile makes the API checks available", async () => {
  const up = await api.call("POST", "/runner/runs", { token: key, body: { ...sampleRun([]), profile: profile(5), git: { sha: "abc123" } } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const s = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/hosted`, { token: o.token })).body;
  assert.equal(s.profile.routesCount, 5);
  assert.equal(s.profile.authRoutes, 4);
  assert.deepEqual(s.profile.accounts.map((a: any) => a.name), ["merchantA", "merchantB"]);
  assert.equal(s.environments.find((e: any) => e.name === "staging").canRun, true);
  // A malformed profile is rejected
  assert.equal((await api.call("POST", "/runner/runs", { token: key, body: { ...sampleRun([]), profile: { version: 2 } } })).status, 400);
});

test("run now: roles, duplicates, cancel while queued", async () => {
  const viewer = await addMember(api, o, "viewer");
  assert.equal((await jobs({ environmentId: envA }, viewer.token)).status, 403);
  const j = await jobs({ environmentId: envA, suite: "staging" });
  assert.equal(j.status, 201);
  assert.equal(j.body.job.status, "queued");
  assert.match(j.body.job.requestedBy, /^hosted/);
  assert.equal((await jobs({ environmentId: envA, suite: "staging" })).status, 409);
  const c = await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/jobs/${j.body.job.id}/cancel`, { token: o.token });
  assert.equal(c.body.job.status, "cancelled");
  assert.equal((await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/jobs/${j.body.job.id}/cancel`, { token: o.token })).status, 409);
  // A cancelled job is never claimed
  assert.equal((await hosted("POST", "/jobs/claim")).status, 204);
});

test("runner auth: token and runner id required", async () => {
  assert.equal((await hosted("POST", "/jobs/claim", undefined, runner("r", "wrong-token-wrong-token-wrong-token-xx"))).status, 401);
  assert.equal((await hosted("POST", "/jobs/claim", undefined, { authorization: `Bearer ${TOKEN}` } as any)).status, 401);
  assert.equal((await hosted("POST", "/jobs/claim", undefined, runner("bad id with spaces"))).status, 401);
  // A user token is not a runner token
  assert.equal((await hosted("POST", "/jobs/claim", undefined, { authorization: `Bearer ${o.token}`, "x-runner-id": "x" } as any)).status, 401);
  const api2 = await startApi();
  try {
    // Hosted runs off: even the "right" token is refused, with no hint about the configuration
    assert.equal((await api2.call("POST", "/hosted/jobs/claim", { headers: runner() })).status, 401);
    assert.equal((await api2.call("POST", "/hosted/jobs/claim")).status, 401);
  } finally { await api2.close(); }
});

test("claim → heartbeat → complete stores a hosted run; one running job per environment", async () => {
  const j1 = (await jobs({ environmentId: envA, suite: "staging" })).body.job;
  const j2 = (await jobs({ environmentId: envA, suite: "nightly" })).body.job;
  const c = await hosted("POST", "/jobs/claim");
  assert.equal(c.status, 200);
  assert.equal(c.body.job.id, j1.id);
  assert.equal(c.body.environment.apiBaseUrl, "https://staging.shop.test");
  assert.equal(c.body.profile.routes.length, 5);
  assert.deepEqual(c.body.checks, { api: true, web: false });
  assert.deepEqual(c.body.accounts.map((a: any) => [a.name, a.secret]), [["merchantA", "s3cret-A"]]);
  // Same environment is busy: the nightly job waits even for another runner
  assert.equal((await hosted("POST", "/jobs/claim", undefined, runner("runner-2"))).status, 204);
  // Another runner can't touch this job
  assert.equal((await hosted("POST", `/jobs/${j1.id}/heartbeat`, undefined, runner("runner-2"))).status, 404);
  assert.deepEqual((await hosted("POST", `/jobs/${j1.id}/heartbeat`)).body, { cancel: false });

  const done = await hosted("POST", `/jobs/${j1.id}/complete`, { run: sampleRun([{ fp: "hosted01" }]) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, "done");
  const run = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/runs/${done.body.runId}`, { token: o.token })).body.run;
  assert.equal(run.source, "hosted");
  assert.equal(run.trigger, "manual");
  assert.equal(run.environmentId, envA);
  const listed = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/jobs`, { token: o.token })).body.jobs.find((x: any) => x.id === j1.id);
  assert.equal(listed.run.status, "failed");
  assert.equal((await hosted("POST", `/jobs/${j1.id}/complete`, { error: "again" })).status, 409);

  // Now the nightly job can start
  const c2 = await hosted("POST", "/jobs/claim", undefined, runner("runner-2"));
  assert.equal(c2.body.job.id, j2.id);
  const err = await hosted("POST", `/jobs/${j2.id}/complete`, { error: "Engine exited with code 2" }, runner("runner-2"));
  assert.equal(err.body.status, "error");
  const audit = (await api.call("GET", `/orgs/${o.orgId}/audit`, { token: o.token })).body.events;
  assert.ok(audit.some((e: any) => e.action === "credentials.fetched" && e.data.hostedRunner === "runner-1"));
  assert.equal(JSON.stringify(audit).includes("s3cret-A"), false);
});

test("cancelling a running job: the next heartbeat says stop; completing records cancelled", async () => {
  const j = (await jobs({ environmentId: envB, suite: "staging" })).body.job;
  const c = await hosted("POST", "/jobs/claim");
  assert.equal(c.body.job.id, j.id);
  assert.deepEqual(c.body.checks, { api: false, web: true });
  await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/jobs/${j.id}/cancel`, { token: o.token });
  assert.deepEqual((await hosted("POST", `/jobs/${j.id}/heartbeat`)).body, { cancel: true });
  assert.equal((await hosted("POST", `/jobs/${j.id}/complete`, { error: "Cancelled" })).body.status, "cancelled");
});

test("a silent runner's job is retried once, then failed", async () => {
  const j = (await jobs({ environmentId: envA, suite: "staging" })).body.job;
  assert.equal((await hosted("POST", "/jobs/claim")).body.job.id, j.id);
  const age = () => api.db.raw("update run_jobs set heartbeat_at = now() - interval '10 minutes' where id = $1", [j.id]);
  await age();
  const t1 = await schedulerTick(api.db, { JOB_STALE_SECONDS: 60 });
  assert.equal(t1.requeued, 1);
  const again = await hosted("POST", "/jobs/claim", undefined, runner("runner-3"));
  assert.equal(again.body.job.id, j.id);
  assert.equal(again.body.job.attempts, 2);
  // The first runner wakes up: its job is gone
  assert.equal((await hosted("POST", `/jobs/${j.id}/heartbeat`)).status, 404);
  await age();
  const t2 = await schedulerTick(api.db, { JOB_STALE_SECONDS: 60 });
  assert.equal(t2.failed, 1);
  const listed = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/jobs`, { token: o.token })).body.jobs.find((x: any) => x.id === j.id);
  assert.equal(listed.status, "error");
  assert.match(listed.error, /stopped responding/);
});

test("queued jobs on an environment that loses verification fail with the reason", async () => {
  const j = (await jobs({ environmentId: envB, suite: "nightly" })).body.job;
  await api.db.raw("update environments set verified_at = null where id = $1", [envB]);
  assert.equal((await hosted("POST", "/jobs/claim")).status, 204);
  await schedulerTick(api.db, { JOB_STALE_SECONDS: 60 });
  const listed = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/jobs`, { token: o.token })).body.jobs.find((x: any) => x.id === j.id);
  assert.equal(listed.status, "error");
  assert.match(listed.error, /no longer verified/);
  await verify(envB);
});

test("schedules: validation, time zones, minimum interval, limits", async () => {
  const path = `/orgs/${o.orgId}/projects/${projectId}/schedules`;
  const post = (body: object) => api.call("POST", path, { token: o.token, body: { environmentId: envA, suite: "nightly", ...body } });
  assert.match((await post({ cron: "not a cron" })).body.error.message, /5-field cron/);
  assert.match((await post({ cron: "61 2 * * *" })).body.error.message, /Invalid cron/);
  assert.match((await post({ cron: "*/5 * * * *" })).body.error.message, /closer together than 60 minutes/);
  assert.match((await post({ cron: "41 2 * * *", timezone: "Mars/Olympus" })).body.error.message, /Unknown time zone/);
  assert.equal((await post({ cron: "41 2 * * *", environmentId: envC })).status, 422);

  const s = await post({ cron: "41 2 * * *", timezone: "Asia/Karachi" });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const next = new Date(s.body.schedule.nextRunAt);
  assert.equal(next.getUTCHours(), 21); // 02:41 in Karachi (UTC+5) is 21:41 UTC
  assert.equal(next.getUTCMinutes(), 41);
  assert.ok(next.getTime() > Date.now());

  const off = await api.call("PATCH", `${path}/${s.body.schedule.id}`, { token: o.token, body: { enabled: false } });
  assert.equal(off.body.schedule.nextRunAt, null);
  const on = await api.call("PATCH", `${path}/${s.body.schedule.id}`, { token: o.token, body: { enabled: true, cron: "0 */6 * * *", timezone: "UTC" } });
  assert.equal(new Date(on.body.schedule.nextRunAt).getUTCHours() % 6, 0);
  assert.equal((await api.call("PATCH", `${path}/${s.body.schedule.id}`, { token: o.token, body: {} })).status, 400);

  const viewer = await addMember(api, o, "viewer");
  assert.equal((await api.call("POST", path, { token: viewer.token, body: { environmentId: envA, suite: "nightly", cron: "0 3 * * *" } })).status, 403);
  assert.equal((await api.call("GET", path, { token: viewer.token })).status, 200);
  for (let i = 0; i < 9; i++) assert.equal((await post({ cron: `${i} 4 * * *` })).status, 201);
  assert.match((await post({ cron: "30 5 * * *" })).body.error.message, /at most 10/);
  for (const sc of (await api.call("GET", path, { token: o.token })).body.schedules.slice(1)) {
    assert.equal((await api.call("DELETE", `${path}/${sc.id}`, { token: o.token })).status, 204);
  }
});

test("scheduler: due schedules become jobs, next run moves on, no pile-up", async () => {
  const path = `/orgs/${o.orgId}/projects/${projectId}/schedules`;
  const [sc] = (await api.call("GET", path, { token: o.token })).body.schedules;
  await api.db.raw("update schedules set next_run_at = now() - interval '1 minute' where id = $1", [sc.id]);
  const t = await schedulerTick(api.db, { JOB_STALE_SECONDS: 60 });
  assert.equal(t.enqueued, 1);
  const after1 = (await api.call("GET", path, { token: o.token })).body.schedules[0];
  assert.ok(new Date(after1.nextRunAt).getTime() > Date.now());
  assert.equal(after1.lastJob.status, "queued");
  const job = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/jobs`, { token: o.token })).body.jobs.find((x: any) => x.id === after1.lastJob.id);
  assert.equal(job.trigger, "schedule");
  assert.equal(job.scheduleId, sc.id);
  // Due again while the last job still waits: skipped, with a reason
  await api.db.raw("update schedules set next_run_at = now() - interval '1 minute' where id = $1", [sc.id]);
  const t2 = await schedulerTick(api.db, { JOB_STALE_SECONDS: 60 });
  assert.equal(t2.enqueued, 0);
  assert.equal(t2.skipped, 1);
  assert.match((await api.call("GET", path, { token: o.token })).body.schedules[0].lastError, /previous run had not finished/);
  // The runner finishes it: the schedule shows the result
  const c = await hosted("POST", "/jobs/claim");
  assert.equal(c.body.job.trigger, "schedule");
  const done = await hosted("POST", `/jobs/${c.body.job.id}/complete`, { run: sampleRun([]) });
  const run = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/runs/${done.body.runId}`, { token: o.token })).body.run;
  assert.equal(run.trigger, "schedule");
  assert.equal((await api.call("GET", path, { token: o.token })).body.schedules[0].lastJob.runStatus, "passed");
});

test("another organization can't see or touch this project's jobs and schedules", async () => {
  const other = await signup(api, "intruder");
  assert.equal((await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/jobs`, { token: other.token })).status, 404);
  assert.equal((await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/schedules`, { token: other.token })).status, 404);
  assert.equal((await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/hosted`, { token: other.token })).status, 404);
  const p2 = (await api.call("POST", `/orgs/${other.orgId}/projects`, { token: other.token, body: { name: "x" } })).body.project.id;
  assert.equal((await api.call("POST", `/orgs/${other.orgId}/projects/${p2}/jobs`, { token: other.token, body: { environmentId: envA } })).status, 404);
});
