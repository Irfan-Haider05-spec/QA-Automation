import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, type TestApi } from "./helpers.js";

let api: TestApi;
before(async () => { api = await startApi(); });
after(async () => { await api.close(); });

test("signup creates user, org and owner membership", async () => {
  const u = await signup(api, "founder", "Acme QA");
  const me = await api.call("GET", "/auth/me", { token: u.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, u.email);
  assert.equal(me.body.orgs.length, 1);
  assert.equal(me.body.orgs[0].name, "Acme QA");
  assert.equal(me.body.orgs[0].role, "owner");
  assert.equal(me.body.user.password_hash, undefined);
});

test("signup with createOrg false (joining by invite) creates no organization", async () => {
  const r = await api.call("POST", "/auth/signup", { body: { name: "Joiner", email: "joiner@test.invalid", password: "a-long-password-123", createOrg: false } });
  assert.equal(r.status, 201);
  assert.equal(r.body.org, null);
  const me = await api.call("GET", "/auth/me", { token: r.body.tokens.accessToken });
  assert.equal(me.body.orgs.length, 0);
});

test("duplicate email and weak password are rejected", async () => {
  const u = await signup(api, "dup");
  const again = await api.call("POST", "/auth/signup", { body: { name: "X", email: u.email.toUpperCase(), password: "another-long-password" } });
  assert.equal(again.status, 409);
  const weak = await api.call("POST", "/auth/signup", { body: { name: "X", email: "weak@test.invalid", password: "short" } });
  assert.equal(weak.status, 400);
});

test("login: wrong password and unknown email give the same 401", async () => {
  const u = await signup(api, "login");
  const bad = await api.call("POST", "/auth/login", { body: { email: u.email, password: "wrong-password!!" } });
  const unknown = await api.call("POST", "/auth/login", { body: { email: "nobody@test.invalid", password: "wrong-password!!" } });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(bad.body.error.code, unknown.body.error.code);
  const ok = await api.call("POST", "/auth/login", { body: { email: u.email, password: u.password } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.tokens.accessToken);
});

test("protected routes need a valid token", async () => {
  assert.equal((await api.call("GET", "/auth/me")).status, 401);
  assert.equal((await api.call("GET", "/auth/me", { token: "not.a.jwt" })).status, 401);
  assert.equal((await api.call("GET", "/orgs")).status, 401);
});

test("refresh tokens rotate; reusing an old one signs out every session", async () => {
  const u = await signup(api, "refresh");
  const r1 = await api.call("POST", "/auth/refresh", { body: { refreshToken: u.refresh } });
  assert.equal(r1.status, 200);
  const r2 = await api.call("POST", "/auth/refresh", { body: { refreshToken: r1.body.tokens.refreshToken } });
  assert.equal(r2.status, 200);
  // Replay the first (already rotated) token: theft signal
  const replay = await api.call("POST", "/auth/refresh", { body: { refreshToken: u.refresh } });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, "token_reused");
  // The newest token was revoked too
  const after = await api.call("POST", "/auth/refresh", { body: { refreshToken: r2.body.tokens.refreshToken } });
  assert.equal(after.status, 401);
});

test("logout revokes the refresh token", async () => {
  const u = await signup(api, "logout");
  assert.equal((await api.call("POST", "/auth/logout", { body: { refreshToken: u.refresh } })).status, 204);
  assert.equal((await api.call("POST", "/auth/refresh", { body: { refreshToken: u.refresh } })).status, 401);
});

test("health and unknown routes", async () => {
  const h = await api.call("GET", "/health");
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.equal((await api.call("GET", "/nope")).status, 404);
});

test("config: boolean env vars parse 'false' as false", async () => {
  const { loadConfig } = await import("../src/config.js");
  const base = { JWT_SECRET: "x".repeat(32), VAULT_MASTER_KEY: Buffer.alloc(32, 1).toString("base64") };
  assert.equal(loadConfig({ ...base, ALLOW_HTTP_VERIFICATION: "false" }).ALLOW_HTTP_VERIFICATION, false);
  assert.equal(loadConfig({ ...base, ALLOW_HTTP_VERIFICATION: "true" }).ALLOW_HTTP_VERIFICATION, true);
  assert.equal(loadConfig(base).ALLOW_HTTP_VERIFICATION, false);
  assert.throws(() => loadConfig({ ...base, ALLOW_HTTP_VERIFICATION: "maybe" }), /must be true or false/);
  assert.throws(() => loadConfig({ ...base, NODE_ENV: "production" }), /real PostgreSQL/);
});
