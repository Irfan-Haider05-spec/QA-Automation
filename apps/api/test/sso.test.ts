import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, signup, type TestApi } from "./helpers.js";
import type { IdentityProvider } from "../src/lib/identity.js";

let api: TestApi;
const started = new Map<string, { nonce: string; verifier: string }>();
const provider: IdentityProvider = {
  issuer: "https://identity.example.test", redirectUri: "https://veriq.example.test/sso/callback",
  async authorization(input) { started.set(input.state, input); return `https://identity.example.test/authorize?state=${input.state}`; },
  async exchange(input) {
    assert.deepEqual({ nonce: input.nonce, verifier: input.verifier }, { nonce: started.get(input.state)?.nonce, verifier: started.get(input.state)?.verifier });
    if (input.code === "invalid") throw new Error("Private provider response must not leak");
    return { subject: input.code };
  },
};
before(async () => { api = await startApi({}, undefined, provider); });
after(async () => { await api.close(); });
async function begin(user?: Awaited<ReturnType<typeof signup>>) {
  const r = await api.call("POST", user ? "/auth/sso/link" : "/auth/sso/start", { token: user?.token, body: user ? { password: user.password } : {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { state: new URL(r.body.authorizationUrl).searchParams.get("state"), browserToken: r.body.browserToken };
}
test("SSO requires explicit identity linking, browser binding and one-time state", async () => {
  const user = await signup(api, "sso");
  const unlinked = await api.call("POST", "/auth/sso/complete", { body: { ...await begin(), code: "subject-a" } }); assert.equal(unlinked.status, 403);
  const link = await begin(user);
  assert.equal((await api.call("POST", "/auth/sso/complete", { body: { ...link, browserToken: "x".repeat(43), code: "subject-a" } })).status, 401);
  assert.equal((await api.call("POST", "/auth/sso/complete", { body: { ...link, code: "subject-a" } })).body.linked, true);
  assert.equal((await api.call("POST", "/auth/sso/complete", { body: { ...link, code: "subject-a" } })).status, 401);
  const signed = await api.call("POST", "/auth/sso/complete", { body: { ...await begin(), code: "subject-a" } }); assert.equal(signed.status, 200);
  assert.equal((await api.call("GET", "/auth/me", { token: signed.body.tokens.accessToken })).body.user.id, user.userId);
  const second = await signup(api, "sso-other");
  assert.equal((await api.call("POST", "/auth/sso/complete", { body: { ...await begin(second), code: "subject-a" } })).status, 409);
  assert.equal((await api.call("DELETE", "/auth/sso", { token: user.token, body: { password: user.password, issuer: provider.issuer } })).status, 200);
  assert.equal((await api.call("POST", "/auth/sso/complete", { body: { ...await begin(), code: "subject-a" } })).status, 403);
});
test("SSO rejects expired/revoked link transactions and hides provider failures", async () => {
  const user = await signup(api, "sso-stale"); const stale = await begin(user);
  await api.db.raw("update users set auth_version = auth_version + 1 where id = $1", [user.userId]);
  assert.equal((await api.call("POST", "/auth/sso/complete", { body: { ...stale, code: "subject-stale" } })).status, 401);
  const expired = await begin(); await api.db.raw("update sso_transactions set expires_at = now() - interval '1 second'");
  assert.equal((await api.call("POST", "/auth/sso/complete", { body: { ...expired, code: "subject-a" } })).status, 401);
  const failure = await api.call("POST", "/auth/sso/complete", { body: { ...await begin(), code: "invalid" } });
  assert.equal(failure.status, 401); assert.ok(!JSON.stringify(failure.body).includes("Private provider"));
});
