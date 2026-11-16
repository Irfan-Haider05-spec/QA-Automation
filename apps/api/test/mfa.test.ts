import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Secret, TOTP } from "otpauth";
import { startApi, signup, type TestApi } from "./helpers.js";

let api: TestApi;
before(async () => { api = await startApi(); });
after(async () => { await api.close(); });
async function enroll() {
  const user = await signup(api, "mfa");
  const setup = await api.call("POST", "/auth/mfa/setup", { token: user.token, body: { password: user.password } });
  assert.equal(setup.status, 200);
  const generator = new TOTP({ secret: Secret.fromBase32(setup.body.secret) });
  const code = generator.generate();
  const enabled = await api.call("POST", "/auth/mfa/enable", { token: user.token, body: { password: user.password, code } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  return { user, setup: setup.body, code, enabled: enabled.body };
}
const login = (user: Awaited<ReturnType<typeof signup>>) => api.call("POST", "/auth/login", { body: { email: user.email, password: user.password } });
const verify = (challenge: string, code: string) => api.call("POST", "/auth/mfa/verify", { body: { challenge, code } });

test("MFA enrollment is encrypted, invalidates old sessions and requires a second factor", async () => {
  const { user, setup, code, enabled } = await enroll();
  assert.equal(enabled.recoveryCodes.length, 10);
  const [row] = await api.db.raw("select * from user_mfa where user_id = $1", [user.userId]);
  assert.ok(!JSON.stringify(row).includes(setup.secret)); assert.ok(!JSON.stringify(row).includes(enabled.recoveryCodes[0]));
  assert.equal((await api.call("GET", "/auth/me", { token: user.token })).status, 401);
  assert.equal((await api.call("POST", "/auth/refresh", { body: { refreshToken: user.refresh } })).status, 401);
  const response = await login(user); assert.equal(response.body.mfaRequired, true); assert.equal(response.body.tokens, undefined);
  assert.equal((await verify(response.body.challenge, code)).status, 401, "Enrollment TOTP must not be replayed");
  const good = await verify(response.body.challenge, enabled.recoveryCodes[0]); assert.equal(good.status, 200);
  assert.equal((await verify(response.body.challenge, enabled.recoveryCodes[1])).status, 401, "Challenge must be one-time");
  const next = await login(user); assert.equal((await verify(next.body.challenge, enabled.recoveryCodes[0])).status, 401, "Recovery code must be one-time");
  assert.equal((await api.call("GET", "/auth/me", { token: good.body.tokens.accessToken })).status, 200);
});

test("MFA attempts persist, lock out guessing across challenges, and expired challenges fail", async () => {
  const { user, enabled } = await enroll();
  const r = await login(user);
  for (let i = 0; i < 5; i++) assert.equal((await verify(r.body.challenge, "invalid-code")).status, 401);
  assert.equal((await verify(r.body.challenge, enabled.recoveryCodes[0])).status, 401);
  const next = await login(user); assert.equal((await verify(next.body.challenge, enabled.recoveryCodes[0])).status, 401);
  const [mfa] = await api.db.raw("select failed_attempts, locked_until from user_mfa where user_id = $1", [user.userId]);
  assert.equal(mfa.failed_attempts, 5); assert.ok(new Date(mfa.locked_until).getTime() > Date.now());
  await api.db.raw("update user_mfa set locked_until = now() - interval '1 second' where user_id = $1", [user.userId]);
  await api.db.raw("update login_challenges set expires_at = now() - interval '1 second' where user_id = $1", [user.userId]);
  assert.equal((await verify(next.body.challenge, enabled.recoveryCodes[0])).status, 401);
});

test("Disabling MFA requires password and unused second factor and invalidates existing sessions", async () => {
  const { user, enabled } = await enroll();
  const token = enabled.tokens.accessToken;
  const disable = (password: string, code: string) => api.call("POST", "/auth/mfa/disable", { token, body: { password, code } });
  assert.equal((await disable("wrong-password", enabled.recoveryCodes[0])).status, 401);
  assert.equal((await disable(user.password, "invalid-code")).status, 401);
  const good = await disable(user.password, enabled.recoveryCodes[0]); assert.equal(good.status, 200);
  assert.equal((await api.call("GET", "/auth/me", { token })).status, 401);
  assert.ok((await login(user)).body.tokens);
});

test("Accounts without MFA can revoke all sessions after password verification", async () => {
  const user = await signup(api, "password-revoke");
  assert.equal((await api.call("POST", "/auth/revoke-sessions", { token: user.token, body: { password: "wrong" } })).status, 400);
  assert.equal((await api.call("GET", "/auth/me", { token: user.token })).status, 200);
  assert.equal((await api.call("POST", "/auth/revoke-sessions", { token: user.token, body: { password: user.password } })).status, 204);
  assert.equal((await api.call("GET", "/auth/me", { token: user.token })).status, 401);
  assert.equal((await api.call("POST", "/auth/refresh", { body: { refreshToken: user.refresh } })).status, 401);
});

test("Revoking all sessions requires password and MFA, preserves failed-attempt counts, and invalidates access, refresh, and challenges", async () => {
  const { user, enabled } = await enroll();
  const accessToken = enabled.tokens.accessToken;
  const refreshToken = enabled.tokens.refreshToken;
  const challenge = (await login(user)).body.challenge;
  const revoke = (password: string, code: string) => api.call("POST", "/auth/revoke-sessions", { token: accessToken, body: { password, code } });
  assert.equal((await api.call("POST", "/auth/revoke-sessions", { token: accessToken, body: { password: user.password } })).status, 401, "Enabled MFA cannot be bypassed by omitting the code");
  assert.equal((await revoke("wrong-password", enabled.recoveryCodes[0])).status, 400);
  assert.equal((await revoke(user.password, "bad-code")).status, 401);
  const [mfa] = await api.db.raw("select failed_attempts from user_mfa where user_id = $1", [user.userId]);
  assert.equal(mfa.failed_attempts, 1);
  assert.equal((await revoke(user.password, enabled.recoveryCodes[0])).status, 204);
  assert.equal((await api.call("GET", "/auth/me", { token: accessToken })).status, 401);
  assert.equal((await api.call("POST", "/auth/refresh", { body: { refreshToken } })).status, 401);
  assert.equal((await verify(challenge, enabled.recoveryCodes[1])).status, 401, "Revoking sessions removes pending MFA challenges");
});
