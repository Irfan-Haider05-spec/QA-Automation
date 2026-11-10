/**
 * SIGNUP_MODE=invite: the first account can be created freely (it sets up the
 * platform); after that only people holding a live invite for their own email.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApi, type TestApi } from "./helpers.js";

let api: TestApi;
before(async () => { api = await startApi({ SIGNUP_MODE: "invite" }); });
after(async () => { await api.close(); });

const body = (email: string, extra: Record<string, unknown> = {}) => ({ name: "Person", email, password: "a-long-password-123", ...extra });
let owner: { token: string; orgId: string };

test("before anyone signs up, sign-up is open so the platform can be set up", async () => {
  assert.equal((await api.call("GET", "/auth/options")).body.signupOpen, true);
  const r = await api.call("POST", "/auth/signup", { body: body("first@test.invalid", { orgName: "MLITech" }) });
  assert.equal(r.status, 201);
  assert.equal(r.body.org.name, "MLITech");
  owner = { token: r.body.tokens.accessToken, orgId: r.body.org.id };
});

test("after that, sign-up without an invite is refused", async () => {
  assert.equal((await api.call("GET", "/auth/options")).body.signupOpen, false);
  const r = await api.call("POST", "/auth/signup", { body: body("stranger@test.invalid", { orgName: "Mine" }) });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "signup_closed");
  const bad = await api.call("POST", "/auth/signup", { body: body("stranger@test.invalid", { inviteToken: "not.a.token" }) });
  assert.equal(bad.status, 403);
});

test("an invite lets exactly that email sign up, without creating a stray organization", async () => {
  const inv = await api.call("POST", `/orgs/${owner.orgId}/invites`, { token: owner.token, body: { email: "dev@test.invalid", role: "developer" } });
  assert.equal(inv.status, 201);
  const token = inv.body.token as string;

  const wrong = await api.call("POST", "/auth/signup", { body: body("other@test.invalid", { inviteToken: token }) });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, "wrong_account");

  const [o, i] = token.split(".");
  const forged = await api.call("POST", "/auth/signup", { body: body("dev@test.invalid", { inviteToken: `${o}.${i}.${"x".repeat(43)}` }) });
  assert.equal(forged.status, 400);

  const ok = await api.call("POST", "/auth/signup", { body: body("DEV@test.invalid", { inviteToken: token, orgName: "Sneaky org" }) });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.org, null);
  const acc = await api.call("POST", "/invites/accept", { token: ok.body.tokens.accessToken, body: { token } });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.org.id, owner.orgId);

  // used invites can't open the door again
  const again = await api.call("POST", "/auth/signup", { body: body("dev2@test.invalid", { inviteToken: token }) });
  assert.equal(again.status, 400);
});

test("revoked invites stop working", async () => {
  const inv = await api.call("POST", `/orgs/${owner.orgId}/invites`, { token: owner.token, body: { email: "late@test.invalid", role: "viewer" } });
  await api.call("DELETE", `/orgs/${owner.orgId}/invites/${inv.body.invite.id}`, { token: owner.token });
  const r = await api.call("POST", "/auth/signup", { body: body("late@test.invalid", { inviteToken: inv.body.token }) });
  assert.equal(r.status, 400);
});

test("open mode (the default) reports sign-up as open", async () => {
  const open = await startApi();
  try {
    assert.equal((await open.call("GET", "/auth/options")).body.signupOpen, true);
  } finally {
    await open.close();
  }
});
