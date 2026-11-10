/**
 * Tenant isolation, at both walls: the API (membership checks) and the
 * database (row-level security), including a direct database attempt that
 * bypasses all application code.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, type TestApi } from "./helpers.js";
import { withContext } from "../src/db/index.js";

let api: TestApi;
let A: Awaited<ReturnType<typeof signup>>;
let B: Awaited<ReturnType<typeof signup>>;
let projectA: string;

before(async () => {
  api = await startApi();
  A = await signup(api, "orgA");
  B = await signup(api, "orgB");
  const p = await api.call("POST", `/orgs/${A.orgId}/projects`, { token: A.token, body: { name: "A secret project" } });
  assert.equal(p.status, 201);
  projectA = p.body.project.id;
});
after(async () => { await api.close(); });

test("a non-member gets 404 for another org (not 403, so ids can't be probed)", async () => {
  for (const path of [`/orgs/${A.orgId}`, `/orgs/${A.orgId}/projects`, `/orgs/${A.orgId}/projects/${projectA}`, `/orgs/${A.orgId}/members`]) {
    const r = await api.call("GET", path, { token: B.token });
    assert.equal(r.status, 404, path);
  }
  assert.equal((await api.call("PATCH", `/orgs/${A.orgId}`, { token: B.token, body: { name: "pwned" } })).status, 404);
});

test("another org's project id inside your own org path is not found", async () => {
  const r = await api.call("GET", `/orgs/${B.orgId}/projects/${projectA}`, { token: B.token });
  assert.equal(r.status, 404);
  const del = await api.call("DELETE", `/orgs/${B.orgId}/projects/${projectA}`, { token: B.token });
  assert.equal(del.status, 404);
  const still = await api.call("GET", `/orgs/${A.orgId}/projects/${projectA}`, { token: A.token });
  assert.equal(still.status, 200);
});

test("lists only show your own org's data", async () => {
  const r = await api.call("GET", `/orgs/${B.orgId}/projects`, { token: B.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.projects.length, 0);
  const orgs = await api.call("GET", "/orgs", { token: B.token });
  assert.deepEqual(orgs.body.orgs.map((o: any) => o.id), [B.orgId]);
});

test("malformed ids answer 404, never 500", async () => {
  for (const path of ["/orgs/000000000000000000000000", `/orgs/${A.orgId}/projects/not-a-uuid`, "/orgs/'; drop table users;--/projects"]) {
    const r = await api.call("GET", path, { token: A.token });
    assert.equal(r.status, 404, path);
  }
});

test("database RLS: org B's context cannot read or write org A rows, even without the API", async () => {
  const rows = await withContext(api.db, { orgId: B.orgId, userId: B.userId }, (q) => q("select id from projects"));
  assert.equal(rows.length, 0);
  const own = await withContext(api.db, { orgId: A.orgId, userId: A.userId }, (q) => q("select id from projects"));
  assert.equal(own.length, 1);
  await assert.rejects(
    withContext(api.db, { orgId: B.orgId }, (q) => q("insert into projects (org_id, name) values ($1, 'smuggled')", [A.orgId])),
    /row-level security/,
  );
  const updated = await withContext(api.db, { orgId: B.orgId }, (q) => q("update projects set name = 'pwned' where id = $1 returning id", [projectA]));
  assert.equal(updated.length, 0);
});

test("database RLS: no org context sees nothing", async () => {
  const rows = await withContext(api.db, {}, (q) => q("select id from projects"));
  assert.equal(rows.length, 0);
});

test("every table with an org_id has row-level security and a policy (new tables can't forget it)", async () => {
  const rows = await api.db.raw<{ table_name: string; rls: boolean; policies: number }>(
    `select c.table_name, t.relrowsecurity as rls, (select count(*)::int from pg_policies p where p.tablename = c.table_name) as policies
     from information_schema.columns c join pg_class t on t.relname = c.table_name and t.relkind = 'r'
     where c.table_schema = 'public' and c.column_name = 'org_id' order by c.table_name`,
  );
  assert.ok(rows.length >= 12, `expected the org tables, got ${rows.map((r) => r.table_name)}`);
  const missing = rows.filter((r) => !r.rls || r.policies === 0).map((r) => r.table_name);
  assert.deepEqual(missing, []);
});

test("the app role can add audit events but not change or delete them, nor the migration history", async () => {
  const u = await signup(api, "auditor");
  const { withContext } = await import("../src/db/index.js");
  const attempt = (sql: string) => withContext(api.db, { orgId: u.orgId, userId: u.userId }, (q) => q(sql)).then(() => "allowed", (e: any) => e.message as string);
  assert.match(await attempt("update audit_events set action = 'x'"), /permission denied/);
  assert.match(await attempt("delete from audit_events"), /permission denied/);
  assert.match(await attempt("insert into schema_migrations (version) values ('999_fake.sql')"), /permission denied/);
  assert.match(await attempt("delete from schema_migrations"), /permission denied/);
  assert.equal(await attempt("insert into audit_events (org_id, action, entity_type) values (app_org(), 'test.event', 'test')"), "allowed");
  // Deleting the organization still works and takes its audit log with it
  assert.equal((await api.call("DELETE", `/orgs/${u.orgId}`, { token: u.token })).status, 204);
});
