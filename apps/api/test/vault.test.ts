/**
 * Credentials vault: secrets are encrypted at rest, bound to their record,
 * never returned and never logged.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, type TestApi } from "./helpers.js";
import { Vault } from "../src/lib/crypto.js";

let api: TestApi;
let o: Awaited<ReturnType<typeof signup>>;
let base: string;
const SECRET = "Merchant-A-Pa55word!";

before(async () => {
  api = await startApi();
  o = await signup(api, "vault");
  const p = await api.call("POST", `/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Shop" } });
  const e = await api.call("POST", `/orgs/${o.orgId}/projects/${p.body.project.id}/environments`, { token: o.token, body: { name: "staging", apiBaseUrl: "https://staging.example.com" } });
  base = `/orgs/${o.orgId}/projects/${p.body.project.id}/environments/${e.body.environment.id}/credentials`;
});
after(async () => { await api.close(); });

test("secret is write-only and encrypted at rest", async () => {
  const c = await api.call("POST", base, { token: o.token, body: { name: "merchantA", role: "MERCHANT", identifier: "a@shop.test", device: "merchant", secret: SECRET } });
  assert.equal(c.status, 201);
  assert.equal(JSON.stringify(c.body).includes(SECRET), false);
  const list = await api.call("GET", base, { token: o.token });
  assert.equal(JSON.stringify(list.body).includes(SECRET), false);
  assert.equal(list.body.credentials[0].secret_blob, undefined);

  const [row] = await api.db.raw("select id, org_id, secret_blob from credentials where id = $1", [c.body.credential.id]);
  assert.equal(row.secret_blob.includes(SECRET), false);
  assert.equal(Buffer.from(row.secret_blob, "base64").toString().includes(SECRET), false);

  const vault = new Vault(api.vaultKey);
  assert.equal(vault.decrypt(row.secret_blob, `${row.org_id}:${row.id}`), SECRET);
  // Copying the blob to another record or org fails authentication
  assert.throws(() => vault.decrypt(row.secret_blob, `${row.org_id}:00000000-0000-4000-8000-000000000000`));
  assert.throws(() => new Vault(Buffer.alloc(32, 7).toString("base64")).decrypt(row.secret_blob, `${row.org_id}:${row.id}`));

  const auditRows = await api.db.raw("select data::text as d from audit_events");
  assert.equal(auditRows.some((r: any) => (r.d ?? "").includes(SECRET)), false);
});

test("updating the secret re-encrypts; duplicate names conflict", async () => {
  const c = await api.call("POST", base, { token: o.token, body: { name: "merchantB", role: "MERCHANT", identifier: "b@shop.test", secret: "first-secret" } });
  const [before] = await api.db.raw("select secret_blob from credentials where id = $1", [c.body.credential.id]);
  const u = await api.call("PUT", `${base}/${c.body.credential.id}`, { token: o.token, body: { secret: "second-secret" } });
  assert.equal(u.status, 200);
  const [afterRow] = await api.db.raw("select id, org_id, secret_blob from credentials where id = $1", [c.body.credential.id]);
  assert.notEqual(before.secret_blob, afterRow.secret_blob);
  assert.equal(new Vault(api.vaultKey).decrypt(afterRow.secret_blob, `${afterRow.org_id}:${afterRow.id}`), "second-secret");
  const dup = await api.call("POST", base, { token: o.token, body: { name: "merchantB", role: "MERCHANT", identifier: "b2@shop.test", secret: "x" } });
  assert.equal(dup.status, 409);
});
