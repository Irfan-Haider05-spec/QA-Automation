/**
 * Account recovery and email verification: links by email, one use, expiry,
 * no account enumeration, sessions revoked on reset.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { startApi, signup, addMember, type TestApi } from "./helpers.js";

let api: TestApi;
let smtp: SMTPServer;
const mails: Array<{ to: string[]; data: string }> = [];

before(async () => {
  smtp = new SMTPServer({
    authOptional: true, disabledCommands: ["STARTTLS"],
    onData(stream, session, cb) {
      let data = "";
      stream.on("data", (c) => (data += c));
      stream.on("end", () => { mails.push({ to: session.envelope.rcptTo.map((r) => r.address), data }); cb(); });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
  api = await startApi({ APP_URL: "https://qa.example.com", SMTP_URL: `smtp://127.0.0.1:${(smtp.server.address() as AddressInfo).port}` });
});
after(async () => {
  await api.close();
  await new Promise<void>((r) => smtp.close(() => r()));
});

/** Wait for the next email to this address and pull the link token out of it */
async function linkFor(email: string, path: "reset-password" | "verify-email", from = 0): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const m = mails.slice(from).find((x) => x.to.includes(email) && x.data.includes(`/${path}?token=`));
    if (m) {
      const flat = m.data.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
      return decodeURIComponent(flat.match(new RegExp(`/${path}\\?token=([A-Za-z0-9_%-]+)`))![1]);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${path} email for ${email}`);
}
const mailsTo = (email: string) => mails.filter((m) => m.to.includes(email)).length;

test("options tell the dashboard that email verification and reset are available", async () => {
  const r = await api.call("GET", "/auth/options");
  assert.equal(r.body.emailVerification, true);
  assert.equal(r.body.passwordReset, true);
});

test("signup sends a verification link; the link verifies the address once", async () => {
  const u = await signup(api, "verify");
  const me = await api.call("GET", "/auth/me", { token: u.token });
  assert.equal(me.body.user.emailVerified, false);
  const token = await linkFor(u.email, "verify-email");
  const ok = await api.call("POST", "/auth/verify-email", { body: { token } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, u.email);
  assert.equal((await api.call("GET", "/auth/me", { token: u.token })).body.user.emailVerified, true);
  assert.equal((await api.call("POST", "/auth/verify-email", { body: { token } })).status, 400, "a link works once");
  const again = await api.call("POST", "/auth/resend-verification", { token: u.token });
  assert.equal(again.body.alreadyVerified, true);
});

test("resend verification sends a fresh link, with a limit per hour", async () => {
  const u = await signup(api, "resend");
  await linkFor(u.email, "verify-email");
  const before = mailsTo(u.email);
  const from = mails.length;
  const r = await api.call("POST", "/auth/resend-verification", { token: u.token });
  assert.equal(r.status, 202);
  await linkFor(u.email, "verify-email", from);
  assert.ok(mailsTo(u.email) > before);
  await api.call("POST", "/auth/resend-verification", { token: u.token });
  const limited = await api.call("POST", "/auth/resend-verification", { token: u.token });
  assert.equal(limited.status, 429);
});

test("forgot password: same answer for unknown emails, a link for real ones", async () => {
  const u = await signup(api, "reset");
  const unknown = await api.call("POST", "/auth/forgot-password", { body: { email: "nobody-here@test.invalid" } });
  const known = await api.call("POST", "/auth/forgot-password", { body: { email: u.email.toUpperCase() } });
  assert.equal(unknown.status, 202);
  assert.deepEqual(known.body, unknown.body);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mails.some((m) => m.to.includes("nobody-here@test.invalid")), false);

  const from = mails.length;
  const token = await linkFor(u.email, "reset-password", 0);
  assert.ok(mails.length >= from);

  // weak password refused, token still usable
  assert.equal((await api.call("POST", "/auth/reset-password", { body: { token, password: "short" } })).status, 400);
  const done = await api.call("POST", "/auth/reset-password", { body: { token, password: "a-brand-new-password-1" } });
  assert.equal(done.status, 200);

  // old password out, new one in; old sessions revoked; email now counts as verified
  assert.equal((await api.call("POST", "/auth/login", { body: { email: u.email, password: u.password } })).status, 401);
  const login = await api.call("POST", "/auth/login", { body: { email: u.email, password: "a-brand-new-password-1" } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.emailVerified, true);
  assert.equal((await api.call("POST", "/auth/refresh", { body: { refreshToken: u.refresh } })).status, 401, "sessions from before the reset are gone");
  assert.equal((await api.call("POST", "/auth/reset-password", { body: { token, password: "another-password-22" } })).status, 400, "a link works once");
});

test("reset links expire, and a newer reset doesn't keep older links alive after use", async () => {
  const u = await signup(api, "expire");
  await api.call("POST", "/auth/forgot-password", { body: { email: u.email } });
  const t1 = await linkFor(u.email, "reset-password");
  const from = mails.length;
  await api.call("POST", "/auth/forgot-password", { body: { email: u.email } });
  const t2 = await linkFor(u.email, "reset-password", from);
  assert.notEqual(t1, t2);
  assert.equal((await api.call("POST", "/auth/reset-password", { body: { token: t2, password: "first-new-password-1" } })).status, 200);
  assert.equal((await api.call("POST", "/auth/reset-password", { body: { token: t1, password: "second-new-password-2" } })).status, 400, "other open links die with the reset");

  const from3 = mails.length;
  await api.call("POST", "/auth/forgot-password", { body: { email: u.email } });
  const t3 = await linkFor(u.email, "reset-password", from3);
  await api.db.raw("update account_tokens set expires_at = now() - interval '1 minute' where used_at is null");
  assert.equal((await api.call("POST", "/auth/reset-password", { body: { token: t3, password: "third-new-password-3" } })).status, 400);
});

test("at most 3 reset emails per account per hour", async () => {
  const u = await signup(api, "flood");
  for (let i = 0; i < 5; i++) assert.equal((await api.call("POST", "/auth/forgot-password", { body: { email: u.email } })).status, 202);
  await new Promise((r) => setTimeout(r, 500));
  const resets = mails.filter((m) => m.to.includes(u.email) && m.data.includes("reset-password?token=")).length;
  assert.equal(resets, 3);
});

test("tokens are stored hashed", async () => {
  const rows = await api.db.raw("select token_hash from account_tokens limit 5");
  assert.ok(rows.length > 0);
  for (const r of rows) assert.match(r.token_hash, /^[0-9a-f]{64}$/);
});

test("without SMTP: no verification banner, reset still answers the same", async () => {
  const plain = await startApi();
  try {
    assert.equal((await plain.call("GET", "/auth/options")).body.emailVerification, false);
    const u = await signup(plain, "nosmtp");
    assert.equal((await plain.call("POST", "/auth/forgot-password", { body: { email: u.email } })).status, 202);
    assert.equal((await plain.call("POST", "/auth/resend-verification", { token: u.token })).status, 422);
  } finally {
    await plain.close();
  }
});

test("profile: change your name", async () => {
  const u = await signup(api, "rename");
  const r = await api.call("PATCH", "/auth/me", { token: u.token, body: { name: "  New Name  " } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.name, "New Name");
  assert.equal((await api.call("GET", "/auth/me", { token: u.token })).body.user.name, "New Name");
  assert.equal((await api.call("PATCH", "/auth/me", { token: u.token, body: { name: "" } })).status, 400);
});

test("change password: needs the current one, signs out other devices, keeps this one", async () => {
  const u = await signup(api, "chpw");
  const other = await api.call("POST", "/auth/login", { body: { email: u.email, password: u.password } });
  const wrong = await api.call("POST", "/auth/change-password", { token: u.token, body: { currentPassword: "nope-nope-nope", newPassword: "changed-password-11" } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, "wrong_password");
  const ok = await api.call("POST", "/auth/change-password", { token: u.token, body: { currentPassword: u.password, newPassword: "changed-password-11" } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.tokens.refreshToken);
  assert.equal((await api.call("POST", "/auth/refresh", { body: { refreshToken: other.body.tokens.refreshToken } })).status, 401, "other sessions signed out");
  assert.equal((await api.call("POST", "/auth/refresh", { body: { refreshToken: ok.body.tokens.refreshToken } })).status, 200, "the new session works");
  assert.equal((await api.call("POST", "/auth/login", { body: { email: u.email, password: "changed-password-11" } })).status, 200);
});

test("delete account: password needed; the only owner must hand over first; then everything personal goes", async () => {
  const u = await signup(api, "bye", "Bye Co");
  await api.call("POST", `/orgs/${u.orgId}/projects`, { token: u.token, body: { name: "Kept project" } });
  assert.equal((await api.call("DELETE", "/auth/me", { token: u.token, body: { password: "wrong-password-0" } })).status, 400);
  const blocked = await api.call("DELETE", "/auth/me", { token: u.token, body: { password: u.password } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error.message, /only owner of Bye Co/);

  const heir = await addMember(api, u, "admin");
  assert.equal((await api.call("PATCH", `/orgs/${u.orgId}/members/${heir.userId}`, { token: u.token, body: { role: "owner" } })).status, 200);
  const del = await api.call("DELETE", "/auth/me", { token: u.token, body: { password: u.password } });
  assert.equal(del.status, 204);

  assert.equal((await api.call("POST", "/auth/login", { body: { email: u.email, password: u.password } })).status, 401);
  assert.equal((await api.call("POST", "/auth/refresh", { body: { refreshToken: u.refresh } })).status, 401);
  const members = (await api.call("GET", `/orgs/${u.orgId}/members`, { token: heir.token })).body.members;
  assert.equal(members.some((m: any) => m.email === u.email), false);
  const projects = (await api.call("GET", `/orgs/${u.orgId}/projects`, { token: heir.token })).body.projects;
  assert.equal(projects.length, 1, "the organization's data stays");
  const audit = await api.db.raw(`select count(*)::int as n from audit_events where org_id = '${u.orgId}' and actor_user_id is null`);
  assert.ok(audit[0].n > 0, "audit entries stay, without the person");
  // the email can sign up again
  assert.equal((await api.call("POST", "/auth/signup", { body: { name: "Again", email: u.email, password: "a-long-password-123" } })).status, 201);
});

test("a stale token (logged out, or from before a password change) doesn't sign out the other sessions", async () => {
  const u = await signup(api, "stale");
  const b = (await api.call("POST", "/auth/login", { body: { email: u.email, password: u.password } })).body.tokens;
  await api.call("POST", "/auth/logout", { body: { refreshToken: u.refresh } });
  const stale = await api.call("POST", "/auth/refresh", { body: { refreshToken: u.refresh } });
  assert.equal(stale.status, 401);
  assert.equal(stale.body.error.code, "invalid_token");
  assert.equal((await api.call("POST", "/auth/refresh", { body: { refreshToken: b.refreshToken } })).status, 200, "the other device stays signed in");
});
