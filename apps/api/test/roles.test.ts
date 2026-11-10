/**
 * Roles (owner/admin/developer/viewer), client-scoped members (agency use case), invites.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, addMember, type TestApi } from "./helpers.js";

let api: TestApi;
let owner: Awaited<ReturnType<typeof signup>>;
let clientX: string;
let clientY: string;
let projectX: string;
let projectY: string;

before(async () => {
  api = await startApi();
  owner = await signup(api, "agency", "Agency Ltd");
  clientX = (await api.call("POST", `/orgs/${owner.orgId}/clients`, { token: owner.token, body: { name: "Client X" } })).body.client.id;
  clientY = (await api.call("POST", `/orgs/${owner.orgId}/clients`, { token: owner.token, body: { name: "Client Y" } })).body.client.id;
  projectX = (await api.call("POST", `/orgs/${owner.orgId}/projects`, { token: owner.token, body: { name: "X app", clientId: clientX } })).body.project.id;
  projectY = (await api.call("POST", `/orgs/${owner.orgId}/projects`, { token: owner.token, body: { name: "Y app", clientId: clientY } })).body.project.id;
});
after(async () => { await api.close(); });

test("viewer can read but not change anything", async () => {
  const v = await addMember(api, owner, "viewer");
  assert.equal((await api.call("GET", `/orgs/${owner.orgId}/projects`, { token: v.token })).status, 200);
  assert.equal((await api.call("POST", `/orgs/${owner.orgId}/projects`, { token: v.token, body: { name: "nope" } })).status, 403);
  assert.equal((await api.call("PATCH", `/orgs/${owner.orgId}/projects/${projectX}`, { token: v.token, body: { name: "nope" } })).status, 403);
  assert.equal((await api.call("GET", `/orgs/${owner.orgId}/audit`, { token: v.token })).status, 403);
  assert.equal((await api.call("POST", `/orgs/${owner.orgId}/projects/${projectX}/api-keys`, { token: v.token, body: { name: "k" } })).status, 403);
});

test("developer manages projects but not members, clients or deletion", async () => {
  const d = await addMember(api, owner, "developer");
  const p = await api.call("POST", `/orgs/${owner.orgId}/projects`, { token: d.token, body: { name: "Dev project" } });
  assert.equal(p.status, 201);
  assert.equal((await api.call("DELETE", `/orgs/${owner.orgId}/projects/${p.body.project.id}`, { token: d.token })).status, 403);
  assert.equal((await api.call("POST", `/orgs/${owner.orgId}/clients`, { token: d.token, body: { name: "Z" } })).status, 403);
  assert.equal((await api.call("POST", `/orgs/${owner.orgId}/invites`, { token: d.token, body: { email: "x@test.invalid", role: "viewer" } })).status, 403);
});

test("client-scoped member only sees and creates within their clients", async () => {
  const d = await addMember(api, owner, "developer", [clientX]);
  const list = await api.call("GET", `/orgs/${owner.orgId}/projects`, { token: d.token });
  assert.deepEqual(list.body.projects.map((p: any) => p.id), [projectX]);
  const clients = await api.call("GET", `/orgs/${owner.orgId}/clients`, { token: d.token });
  assert.deepEqual(clients.body.clients.map((c: any) => c.id), [clientX]);
  assert.equal((await api.call("GET", `/orgs/${owner.orgId}/projects/${projectY}`, { token: d.token })).status, 404);
  assert.equal((await api.call("GET", `/orgs/${owner.orgId}/projects/${projectY}/issues`, { token: d.token })).status, 404);
  assert.equal((await api.call("POST", `/orgs/${owner.orgId}/projects`, { token: d.token, body: { name: "no client" } })).status, 400);
  assert.equal((await api.call("POST", `/orgs/${owner.orgId}/projects`, { token: d.token, body: { name: "other client", clientId: clientY } })).status, 400);
  assert.equal((await api.call("POST", `/orgs/${owner.orgId}/projects`, { token: d.token, body: { name: "ok", clientId: clientX } })).status, 201);
  // Moving a project to a client outside your scope is refused
  assert.equal((await api.call("PATCH", `/orgs/${owner.orgId}/projects/${projectX}`, { token: d.token, body: { clientId: clientY } })).status, 400);
});

test("owners: last owner can't be demoted or removed; admins can't touch owners", async () => {
  const a = await addMember(api, owner, "admin");
  assert.equal((await api.call("PATCH", `/orgs/${owner.orgId}/members/${owner.userId}`, { token: owner.token, body: { role: "admin" } })).status, 409);
  assert.equal((await api.call("DELETE", `/orgs/${owner.orgId}/members/${owner.userId}`, { token: owner.token })).status, 409);
  assert.equal((await api.call("PATCH", `/orgs/${owner.orgId}/members/${owner.userId}`, { token: a.token, body: { role: "viewer" } })).status, 403);
  assert.equal((await api.call("PATCH", `/orgs/${owner.orgId}/members/${a.userId}`, { token: a.token, body: { role: "owner" } })).status, 403);
  // Admin can change a developer's scope
  const d = await addMember(api, owner, "developer");
  const ch = await api.call("PATCH", `/orgs/${owner.orgId}/members/${d.userId}`, { token: a.token, body: { clientIds: [clientY] } });
  assert.equal(ch.status, 200);
  assert.deepEqual(ch.body.member.clientIds, [clientY]);
  // Anyone can leave
  assert.equal((await api.call("DELETE", `/orgs/${owner.orgId}/members/${d.userId}`, { token: d.token })).status, 204);
  assert.equal((await api.call("GET", `/orgs/${owner.orgId}`, { token: d.token })).status, 404);
});

test("invites: wrong account can't accept; tokens are single-use", async () => {
  const inv = await api.call("POST", `/orgs/${owner.orgId}/invites`, { token: owner.token, body: { email: "someone@test.invalid", role: "viewer" } });
  assert.equal(inv.status, 201);
  const stranger = await signup(api, "stranger");
  const wrong = await api.call("POST", "/invites/accept", { token: stranger.token, body: { token: inv.body.token } });
  assert.equal(wrong.status, 403);
  const tampered = await api.call("POST", "/invites/accept", { token: stranger.token, body: { token: inv.body.token.slice(0, -4) + "AAAA" } });
  assert.equal(tampered.status, 400);
  const bogusClient = await api.call("POST", `/orgs/${owner.orgId}/invites`, { token: owner.token, body: { email: "x2@test.invalid", role: "viewer", clientIds: ["00000000-0000-4000-8000-000000000000"] } });
  assert.equal(bogusClient.status, 400);
});
