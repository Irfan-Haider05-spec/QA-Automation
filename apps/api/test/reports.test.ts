/**
 * Client reports: numbers for a project or a client over a period, what's left
 * out (evidence), who may see what, and share links (frozen, expiring, revocable).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, addMember, sampleRun, type TestApi } from "./helpers.js";

let api: TestApi;
let o: Awaited<ReturnType<typeof signup>>;
let clientX: string;
let clientY: string;
let pA: string;
let pB: string;
let pC: string;
const today = new Date().toISOString().slice(0, 10);
const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const report = (q: string, token = o.token) => api.call("GET", `/orgs/${o.orgId}/reports?${q}`, { token });

before(async () => {
  api = await startApi();
  o = await signup(api, "reports", "Northwind Digital");
  const client = async (name: string) => (await api.call("POST", `/orgs/${o.orgId}/clients`, { token: o.token, body: { name } })).body.client.id;
  clientX = await client("Contoso");
  clientY = await client("Fabrikam");
  const project = async (name: string, clientId: string | null) => (await api.call("POST", `/orgs/${o.orgId}/projects`, { token: o.token, body: { name, clientId } })).body.project.id;
  pA = await project("Contoso API", clientX);
  pB = await project("Contoso Admin", clientX);
  pC = await project("Fabrikam Shop", clientY);
  const key = async (p: string) => (await api.call("POST", `/orgs/${o.orgId}/projects/${p}/api-keys`, { token: o.token, body: { name: "ci" } })).body.key;
  const [kA, kB, kC] = [await key(pA), await key(pB), await key(pC)];
  const up = (k: string, f: Parameters<typeof sampleRun>[0]) => api.call("POST", "/runner/runs", { token: k, body: sampleRun(f) });
  // Contoso API: fails with two issues, then a full passing run fixes both
  await up(kA, [{ fp: "rep-crit-1", severity: "critical" }, { fp: "rep-high-1" }]);
  await up(kA, []);
  // Contoso Admin: one medium issue stays open, one high gets accepted
  await up(kB, [{ fp: "rep-med-1", severity: "medium" }, { fp: "rep-high-2" }]);
  const issues = (await api.call("GET", `/orgs/${o.orgId}/projects/${pB}/issues?status=open`, { token: o.token })).body.issues;
  const high = issues.find((i: any) => i.severity === "high");
  await api.call("PATCH", `/orgs/${o.orgId}/projects/${pB}/issues/${high.id}`, { token: o.token, body: { status: "known", reason: "Fix scheduled for v2", until: "2099-01-31" } });
  await up(kC, [{ fp: "rep-crit-2", severity: "critical" }]);
});
after(async () => { await api.close(); });

test("client report: totals, per-project rows, open and fixed issues, days", async () => {
  const r = await report(`scope=client&id=${clientX}&from=${weekAgo}&to=${today}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rep = r.body.report;
  assert.equal(rep.org.name, "Northwind Digital");
  assert.equal(rep.scope.name, "Contoso");
  assert.deepEqual(rep.totals, {
    projects: 2, runs: 3, passed: 1, failed: 2, envErrors: 0, passRate: 33,
    openIssues: 1, openBySeverity: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
    newIssues: 4, fixedIssues: 2, regressions: 0,
  });
  assert.equal(rep.days.length, 8);
  assert.equal(rep.days.at(-1).date, today);
  assert.equal(rep.days.at(-1).passed + rep.days.at(-1).failed, 3);
  const api_ = rep.projects.find((p: any) => p.name === "Contoso API");
  assert.equal(api_.passRate, 50);
  assert.equal(api_.lastRun.status, "passed");
  assert.equal(api_.fixedInPeriod, 2);
  const admin = rep.projects.find((p: any) => p.name === "Contoso Admin");
  assert.equal(admin.accepted, 1);
  assert.deepEqual(rep.openIssues.map((i: any) => [i.project, i.severity, i.status]), [["Contoso Admin", "high", "accepted"], ["Contoso Admin", "medium", "open"]]);
  assert.equal(rep.openIssues[0].acceptedReason, "Fix scheduled for v2");
  assert.equal(rep.openIssues[0].acceptedUntil, "2099-01-31");
  assert.deepEqual(rep.fixedIssues.map((i: any) => i.severity), ["critical", "high"]);
  // Nothing from other clients, no raw evidence
  const text = JSON.stringify(rep);
  assert.equal(text.includes("Fabrikam"), false);
  assert.equal(text.includes("curl") || text.includes("Bearer") || text.includes("staging.example.com"), false);
});

test("project report, and an empty period", async () => {
  const r = (await report(`scope=project&id=${pC}&from=${weekAgo}&to=${today}`)).body.report;
  assert.equal(r.scope.name, "Fabrikam Shop");
  assert.equal(r.totals.openBySeverity.critical, 1);
  const old = (await report(`scope=project&id=${pC}&from=2025-01-01&to=2025-01-31`)).body.report;
  assert.equal(old.totals.runs, 0);
  assert.equal(old.totals.passRate, null);
  assert.equal(old.totals.newIssues, 0);
  assert.equal(old.days.length, 31);
});

test("report period and scope are validated", async () => {
  assert.equal((await report(`scope=client&id=${clientX}&from=${today}&to=${weekAgo}`)).status, 400);
  assert.equal((await report(`scope=client&id=${clientX}&from=2024-01-01&to=2025-06-01`)).status, 400);
  assert.equal((await report(`scope=client&id=${clientX}&from=2025-13-40&to=2025-14-01`)).status, 400);
  assert.equal((await report(`scope=team&id=${clientX}&from=${weekAgo}&to=${today}`)).status, 400);
  assert.equal((await report(`scope=client&id=00000000-0000-4000-8000-000000000000&from=${weekAgo}&to=${today}`)).status, 404);
});

test("members limited to a client only get that client's reports", async () => {
  const m = await addMember(api, o, "developer", [clientY]);
  assert.equal((await report(`scope=client&id=${clientY}&from=${weekAgo}&to=${today}`, m.token)).status, 200);
  assert.equal((await report(`scope=client&id=${clientX}&from=${weekAgo}&to=${today}`, m.token)).status, 404);
  assert.equal((await report(`scope=project&id=${pA}&from=${weekAgo}&to=${today}`, m.token)).status, 404);
  const outsider = await signup(api, "outsider");
  assert.equal((await report(`scope=client&id=${clientX}&from=${weekAgo}&to=${today}`, outsider.token)).status, 404);
});

test("share links: owners/admins only, frozen snapshot, view count, revoke, expiry", async () => {
  const path = `/orgs/${o.orgId}/report-shares`;
  const dev = await addMember(api, o, "developer");
  assert.equal((await api.call("POST", path, { token: dev.token, body: { scope: "client", id: clientX, from: weekAgo, to: today } })).status, 403);
  assert.equal((await api.call("GET", path, { token: dev.token })).status, 403);

  const s = await api.call("POST", path, { token: o.token, body: { scope: "client", id: clientX, from: weekAgo, to: today, expiresInDays: 14 } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.match(s.body.token, /^qar_/);
  const days = (new Date(s.body.share.expiresAt).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 13.9 && days < 14.1);
  assert.equal(JSON.stringify((await api.call("GET", path, { token: o.token })).body).includes(s.body.token), false, "the token is shown once");

  // Anyone with the link, no login
  const pub = await fetch(`${api.url}/api/v1/public/reports/${s.body.token}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get("cache-control"), "no-store");
  assert.equal(pub.headers.get("x-robots-tag"), "noindex");
  const body = await pub.json();
  assert.equal(body.report.scope.name, "Contoso");
  assert.equal(body.report.totals.runs, 3);

  // Frozen: a later run doesn't change what the client sees
  const kA = (await api.call("POST", `/orgs/${o.orgId}/projects/${pA}/api-keys`, { token: o.token, body: { name: "ci2" } })).body.key;
  await api.call("POST", "/runner/runs", { token: kA, body: sampleRun([{ fp: "after-share" }]) });
  assert.equal((await api.call("GET", `/public/reports/${s.body.token}`)).body.report.totals.runs, 3);
  assert.equal((await report(`scope=client&id=${clientX}&from=${weekAgo}&to=${today}`)).body.report.totals.runs, 4);
  const listed = (await api.call("GET", path, { token: o.token })).body.shares[0];
  assert.equal(listed.viewCount, 2);
  assert.equal(listed.scopeName, "Contoso");

  // Revoked → gone; wrong or malformed tokens look the same
  assert.equal((await api.call("DELETE", `${path}/${listed.id}`, { token: o.token })).status, 204);
  assert.equal((await api.call("GET", `/public/reports/${s.body.token}`)).status, 404);
  assert.equal((await api.call("DELETE", `${path}/${listed.id}`, { token: o.token })).status, 404);
  assert.equal((await api.call("GET", "/public/reports/qar_doesnotexist_doesnotexist12")).status, 404);
  assert.equal((await api.call("GET", "/public/reports/qar_..%2F..%2Forgs")).status, 404);

  // Expired
  const e = await api.call("POST", path, { token: o.token, body: { scope: "project", id: pC, from: weekAgo, to: today, expiresInDays: 1 } });
  assert.equal((await api.call("GET", `/public/reports/${e.body.token}`)).status, 200);
  await api.db.raw("update report_shares set expires_at = now() - interval '1 minute' where id = $1", [e.body.share.id]);
  assert.equal((await api.call("GET", `/public/reports/${e.body.token}`)).status, 404);
  assert.equal((await api.call("POST", path, { token: o.token, body: { scope: "project", id: pC, from: weekAgo, to: today, expiresInDays: 365 } })).status, 400);
  const audit = (await api.call("GET", `/orgs/${o.orgId}/audit`, { token: o.token })).body.events.map((x: any) => x.action);
  assert.ok(audit.includes("report.shared") && audit.includes("report.unshared"));
});
