import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { issueSyncTick } from "../src/lib/issue-sync.js";
import { startApi, signup, addMember, sampleRun, type TestApi } from "./helpers.js";

let api: TestApi;
let owner: Awaited<ReturnType<typeof signup>>;
let clientA: string;
let clientB: string;
let projectA: string;
let projectB: string;
let keyA: string;
let keyB: string;
let issueA: string;
let issueB: string;
const base = (projectId: string) => `/orgs/${owner.orgId}/projects/${projectId}`;

before(async () => {
  api = await startApi({ ISSUE_GATEWAY_URL: "https://gateway.test.invalid/issues", ISSUE_GATEWAY_TOKEN: "collaboration-test-gateway-token-123456" });
  owner = await signup(api, "collab", "Collaboration Org");
  clientA = (await api.call("POST", `/orgs/${owner.orgId}/clients`, { token: owner.token, body: { name: "Client A" } })).body.client.id;
  clientB = (await api.call("POST", `/orgs/${owner.orgId}/clients`, { token: owner.token, body: { name: "Client B" } })).body.client.id;
  projectA = (await api.call("POST", `/orgs/${owner.orgId}/projects`, { token: owner.token, body: { name: "App A", clientId: clientA } })).body.project.id;
  projectB = (await api.call("POST", `/orgs/${owner.orgId}/projects`, { token: owner.token, body: { name: "App B", clientId: clientB } })).body.project.id;
  keyA = (await api.call("POST", `${base(projectA)}/api-keys`, { token: owner.token, body: { name: "A key" } })).body.key;
  keyB = (await api.call("POST", `${base(projectB)}/api-keys`, { token: owner.token, body: { name: "B key" } })).body.key;
  await api.call("POST", "/runner/runs", { token: keyA, body: sampleRun([{ fp: "collab-issue-a" }]) });
  await api.call("POST", "/runner/runs", { token: keyB, body: sampleRun([{ fp: "collab-issue-b" }]) });
  issueA = (await api.call("GET", `${base(projectA)}/issues`, { token: owner.token })).body.issues[0].id;
  issueB = (await api.call("GET", `${base(projectB)}/issues`, { token: owner.token })).body.issues[0].id;
});
after(async () => { if (api) await api.close(); });

test("comment CRUD respects tenant, client scope, role and author permissions", async () => {
  const path = `${base(projectA)}/collaboration/issues/${issueA}`;
  const dev = await addMember(api, owner, "developer", [clientA]);
  const viewer = await addMember(api, owner, "viewer", [clientA]);
  const stranger = await signup(api, "outside");

  assert.equal((await api.call("GET", `${base(projectB)}/collaboration/issues/${issueB}/comments`, { token: dev.token })).status, 404);
  assert.equal((await api.call("GET", `${base(projectA)}/collaboration/issues/${issueA}/comments`, { token: stranger.token })).status, 404);
  assert.equal((await api.call("POST", `${base(projectB)}/collaboration/issues/${issueB}/comments`, { token: dev.token, body: { body: "cross client" } })).status, 404);
  const viewerRead = await api.call("GET", `${path}/comments`, { token: viewer.token });
  assert.equal(viewerRead.status, 200, JSON.stringify(viewerRead.body));
  const viewerWrite = await api.call("POST", `${path}/comments`, { token: viewer.token, body: { body: "viewer write" } });
  assert.equal(viewerWrite.status, 403, JSON.stringify(viewerWrite.body));
  assert.equal((await api.call("POST", `${path}/comments`, { token: dev.token, body: { body: "   " } })).status, 400);

  const created = await api.call("POST", `${path}/comments`, { token: dev.token, body: { body: "  Investigating this safely.  " } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const commentId = created.body.comment.id;
  const listed = await api.call("GET", `${path}/comments`, { token: viewer.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.comments[0].body, "Investigating this safely.");
  assert.equal(listed.body.comments[0].authorId, dev.userId);
  assert.equal((await api.call("DELETE", `${path}/comments/${commentId}`, { token: owner.token })).status, 204);

  const ownerComment = await api.call("POST", `${path}/comments`, { token: owner.token, body: { body: "Owner note" } });
  assert.equal((await api.call("DELETE", `${path}/comments/${ownerComment.body.comment.id}`, { token: dev.token })).status, 404);
  assert.equal((await api.call("DELETE", `${path}/comments/${ownerComment.body.comment.id}`, { token: owner.token })).status, 204);
});

test("comment cursor keeps timestamp ties across pages", async () => {
  const timestamp = "2025-01-01T00:00:00.000Z";
  await api.db.raw(`insert into issue_comments(org_id, issue_id, author_id, body, created_at)
    select $1, $2, $3, 'page-' || n, $4::timestamptz + n * interval '1 microsecond' from generate_series(1, 101) n`, [owner.orgId, issueA, owner.userId, timestamp]);
  const path = `${base(projectA)}/collaboration/issues/${issueA}/comments`;
  const first = await api.call("GET", path, { token: owner.token });
  assert.equal(first.body.comments.length, 100);
  assert.ok(first.body.nextBefore);
  const second = await api.call("GET", `${path}?before=${encodeURIComponent(first.body.nextBefore)}`, { token: owner.token });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.comments.length, 1);
  assert.equal(new Set([...first.body.comments, ...second.body.comments].map((c: any) => c.id)).size, 101);
  assert.equal((await api.call("GET", `${path}?before=c:not-a-cursor`, { token: owner.token })).status, 400);
  const malformed = `c:${Buffer.from(JSON.stringify({ createdAt: timestamp, id: "------------------------------------" })).toString("base64url")}`;
  assert.equal((await api.call("GET", `${path}?before=${encodeURIComponent(malformed)}`, { token: owner.token })).status, 400);
  assert.equal((await api.call("GET", `${path}?before=${"x".repeat(1025)}`, { token: owner.token })).status, 400);
});

test("integration writes are admin-only; repeated sync requests dedupe", async () => {
  const collab = `${base(projectA)}/collaboration`;
  const developer = await addMember(api, owner, "developer", [clientA]);
  const viewer = await addMember(api, owner, "viewer", [clientA]);
  const config = { destination: "acme/repo", enabled: true };
  assert.equal((await api.call("PUT", `${collab}/integration`, { token: developer.token, body: config })).status, 403);
  assert.equal((await api.call("PUT", `${collab}/integration`, { token: owner.token, body: config })).status, 200);
  assert.equal((await api.call("POST", `${collab}/issues/${issueA}/sync`, { token: viewer.token, body: {} })).status, 403);

  const path = `${collab}/issues/${issueA}/sync`;
  const first = await api.call("POST", path, { token: developer.token, body: {} });
  const duplicate = await api.call("POST", path, { token: developer.token, body: {} });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(duplicate.status, 202, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.delivery.id, first.body.delivery.id);
});

test("trends aggregate run and plugin outcomes within project and client scope", async () => {
  await api.call("POST", "/runner/runs", { token: keyA, body: sampleRun([]) });
  const path = `${base(projectA)}/runs/trends?days=7`;
  const result = await api.call("GET", path, { token: owner.token });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.windowDays, 7);
  assert.equal(result.body.timezone, "UTC");
  const daily = result.body.days.reduce((sum: number, day: any) => sum + day.runs, 0);
  assert.equal(daily, 2);
  assert.equal(result.body.days.reduce((sum: number, day: any) => sum + day.failed, 0), 1);
  assert.equal(result.body.days.reduce((sum: number, day: any) => sum + day.passed, 0), 1);
  const apiAuth = result.body.plugins.find((p: any) => p.plugin === "api-auth");
  assert.equal(apiAuth.executions, 2);
  assert.equal(apiAuth.failed, 1);
  assert.equal(apiAuth.findings, 1);

  const scoped = await addMember(api, owner, "viewer", [clientA]);
  assert.equal((await api.call("GET", path, { token: scoped.token })).status, 200);
  assert.equal((await api.call("GET", `${base(projectB)}/runs/trends`, { token: scoped.token })).status, 404);
  const outsider = await signup(api, "trends-outsider");
  assert.equal((await api.call("GET", path, { token: outsider.token })).status, 404);
  assert.equal((await api.call("GET", `${base(projectA)}/runs/trends?days=0`, { token: owner.token })).status, 400);
});

test("sync tick skips disabled gateway, retries with stable id and sanitizes failures", async () => {
  const disabled = await issueSyncTick(api.db, { ISSUE_GATEWAY_URL: "", ISSUE_GATEWAY_TOKEN: "" }, async () => { throw new Error("must not run"); });
  assert.deepEqual(disabled, { sent: 0, failed: 0 });

  const collab = `${base(projectB)}/collaboration`;
  await api.db.raw("delete from issue_sync_jobs where status in ('queued','sending')");
  await api.call("PUT", `${collab}/integration`, { token: owner.token, body: { destination: "acme/other", enabled: true } });
  const queued = await api.call("POST", `${collab}/issues/${issueB}/sync`, { token: owner.token, body: {} });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const ids: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    await api.db.raw("update issue_sync_jobs set next_attempt_at = now() - interval '1 second' where id = $1", [queued.body.delivery.id]);
    const result = await issueSyncTick(api.db, { ISSUE_GATEWAY_URL: "https://gateway.test.invalid", ISSUE_GATEWAY_TOKEN: "collaboration-test-gateway-token-123456" }, async (_payload, id) => {
      ids.push(id);
      throw new Error("Bearer top-secret provider response");
    });
    assert.deepEqual(result, { sent: 0, failed: 1 });
  }
  assert.deepEqual(ids, Array(5).fill(queued.body.delivery.id));
  const row = (await api.db.raw("select status, attempts, last_error from issue_sync_jobs where id=$1", [queued.body.delivery.id]))[0] as any;
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 5);
  assert.equal(row.last_error, "Issue delivery failed; check integration configuration");
  assert.equal(row.last_error.includes("top-secret"), false);
});
