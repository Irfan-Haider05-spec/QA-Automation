/**
 * Runner upload and the issue lifecycle: new → fixed (full run only) → reopened
 * as regression; baseline findings start as known; triage rules.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, addMember, sampleRun, type TestApi } from "./helpers.js";

let api: TestApi;
let o: Awaited<ReturnType<typeof signup>>;
let projectId: string;
let key: string;
const upload = (body: unknown, k = key) => api.call("POST", "/runner/runs", { token: k, body });
const issues = async (status = "all") => (await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/issues?status=${status}`, { token: o.token })).body.issues as any[];

before(async () => {
  api = await startApi();
  o = await signup(api, "runner");
  projectId = (await api.call("POST", `/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "API" } })).body.project.id;
  const k = await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/api-keys`, { token: o.token, body: { name: "CI" } });
  assert.equal(k.status, 201);
  assert.match(k.body.key, /^qak_/);
  key = k.body.key;
  const list = await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/api-keys`, { token: o.token });
  assert.equal(JSON.stringify(list.body).includes(key), false);
});
after(async () => { await api.close(); });

test("upload creates a run and new issues", async () => {
  const r = await upload(sampleRun([{ fp: "aaaaaa1" }, { fp: "bbbbbb2", severity: "critical" }]));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.newIssues, 2);
  assert.equal(r.body.status, "failed");
  const open = await issues("open");
  assert.equal(open.length, 2);
  assert.equal(open[0].severity, "critical");
  const run = await api.call("GET", `/orgs/${o.orgId}/projects/${projectId}/runs/${r.body.runId}`, { token: o.token });
  assert.equal(run.body.run.findings.length, 2);
  assert.equal(run.body.run.plugins.length >= 2, true);
});

test("a partial (diff-selected) run never closes issues", async () => {
  const r = await upload(sampleRun([{ fp: "aaaaaa1" }], { selected: 3, total: 10 }));
  assert.equal(r.body.fixedIssues, 0);
  assert.equal((await issues("open")).length, 2);
});

test("a skipped plugin never closes its issues", async () => {
  const r = await upload(sampleRun([], { skipPlugins: ["api-auth"] }));
  assert.equal(r.body.fixedIssues, 0);
});

test("a full run without the finding marks it fixed; seeing it again reopens it", async () => {
  const r = await upload(sampleRun([{ fp: "aaaaaa1" }]));
  assert.equal(r.body.fixedIssues, 1);
  const fixed = (await issues("fixed"))[0];
  assert.equal(fixed.fingerprint, "bbbbbb2");
  const again = await upload(sampleRun([{ fp: "aaaaaa1" }, { fp: "bbbbbb2", severity: "critical" }]));
  assert.equal(again.body.reopenedIssues, 1);
  const reopened = (await issues("open")).find((i) => i.fingerprint === "bbbbbb2");
  assert.equal(reopened.statusReason, "Regression: found again after being fixed");
  assert.equal(reopened.occurrences, 2);
});

test("baseline findings start as known and don't count as open", async () => {
  await upload(sampleRun([{ fp: "cccccc3", known: true }, { fp: "aaaaaa1" }, { fp: "bbbbbb2" }]));
  const known = await issues("known");
  assert.equal(known.length, 1);
  assert.equal(known[0].fingerprint, "cccccc3");
});

test("triage: known/ignored need a reason; viewers can't triage", async () => {
  const issue = (await issues("open"))[0];
  const path = `/orgs/${o.orgId}/projects/${projectId}/issues/${issue.id}`;
  assert.equal((await api.call("PATCH", path, { token: o.token, body: { status: "ignored" } })).status, 400);
  const ok = await api.call("PATCH", path, { token: o.token, body: { status: "known", reason: "Accepted until the auth refactor", until: "2099-01-01", assigneeId: o.userId } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.issue.status, "known");
  assert.equal(ok.body.issue.assigneeId, o.userId);
  const v = await addMember(api, o, "viewer");
  assert.equal((await api.call("PATCH", path, { token: v.token, body: { status: "open" } })).status, 403);
  const stranger = await signup(api, "x");
  assert.equal((await api.call("PATCH", path, { token: o.token, body: { assigneeId: stranger.userId } })).status, 400);
});

test("runner auth: missing, wrong and revoked keys; foreign environment", async () => {
  assert.equal((await api.call("POST", "/runner/runs", { body: sampleRun([]) })).status, 401);
  assert.equal((await upload(sampleRun([]), "qak_not-a-real-key")).status, 401);
  // A user JWT is not an API key
  assert.equal((await upload(sampleRun([]), o.token)).status, 401);

  const other = await signup(api, "other");
  const otherProject = (await api.call("POST", `/orgs/${other.orgId}/projects`, { token: other.token, body: { name: "P" } })).body.project.id;
  const otherEnv = (await api.call("POST", `/orgs/${other.orgId}/projects/${otherProject}/environments`, { token: other.token, body: { name: "stg", apiBaseUrl: "https://o.example.com" } })).body.environment.id;
  assert.equal((await upload({ ...sampleRun([]), environmentId: otherEnv })).status, 404);

  const k2 = await api.call("POST", `/orgs/${o.orgId}/projects/${projectId}/api-keys`, { token: o.token, body: { name: "temp" } });
  assert.equal((await api.call("DELETE", `/orgs/${o.orgId}/projects/${projectId}/api-keys/${k2.body.apiKey.id}`, { token: o.token })).status, 204);
  assert.equal((await upload(sampleRun([]), k2.body.key)).status, 401);
});

test("upload validation rejects malformed payloads", async () => {
  const bad = await upload({ suite: "x" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "validation_error");
});

test("project list carries recent runs (oldest first) and open counts", async () => {
  const list = await api.call("GET", `/orgs/${o.orgId}/projects`, { token: o.token });
  const p = list.body.projects.find((x: any) => x.id === projectId);
  assert.ok(p.recentRuns.length >= 5 && p.recentRuns.length <= 14);
  const times = p.recentRuns.map((r: any) => new Date(r.createdAt).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(p.lastRun.id, p.recentRuns[p.recentRuns.length - 1].id);
  assert.equal(typeof p.openIssues, "number");
});

test("audit log records who did what, readable by owners", async () => {
  const a = await api.call("GET", `/orgs/${o.orgId}/audit`, { token: o.token });
  assert.equal(a.status, 200);
  const actions = new Set(a.body.events.map((e: any) => e.action));
  for (const x of ["project.created", "api_key.created", "run.uploaded", "issue.triaged"]) assert.ok(actions.has(x), x);
});
