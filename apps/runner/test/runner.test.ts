/**
 * Hosted runner, end to end: the fixture API (planted bugs) plays the
 * customer's staging; a CI upload gives the platform the route list; "Run now"
 * queues a job; the runner runs the engine without any source code and the
 * findings land on the platform as issues. Plus cancelling a running job and
 * the config builder's rules (secrets only in env vars, gentle rate, write
 * tests only on disposable databases).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApi, signup, type TestApi } from "../../api/test/helpers.js";
import { PlatformClient } from "../src/platform.js";
import { processOne } from "../src/loop.js";
import { buildConfig, pluginsFor, MAX_REQUESTS_PER_MINUTE, type ClaimPayload } from "../src/job.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TOKEN = "runner-token-for-tests-0123456789abcdef";
const FIXTURE_PORT = 4016;
const ACCOUNTS: Array<[string, string, string, string, string]> = [
  ["merchantA", "MERCHANT", "merchant-a@qa.test", "merchant", "QaPass#1"],
  ["merchantB", "MERCHANT", "merchant-b@qa.test", "merchant", "QaPass#2"],
  ["customer", "USER", "customer@qa.test", "user", "QaPass#3"],
  ["admin", "SUPER_ADMIN", "admin@qa.test", "admin", "QaPass#4"],
];

let api: TestApi;
let fixture: ChildProcess;
let o: Awaited<ReturnType<typeof signup>>;
let projectId: string;
let envId: string;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-runner-test-"));
const opts = { engineDir: root, workDir, timeoutMs: 170_000, tickMs: 500 };
const client = () => new PlatformClient(api.url, TOKEN, "test-runner");

function run(cmd: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(process.execPath, cmd, { cwd: root, env: { ...process.env, ...env } });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });
}

before(async () => {
  api = await startApi({ RUNNER_TOKEN: TOKEN });
  fixture = spawn(process.execPath, ["--import", "tsx", path.join(root, "test/fixture-api/src/server.ts")], { env: { ...process.env, PORT: String(FIXTURE_PORT), CLIENT_URL: "http://localhost:5173" }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${FIXTURE_PORT}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  o = await signup(api, "runner");
  projectId = (await api.call("POST", `/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Fixture shop" } })).body.project.id;
  envId = (await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/environments`, { token: o.token, body: { name: "staging", apiBaseUrl: `http://127.0.0.1:${FIXTURE_PORT}` } })).body.environment.id;
  for (const [name, role, identifier, device, secret] of ACCOUNTS) {
    const c = await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/environments/${envId}/credentials`, { token: o.token, body: { name, role, identifier, device, secret } });
    assert.equal(c.status, 201);
  }
  // Proving domain ownership over http needs a file on the fixture; mark it verified directly
  await api.db.raw("update environments set verified_at = now() where id = $1", [envId]);
});
after(async () => {
  fixture?.kill();
  await api?.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

test("CI upload from source gives the platform the project profile", async () => {
  const key = (await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/api-keys`, { token: o.token, body: { name: "ci" } })).body.key;
  const r = await run(["--import", "tsx", "src/cli.ts", "run", "-c", "test/fixture.config.ts", "--suite", "local", "--out", path.join(workDir, "ci-out"), "--upload"], {
    QA_PLATFORM_URL: api.url, QA_PLATFORM_API_KEY: key, GITHUB_ACTIONS: "",
  });
  assert.match(r.out, /Uploaded to platform/, r.out.slice(-1500));
  const s = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/hosted`, { token: o.token })).body;
  const fixtureRoutes = Number(r.out.match(/(\d+) routes discovered/)?.[1]);
  assert.ok(fixtureRoutes >= 19);
  assert.equal(s.profile.routesCount, fixtureRoutes, "every route discovered from source is in the profile");
  assert.equal(s.environments[0].canRun, true);
  // The stored profile holds no logins or source locations
  const [row] = await api.db.raw<{ profile: any }>("select profile from project_profiles where project_id = $1", [projectId]);
  const text = JSON.stringify(row.profile);
  for (const secret of ["QaPass#1", "merchant-a@qa.test", "\"source\"", "routerFile"]) assert.equal(text.includes(secret), false, `profile contains ${secret}`);
});

test("Run now → the hosted runner tests the deployment without source and reports the planted bugs", async () => {
  const j = await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/jobs`, { token: o.token, body: { environmentId: envId, suite: "staging" } });
  assert.equal(j.status, 201);
  const logs: string[] = [];
  assert.equal(await processOne(client(), opts, (m) => logs.push(m)), true);
  assert.equal(await processOne(client(), opts), false, "queue is empty afterwards");

  const job = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/jobs`, { token: o.token })).body.jobs.find((x: any) => x.id === j.body.job.id);
  assert.equal(job.status, "done", `${job.error ?? ""}\n${logs.join("\n")}`);
  const run = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/runs/${job.runId}`, { token: o.token })).body.run;
  assert.equal(run.source, "hosted");
  assert.equal(run.trigger, "manual");
  assert.equal(run.environmentId, envId);
  assert.deepEqual(run.plugins.map((p: any) => p.plugin).sort(), ["api-auth", "api-smoke", "health-cors", "tenant-isolation"]);
  const titles = run.findings.map((f: any) => `${f.plugin}: ${f.title}`);
  assert.ok(titles.some((t: string) => /api-auth: Confirmed live: route answers without any token/.test(t)), titles.join("\n"));
  assert.ok(titles.some((t: string) => /api-auth: Role bypass/.test(t)), titles.join("\n"));
  assert.ok(titles.some((t: string) => /tenant-isolation:/.test(t)), titles.join("\n"));
  assert.equal(run.status, "failed");
  assert.ok(job.run.newIssues > 0);
  assert.equal(JSON.stringify(run).includes("QaPass#"), false, "no password in the stored run");
  assert.equal(fs.readdirSync(workDir).filter((f) => f.startsWith("job-")).length, 0, "job folder removed");
});

test("cancelling while the engine runs stops it and records the job as cancelled", async () => {
  const j = (await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/jobs`, { token: o.token, body: { environmentId: envId, suite: "nightly" } })).body.job;
  const started = Date.now();
  const working = processOne(client(), opts);
  for (let i = 0; i < 100; i++) {
    const s = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/jobs`, { token: o.token })).body.jobs.find((x: any) => x.id === j.id);
    if (s.status === "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/jobs/${j.id}/cancel`, { token: o.token });
  await working;
  const s = (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/jobs`, { token: o.token })).body.jobs.find((x: any) => x.id === j.id);
  assert.equal(s.status, "cancelled");
  assert.equal(s.runId, null);
  assert.ok(Date.now() - started < 30_000, "stopped promptly");
});

test("a job with nothing to test is reported as an error, not run", async () => {
  const p: ClaimPayload = {
    job: { id: "00000000-0000-4000-8000-000000000001", suite: "staging", trigger: "manual", attempts: 1 },
    project: { id: "p", name: "P" },
    environment: { id: "e", name: "e", apiBaseUrl: "https://x.test", webApps: [], disposable: false, domain: "x.test" },
    profile: null, checks: { api: false, web: false }, accounts: [],
  };
  assert.deepEqual(pluginsFor(p), []);
});

test("config builder: logins only in env vars, capped rate, write tests only on disposable databases", () => {
  const profile = {
    version: 1 as const, apiPrefix: "/api/v1", healthPath: "/healthz", login: { path: "/api/v1/auth/login", tokenPath: "data.token" },
    accounts: { owner1: { role: "MERCHANT" }, rival: { role: "MERCHANT" } }, publicRoutes: [], privilegedPrefixes: ["/admin"],
    tenantIsolation: { owner: "owner1", attacker: "rival", sharedResources: ["GET /x/:id"], pairs: [], maxIdsPerRoute: 2 },
    cors: { allowedOrigins: [], probeOrigin: "https://evil.example" }, pathParams: { orgId: "o-1" }, gateFailOn: "medium" as const,
    web: { slowMs: 2500, ignoreConsole: ["ResizeObserver"], apps: [{ name: "admin", loginPath: "/signin", account: "rival", seedRoutes: ["/home"], excludePaths: [], maxPages: 500 }] },
    routes: [],
  };
  const p: ClaimPayload = {
    job: { id: "00000000-0000-4000-8000-000000000002", suite: "nightly", trigger: "schedule", attempts: 1 },
    project: { id: "p", name: "Shop" },
    environment: { id: "e", name: "staging", apiBaseUrl: "https://api.shop.test", webApps: [{ name: "admin", baseUrl: "https://shop.test/admin", loginPath: "" }, { name: "other", baseUrl: "https://shop.test/other", loginPath: "/login" }], disposable: false, domain: "shop.test" },
    profile, checks: { api: true, web: true },
    accounts: [{ name: "a", role: "MERCHANT", identifier: "a@shop.test", device: null, secret: "pw-a-123" }, { name: "rival", role: "MERCHANT", identifier: "r@shop.test", device: "web", secret: "pw-r-456" }],
  };
  const { config, env, plugins } = buildConfig(p, "/tmp/x");
  const text = JSON.stringify(config);
  assert.equal(text.includes("pw-a-123") || text.includes("a@shop.test"), false, "no logins in the config file");
  assert.deepEqual(Object.values(env).sort(), ["a@shop.test", "pw-a-123", "pw-r-456", "r@shop.test"].sort());
  assert.equal(config.accounts.rival.passwordEnv, "QA_HOSTED_1_PASS");
  assert.equal(config.target.requestsPerMinute, MAX_REQUESTS_PER_MINUTE);
  assert.equal(config.allowMutations, false);
  assert.equal(buildConfig({ ...p, environment: { ...p.environment, disposable: true } }, "/tmp/x").config.allowMutations, true);
  // The profile's owner account isn't stored here: fall back to an account that exists
  assert.deepEqual([config.tenantIsolation.owner, config.tenantIsolation.attacker], ["a", "rival"]);
  assert.deepEqual(config.tenantIsolation.sharedResources, ["GET /x/:id"]);
  assert.equal(config.backend.healthPath, "/healthz");
  assert.equal(config.gate.failOn, "medium");
  assert.deepEqual(plugins, ["health-cors", "api-auth", "api-smoke", "tenant-isolation", "load-smoke", "web-crawl", "web-a11y", "lighthouse", "zap-baseline"]);
  assert.equal(config.load.maxRps * 60, MAX_REQUESTS_PER_MINUTE, "load smoke stays within the hosted request budget");
  assert.equal(config.zap.engine, "builtin");
  const [admin, other] = config.web.apps;
  assert.deepEqual([admin.loginPath, admin.account, admin.seedRoutes, admin.maxPages], ["/signin", "rival", ["/home"], 60]);
  assert.deepEqual([other.loginPath, other.account, other.seedRoutes], ["/login", "a", ["/"]]);
  // Dashboard only, no profile: only web checks
  assert.deepEqual(pluginsFor({ ...p, profile: null, checks: { api: false, web: true } }), ["web-crawl", "web-a11y", "lighthouse", "zap-baseline"]);
  assert.deepEqual(pluginsFor({ ...p, job: { ...p.job, suite: "staging" } }), ["health-cors", "api-auth", "api-smoke", "tenant-isolation", "web-crawl"]);
});
