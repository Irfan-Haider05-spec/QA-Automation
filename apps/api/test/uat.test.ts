import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, addMember, sampleRun, type TestApi } from "./helpers.js";

let api: TestApi;
let owner: Awaited<ReturnType<typeof signup>>;
let projectA: string;
let projectB: string;
let clientA: string;
let runA: string;
let runB: string;
let keyA: string;
let keyB: string;
const base = (projectId: string) => `/orgs/${owner.orgId}/projects/${projectId}/uat`;

before(async () => {
  api = await startApi();
  owner = await signup(api, "uat", "UAT Org");
  clientA = (await api.call("POST", `/orgs/${owner.orgId}/clients`, { token: owner.token, body: { name: "Client A" } })).body.client.id;
  const clientB = (await api.call("POST", `/orgs/${owner.orgId}/clients`, { token: owner.token, body: { name: "Client B" } })).body.client.id;
  projectA = (await api.call("POST", `/orgs/${owner.orgId}/projects`, { token: owner.token, body: { name: "Loyalty API", clientId: clientA } })).body.project.id;
  projectB = (await api.call("POST", `/orgs/${owner.orgId}/projects`, { token: owner.token, body: { name: "Other App", clientId: clientB } })).body.project.id;
  keyA = (await api.call("POST", `/orgs/${owner.orgId}/projects/${projectA}/api-keys`, { token: owner.token, body: { name: "A" } })).body.key;
  keyB = (await api.call("POST", `/orgs/${owner.orgId}/projects/${projectB}/api-keys`, { token: owner.token, body: { name: "B" } })).body.key;
  runA = (await api.call("POST", "/runner/runs", { token: keyA, body: sampleRun([]) })).body.runId;
  runB = (await api.call("POST", "/runner/runs", { token: keyB, body: sampleRun([]) })).body.runId;
});
after(async () => { if (api) await api.close(); });

test("a release goes from criteria to recorded results to sign-off, and is locked until reopened", async () => {
  const dev = await addMember(api, owner, "developer", [clientA]);
  const admin = await addMember(api, owner, "admin");
  const created = await api.call("POST", `${base(projectA)}/releases`, { token: dev.token, body: {
    name: "v2.3 Promotions", description: "Promotion creation for merchants",
    criteria: [
      { title: "Merchant can create a 15% promotion", steps: "Given a merchant\nWhen they create a 15% promotion\nThen customers see it", scenario: "Merchant creates a promotion and reads it back" },
      { title: "Another merchant cannot see it" },
    ],
  } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rel = created.body.release;
  assert.equal(rel.status, "open");
  assert.deepEqual(rel.counts, { total: 2, untested: 2, passed: 0, failed: 0, blocked: 0 });
  assert.equal(rel.createdByName.startsWith("developer"), true);
  const [c1, c2] = created.body.criteria;
  assert.equal(c1.position, 1);
  assert.equal(c1.steps.split("\n").length, 3);

  const dup = await api.call("POST", `${base(projectA)}/releases`, { token: dev.token, body: { name: "V2.3 PROMOTIONS" } });
  assert.equal(dup.status, 409, "names are unique per project, ignoring case");

  const path = (c: string) => `${base(projectA)}/releases/${rel.id}/criteria/${c}`;
  const failNoNote = await api.call("PATCH", path(c2.id), { token: dev.token, body: { status: "failed" } });
  assert.equal(failNoNote.status, 400);
  const failed = await api.call("PATCH", path(c2.id), { token: dev.token, body: { status: "failed", note: "Merchant B saw the promotion" } });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.criterion.status, "failed");
  assert.equal(failed.body.criterion.testedBy, dev.userId);
  assert.ok(failed.body.criterion.testedAt);

  const foreignRun = await api.call("PATCH", path(c1.id), { token: dev.token, body: { evidenceRunId: runB } });
  assert.equal(foreignRun.status, 400, "evidence must be a run of the same project");
  const passed = await api.call("PATCH", path(c1.id), { token: dev.token, body: { status: "passed", evidenceRunId: runA } });
  assert.equal(passed.body.criterion.evidenceRunId, runA);
  assert.equal(passed.body.criterion.evidenceRunStatus, "passed");

  const devDecides = await api.call("POST", `${base(projectA)}/releases/${rel.id}/decision`, { token: dev.token, body: { decision: "signed_off" } });
  assert.equal(devDecides.status, 403, "developers record results; owners and admins decide");
  const notReady = await api.call("POST", `${base(projectA)}/releases/${rel.id}/decision`, { token: admin.token, body: { decision: "signed_off" } });
  assert.equal(notReady.status, 422);
  assert.match(notReady.body.error.message, /1 criterion has not passed/);

  const renamed = await api.call("PATCH", path(c2.id), { token: dev.token, body: { title: "Merchant B cannot open merchant A's promotion" } });
  assert.equal(renamed.body.criterion.status, "failed", "editing the text keeps the recorded result");
  const retest = await api.call("PATCH", path(c2.id), { token: dev.token, body: { status: "passed" } });
  assert.equal(retest.body.criterion.note, null, "a new status without a note clears the old note");
  const signed = await api.call("POST", `${base(projectA)}/releases/${rel.id}/decision`, { token: admin.token, body: { decision: "signed_off", note: "Approved for release" } });
  assert.equal(signed.status, 200);
  assert.equal(signed.body.release.status, "signed_off");
  assert.equal(signed.body.release.decidedBy, admin.userId);

  for (const [m, p, body] of [["PATCH", path(c1.id), { status: "failed", note: "late change" }], ["POST", `${base(projectA)}/releases/${rel.id}/criteria`, { title: "late" }], ["DELETE", path(c1.id), undefined], ["PATCH", `${base(projectA)}/releases/${rel.id}`, { name: "renamed" }], ["POST", `${base(projectA)}/releases/${rel.id}/decision`, { decision: "rejected", note: "again" }]] as const) {
    const r = await api.call(m, p, { token: admin.token, body });
    assert.equal(r.status, 409, `${m} ${p}`);
    assert.equal(r.body.error.code, "release_locked");
  }

  assert.equal((await api.call("POST", `${base(projectA)}/releases/${rel.id}/reopen`, { token: admin.token, body: { reason: "" } })).status, 400);
  const reopened = await api.call("POST", `${base(projectA)}/releases/${rel.id}/reopen`, { token: owner.token, body: { reason: "Found a regression in staging" } });
  assert.equal(reopened.body.release.status, "open");
  assert.equal(reopened.body.release.decidedAt, null);
  const rejectNoNote = await api.call("POST", `${base(projectA)}/releases/${rel.id}/decision`, { token: owner.token, body: { decision: "rejected" } });
  assert.equal(rejectNoNote.status, 400);
  const rejected = await api.call("POST", `${base(projectA)}/releases/${rel.id}/decision`, { token: owner.token, body: { decision: "rejected", note: "Regression in discount rounding" } });
  assert.equal(rejected.body.release.status, "rejected");
  assert.equal(rejected.body.release.decisionNote, "Regression in discount rounding");

  const auditLog = await api.call("GET", `/orgs/${owner.orgId}/audit`, { token: owner.token });
  const actions = auditLog.body.events.map((e: { action: string }) => e.action).filter((a: string) => a.startsWith("uat."));
  for (const a of ["uat.release_created", "uat.criterion_tested", "uat.criterion_updated", "uat.signed_off", "uat.reopened", "uat.rejected"]) assert.ok(actions.includes(a), a);
});

test("the report exports as JSON and Markdown with table cells escaped", async () => {
  const r = (await api.call("POST", `${base(projectA)}/releases`, { token: owner.token, body: { name: "Report | release", criteria: [{ title: "Pipe | and\nnewline in title" }, { title: "Second" }] } })).body;
  await api.call("PATCH", `${base(projectA)}/releases/${r.release.id}/criteria/${r.criteria[0].id}`, { token: owner.token, body: { status: "blocked", note: "Staging down | waiting" } });
  const json = await api.call("GET", `${base(projectA)}/releases/${r.release.id}/report`, { token: owner.token });
  assert.equal(json.body.project, "Loyalty API");
  assert.equal(json.body.criteria.length, 2);
  const res = await fetch(`${api.url}/api/v1${base(projectA)}/releases/${r.release.id}/report?format=md`, { headers: { authorization: `Bearer ${owner.token}` } });
  assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="uat-report-release.md"');
  const md = await res.text();
  assert.match(md, /^# UAT report: Report \\\| release$/m);
  assert.match(md, /Criteria: 2 \(passed 0, failed 0, blocked 1, untested 1\)/);
  assert.match(md, /\| 1 \| Pipe \\\| and newline in title \| Blocked \| .+ \| Staging down \\\| waiting \| — \| — \|$/m, "no evidence run and no linked scenario");
});

test("tenant, client scope, viewer and id checks", async () => {
  const r = (await api.call("POST", `${base(projectA)}/releases`, { token: owner.token, body: { name: "Scoped", criteria: [{ title: "x" }] } })).body;
  const stranger = await signup(api, "outsider");
  assert.equal((await api.call("GET", `${base(projectA)}/releases/${r.release.id}`, { token: stranger.token })).status, 404, "non-members get 404 so ids cannot be probed");
  const scopedDev = await addMember(api, owner, "developer", [clientA]);
  assert.equal((await api.call("GET", `${base(projectB)}/releases`, { token: scopedDev.token })).status, 404, "a client-scoped member cannot reach another client's project");
  assert.equal((await api.call("GET", `${base(projectB)}/scenarios`, { token: scopedDev.token })).status, 404, "nor its scenario names");
  assert.equal((await api.call("GET", `${base(projectA)}/scenarios`, { token: stranger.token })).status, 404);
  assert.equal((await api.call("GET", `/orgs/${owner.orgId}/projects/${projectB}/uat/releases/${r.release.id}`, { token: owner.token })).status, 404, "a release id from another project is not found");
  const viewer = await addMember(api, owner, "viewer");
  assert.equal((await api.call("GET", `${base(projectA)}/releases/${r.release.id}`, { token: viewer.token })).status, 200);
  assert.equal((await api.call("PATCH", `${base(projectA)}/releases/${r.release.id}/criteria/${r.criteria[0].id}`, { token: viewer.token, body: { status: "passed" } })).status, 403);
  assert.equal((await api.call("POST", `${base(projectA)}/releases`, { token: viewer.token, body: { name: "Viewer release" } })).status, 403);
  assert.equal((await api.call("GET", `${base(projectA)}/releases/not-a-uuid`, { token: owner.token })).status, 404);
  const list = await api.call("GET", `${base(projectA)}/releases?status=open`, { token: owner.token });
  assert.ok(list.body.releases.every((x: { status: string }) => x.status === "open"));
  const other = await signup(api, "other-org", "Other Org");
  const otherProject = (await api.call("POST", `/orgs/${other.orgId}/projects`, { token: other.token, body: { name: "Theirs" } })).body.project.id;
  assert.equal((await api.call("GET", `/orgs/${other.orgId}/projects/${otherProject}/uat/releases/${r.release.id}`, { token: other.token })).status, 404, "row-level security keeps releases inside their org");
});

test("a criterion linked to a scenario shows the scenario's latest automated result, which can be attached as evidence", async () => {
  const name = "Merchant promotion lifecycle (create, read, update, pause, delete)";
  const withCases = (cases: unknown[], plugin = "api-scenarios") => {
    const run = sampleRun([]) as any;
    run.results.push({ plugin, status: "passed", durationMs: 900, findings: [], cases });
    return run;
  };
  const r = (await api.call("POST", `${base(projectA)}/releases`, { token: owner.token, body: { name: "Automated evidence", criteria: [
    { title: "Merchants manage their promotions", scenario: name }, { title: "Manual only" }, { title: "Not run yet", scenario: "Never uploaded" },
  ] } })).body;
  const path = `${base(projectA)}/releases/${r.release.id}`;
  let got = (await api.call("GET", path, { token: owner.token })).body.criteria;
  assert.equal(got[0].automatedStatus, null, "no uploaded run has the scenario yet");

  const first = await api.call("POST", "/runner/runs", { token: keyA, body: withCases([{ name, status: "failed", tags: ["uat"], ms: 400 }, { name: "Other", status: "passed" }]) });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await new Promise((res) => setTimeout(res, 15));
  const second = await api.call("POST", "/runner/runs", { token: keyA, body: withCases([{ name, status: "passed", tags: ["uat", "regression"], ms: 380 }]) });
  // The same scenario name in another project must not leak in.
  await api.call("POST", "/runner/runs", { token: keyB, body: withCases([{ name, status: "failed" }]) });
  const invalid = await api.call("POST", "/runner/runs", { token: keyA, body: withCases([{ name: "", status: "passed" }]) });
  assert.equal(invalid.status, 400, "cases are validated like the rest of the upload");
  const badStatus = await api.call("POST", "/runner/runs", { token: keyA, body: withCases([{ name: "x", status: "maybe" }]) });
  assert.equal(badStatus.status, 400);

  const listed = (await api.call("GET", `${base(projectA)}/scenarios`, { token: owner.token })).body.scenarios;
  assert.deepEqual(listed.map((s: any) => [s.name, s.status, s.tags]), [[name, "passed", ["uat", "regression"]], ["Other", "passed", []]],
    "each scenario once, with its latest result; another project's runs never appear");
  assert.equal(listed[0].runId, second.body.runId);
  assert.deepEqual((await api.call("GET", `${base(projectA)}/scenarios?tag=regression`, { token: owner.token })).body.scenarios.map((s: any) => s.name), [name]);
  assert.equal((await api.call("GET", `${base(projectB)}/scenarios`, { token: owner.token })).body.scenarios.length, 1);

  got = (await api.call("GET", path, { token: owner.token })).body.criteria;
  assert.equal(got[0].automatedStatus, "passed", "the latest run wins");
  assert.equal(got[0].automatedRunId, second.body.runId);
  assert.ok(got[0].automatedAt);
  assert.equal(got[1].automatedStatus, null, "a criterion without a scenario has no automated result");
  assert.equal(got[2].automatedStatus, null);

  const attached = await api.call("PATCH", `${path}/criteria/${got[0].id}`, { token: owner.token, body: { status: "passed", evidenceRunId: got[0].automatedRunId } });
  assert.equal(attached.status, 200);
  assert.equal(attached.body.criterion.evidenceRunId, second.body.runId);
  assert.equal(attached.body.criterion.automatedStatus, "passed");

  const res = await fetch(`${api.url}/api/v1${path}/report?format=md`, { headers: { authorization: `Bearer ${owner.token}` } });
  const md = await res.text();
  assert.match(md, new RegExp(`\\| Merchants manage their promotions \\| Passed \\| .+ \\| run ${second.body.runId} \\(passed\\) \\| ${name.replace(/[()]/g, "\\$&")}: Passed in run ${second.body.runId} \\(`));
  assert.match(md, /\| Not run yet \| Untested .+\| Never uploaded: no result yet \|/);
});
