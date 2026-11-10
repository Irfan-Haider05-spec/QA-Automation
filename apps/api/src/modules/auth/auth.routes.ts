/**
 * Accounts and sessions.
 * Access tokens: short-lived JWT (ACCESS_TOKEN_TTL). Refresh tokens: random,
 * stored hashed, rotated on every use; presenting an already-used refresh
 * token revokes every session of that user (token theft signal).
 */
import crypto from "node:crypto";
import { Router, type Request } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { ApiError, conflict, handle, isUuid, validate, zEmail, zName } from "../../lib/http.js";
import { deps, scoped } from "../../lib/context.js";
import { randomToken, safeEqualHex, sha256 } from "../../lib/crypto.js";
import { withContext, type Query } from "../../db/index.js";
import { actionMail, sendMail } from "../../lib/mail.js";

const router = Router();

const zPassword = z.string().min(10, "Use at least 10 characters").max(200);
// Compared against when the email doesn't exist, so response time doesn't reveal which emails are registered
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password-qa-platform", 10);

async function issueTokens(req: Request, q: Query, userId: string) {
  const { config } = deps(req);
  const accessToken = jwt.sign({}, config.JWT_SECRET, { algorithm: "HS256", subject: userId, expiresIn: config.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"] });
  const refreshToken = randomToken(32);
  await q("insert into refresh_tokens (user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(days => $3))", [userId, sha256(refreshToken), config.REFRESH_TOKEN_DAYS]);
  return { accessToken, refreshToken, tokenType: "Bearer" };
}

const publicUser = (u: any) => ({ id: u.id, email: u.email, name: u.name, emailVerified: !!u.email_verified_at });

const RESET_MINUTES = 60;
const VERIFY_DAYS = 3;
/** At most this many reset emails per account per hour (the IP limiter covers the rest) */
const RESETS_PER_HOUR = 3;

const appUrl = (req: Request) => deps(req).config.APP_URL ?? deps(req).config.CORS_ORIGINS.split(",")[0].trim().replace(/\/+$/, "");

/** Create a one-time link token; only its hash is stored */
async function newAccountToken(q: Query, userId: string, purpose: "password_reset" | "email_verify", expires: string) {
  const token = randomToken(32);
  await q(`insert into account_tokens (user_id, purpose, token_hash, expires_at) values ($1, $2, $3, now() + $4::interval)`, [userId, purpose, sha256(token), expires]);
  return token;
}

/** Send, or, without SMTP, log the link so a self-hosting admin can pass it on */
async function deliver(req: Request, mail: Parameters<typeof actionMail>[0], what: string) {
  const { config } = deps(req);
  if (!config.SMTP_URL) {
    console.warn(`[auth] SMTP_URL not set: ${what} link for ${mail.to}: ${mail.url}`);
    return;
  }
  try {
    await sendMail(config, actionMail(mail));
  } catch (e) {
    console.error(`[auth] couldn't send the ${what} email to ${mail.to}: ${(e as Error).message}`);
  }
}

async function sendVerification(req: Request, user: { id: string; email: string; name: string }, q: Query) {
  const token = await newAccountToken(q, user.id, "email_verify", `${VERIFY_DAYS} days`);
  const url = `${appUrl(req)}/verify-email?token=${encodeURIComponent(token)}`;
  // sent after the transaction commits, so a slow mail server doesn't hold it open
  return () => deliver(req, {
    to: user.email, subject: "Confirm your email address", greeting: `Hi ${user.name},`,
    lines: ["Please confirm this is your email address so we can send you alerts and account notices."],
    button: "Confirm email", url, footer: `The link works once and expires in ${VERIFY_DAYS} days. If you didn't create an account, ignore this email.`,
  }, "email verification");
}

/** Use a one-time token: returns the user id, or throws a 400 */
async function consumeToken(q: Query, token: string, purpose: "password_reset" | "email_verify") {
  const [t] = await q(
    "update account_tokens set used_at = now() where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now() returning user_id",
    [sha256(token), purpose],
  );
  if (!t) throw new ApiError(400, "invalid_token", purpose === "password_reset" ? "This reset link is not valid or has expired. Ask for a new one." : "This link is not valid or has expired.");
  return t.user_id as string;
}

/** Can a new account be created right now without an invite? (open mode, or nobody has signed up yet) */
async function signupOpen(req: Request) {
  if (deps(req).config.SIGNUP_MODE === "open") return true;
  const [row] = await withContext(deps(req).db, {}, (q) => q("select exists (select 1 from users) as any"));
  return !row.any;
}

/** Invite-only platforms: the sign-up must carry a live invite for this email. */
async function checkInvite(req: Request, token: string | undefined, email: string) {
  const closed = new ApiError(403, "signup_closed", "Accounts on this platform are by invitation. Ask an admin of your team for an invite link.");
  if (!token) throw closed;
  const [orgId, inviteId, secret] = token.split(".");
  if (!isUuid(orgId) || !isUuid(inviteId) || !secret) throw closed;
  const [inv] = await withContext(deps(req).db, { orgId }, (q) => q("select email, token_hash from invites where id = $1 and accepted_at is null and expires_at > now()", [inviteId]));
  if (!inv || !safeEqualHex(inv.token_hash, sha256(secret))) throw new ApiError(400, "invalid_invite", "This invite link is not valid or has expired");
  if (inv.email.toLowerCase() !== email.toLowerCase()) throw new ApiError(403, "wrong_account", `This invite is for ${inv.email}. Sign up with that email address.`);
}

router.get(
  "/options",
  handle(async (req, res) => {
    res.json({ signupOpen: await signupOpen(req), emailVerification: !!deps(req).config.SMTP_URL, passwordReset: true });
  }),
);

router.post(
  "/signup",
  // createOrg: false for people signing up to accept an invite, so they don't get a stray empty organization
  // inviteToken: needed when SIGNUP_MODE=invite (except for the very first account)
  validate({ body: z.object({ name: zName, email: zEmail, password: zPassword, orgName: zName.optional(), createOrg: z.boolean().default(true), inviteToken: z.string().max(300).optional() }) }),
  handle(async (req, res) => {
    const { name, email, password, orgName, inviteToken } = req.body;
    let { createOrg } = req.body;
    if (!(await signupOpen(req))) {
      await checkInvite(req, inviteToken, email);
      createOrg = false; // invited people join the inviting organization
    }
    const hash = await bcrypt.hash(password, 12);
    const orgId = crypto.randomUUID();
    const out = await withContext(deps(req).db, { orgId }, async (q) => {
      const [exists] = await q("select 1 from users where lower(email) = $1", [email]);
      if (exists) throw conflict("An account with this email already exists");
      const [user] = await q("insert into users (email, name, password_hash) values ($1, $2, $3) returning id, email, name, email_verified_at", [email, name, hash]);
      await q("select set_config('app.user_id', $1, true)", [user.id]);
      let org: Record<string, unknown> | null = null;
      if (createOrg) {
        [org] = await q("insert into orgs (id, name, created_by) values ($1, $2, $3) returning id, name", [orgId, orgName ?? `${name}'s team`, user.id]);
        await q("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, user.id]);
        await q("insert into audit_events (org_id, actor_user_id, action, entity_type, entity_id) values ($1, $2, 'org.created', 'org', $1)", [orgId, user.id]);
      }
      const send = await sendVerification(req, user, q);
      return { result: { user: publicUser(user), org: org && { ...org, role: "owner" }, tokens: await issueTokens(req, q, user.id) }, send };
    });
    void out.send();
    res.status(201).json(out.result);
  }),
);

router.post(
  "/login",
  validate({ body: z.object({ email: zEmail, password: z.string().min(1).max(200) }) }),
  handle(async (req, res) => {
    const { email, password } = req.body;
    const out = await withContext(deps(req).db, {}, async (q) => {
      const [user] = await q("select id, email, name, password_hash, email_verified_at from users where lower(email) = $1", [email]);
      const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok) throw new ApiError(401, "invalid_credentials", "Email or password is incorrect");
      return { user: publicUser(user), tokens: await issueTokens(req, q, user.id) };
    });
    res.json(out);
  }),
);

router.post(
  "/refresh",
  validate({ body: z.object({ refreshToken: z.string().min(20).max(200) }) }),
  handle(async (req, res) => {
    const db = deps(req).db;
    const hash = sha256(req.body.refreshToken);
    const [t] = await withContext(db, {}, (q) => q("select id, user_id, expires_at, revoked_at, revoke_reason from refresh_tokens where token_hash = $1", [hash]));
    if (!t) throw new ApiError(401, "invalid_token", "Refresh token is not valid");
    if (t.revoked_at) {
      // A logged-out or password-changed token is just stale. An already-exchanged one coming
      // back means someone copied it: sign out every session (separate transaction, so it sticks).
      if ((t.revoke_reason ?? "rotated") !== "rotated") throw new ApiError(401, "invalid_token", "This session has ended. Log in again.");
      await withContext(db, {}, (q) => q("update refresh_tokens set revoked_at = now(), revoke_reason = 'reuse' where user_id = $1 and revoked_at is null", [t.user_id]));
      throw new ApiError(401, "token_reused", "Refresh token was already used; all sessions have been signed out");
    }
    if (new Date(t.expires_at) < new Date()) throw new ApiError(401, "invalid_token", "Refresh token has expired");
    const out = await withContext(db, {}, async (q) => {
      const used = await q("update refresh_tokens set revoked_at = now(), revoke_reason = 'rotated' where id = $1 and revoked_at is null returning id", [t.id]);
      if (!used.length) throw new ApiError(401, "invalid_token", "Refresh token is not valid");
      return { tokens: await issueTokens(req, q, t.user_id) };
    });
    res.json(out);
  }),
);

router.post(
  "/logout",
  validate({ body: z.object({ refreshToken: z.string().min(20).max(200) }) }),
  handle(async (req, res) => {
    await withContext(deps(req).db, {}, (q) => q("update refresh_tokens set revoked_at = now(), revoke_reason = 'logout' where token_hash = $1 and revoked_at is null", [sha256(req.body.refreshToken)]));
    res.status(204).end();
  }),
);

router.get(
  "/me",
  auth(),
  handle(async (req, res) => {
    const out = await scoped(req, async (q) => {
      const [user] = await q("select id, email, name, email_verified_at, created_at from users where id = $1", [req.user!.id]);
      const orgs = await q(
        "select o.id, o.name, m.role, m.client_ids as \"clientIds\" from memberships m join orgs o on o.id = m.org_id where m.user_id = $1 order by o.created_at",
        [req.user!.id],
      );
      return { user: publicUser(user), orgs };
    });
    res.json(out);
  }),
);

router.post(
  "/forgot-password",
  validate({ body: z.object({ email: zEmail }) }),
  handle(async (req, res) => {
    const send = await withContext(deps(req).db, {}, async (q) => {
      const [user] = await q("select id, email, name from users where lower(email) = $1", [req.body.email]);
      if (!user) return null;
      const [{ n }] = await q("select count(*)::int as n from account_tokens where user_id = $1 and purpose = 'password_reset' and created_at > now() - interval '1 hour'", [user.id]);
      if (n >= RESETS_PER_HOUR) return null;
      const token = await newAccountToken(q, user.id, "password_reset", `${RESET_MINUTES} minutes`);
      const url = `${appUrl(req)}/reset-password?token=${encodeURIComponent(token)}`;
      return () => deliver(req, {
        to: user.email, subject: "Reset your password", greeting: `Hi ${user.name},`,
        lines: ["Someone (hopefully you) asked to reset the password for this account."],
        button: "Choose a new password", url, footer: `The link works once and expires in ${RESET_MINUTES} minutes. If you didn't ask for this, ignore this email: your password stays the same.`,
      }, "password reset");
    });
    if (send) void send();
    // Same answer whether or not the account exists
    res.status(202).json({ ok: true });
  }),
);

router.post(
  "/reset-password",
  validate({ body: z.object({ token: z.string().min(20).max(200), password: zPassword }) }),
  handle(async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 12);
    await withContext(deps(req).db, {}, async (q) => {
      const userId = await consumeToken(q, req.body.token, "password_reset");
      // The link proved the user reads this inbox, so the address counts as verified too
      await q("update users set password_hash = $1, email_verified_at = coalesce(email_verified_at, now()) where id = $2", [hash, userId]);
      await q("update account_tokens set used_at = now() where user_id = $1 and purpose = 'password_reset' and used_at is null", [userId]);
      // Sign out everywhere: whoever had the old password loses their sessions
      await q("update refresh_tokens set revoked_at = now(), revoke_reason = 'reset' where user_id = $1 and revoked_at is null", [userId]);
    });
    res.json({ ok: true });
  }),
);

router.post(
  "/verify-email",
  validate({ body: z.object({ token: z.string().min(20).max(200) }) }),
  handle(async (req, res) => {
    const email = await withContext(deps(req).db, {}, async (q) => {
      const userId = await consumeToken(q, req.body.token, "email_verify");
      const [u] = await q("update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1 returning email", [userId]);
      return u.email as string;
    });
    res.json({ ok: true, email });
  }),
);

router.post(
  "/resend-verification",
  auth(),
  handle(async (req, res) => {
    if (!deps(req).config.SMTP_URL) throw new ApiError(422, "email_off", "Email isn't set up on this platform, so there's nothing to verify.");
    const out = await withContext(deps(req).db, {}, async (q) => {
      const [user] = await q("select id, email, name, email_verified_at from users where id = $1", [req.user!.id]);
      if (user.email_verified_at) return { already: true as const };
      const [{ n }] = await q("select count(*)::int as n from account_tokens where user_id = $1 and purpose = 'email_verify' and created_at > now() - interval '1 hour'", [user.id]);
      if (n >= RESETS_PER_HOUR) throw new ApiError(429, "too_many", "We've sent a few emails already. Check your inbox (and spam), or try again in an hour.");
      return { send: await sendVerification(req, user, q) };
    });
    if ("already" in out) return void res.json({ ok: true, alreadyVerified: true });
    void out.send();
    res.status(202).json({ ok: true });
  }),
);

router.patch(
  "/me",
  auth(),
  validate({ body: z.object({ name: zName }) }),
  handle(async (req, res) => {
    const [user] = await withContext(deps(req).db, {}, (q) => q("update users set name = $1 where id = $2 returning id, email, name, email_verified_at", [req.body.name, req.user!.id]));
    res.json({ user: publicUser(user) });
  }),
);

router.post(
  "/change-password",
  auth(),
  validate({ body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: zPassword }) }),
  handle(async (req, res) => {
    const out = await withContext(deps(req).db, {}, async (q) => {
      const [u] = await q("select password_hash from users where id = $1", [req.user!.id]);
      if (!(await bcrypt.compare(req.body.currentPassword, u.password_hash))) throw new ApiError(400, "wrong_password", "Your current password isn't right");
      await q("update users set password_hash = $1 where id = $2", [await bcrypt.hash(req.body.newPassword, 12), req.user!.id]);
      // Other devices are signed out; this one gets fresh tokens
      await q("update refresh_tokens set revoked_at = now(), revoke_reason = 'password' where user_id = $1 and revoked_at is null", [req.user!.id]);
      return { tokens: await issueTokens(req, q, req.user!.id) };
    });
    res.json(out);
  }),
);

/** Organizations where this user is the only owner (they'd be left without one) */
async function soleOwnerOf(req: Request): Promise<Array<{ id: string; name: string }>> {
  const { db } = deps(req);
  const owned = await withContext(db, { userId: req.user!.id }, (q) =>
    q("select o.id, o.name from memberships m join orgs o on o.id = m.org_id where m.user_id = $1 and m.role = 'owner'", [req.user!.id]));
  const out: Array<{ id: string; name: string }> = [];
  for (const o of owned) {
    const [{ n }] = await withContext(db, { orgId: o.id, userId: req.user!.id }, (q) => q("select count(*)::int as n from memberships where role = 'owner'"));
    if (n <= 1) out.push(o);
  }
  return out;
}

router.delete(
  "/me",
  auth(),
  validate({ body: z.object({ password: z.string().min(1).max(200) }) }),
  handle(async (req, res) => {
    const { db } = deps(req);
    const [u] = await withContext(db, {}, (q) => q("select password_hash from users where id = $1", [req.user!.id]));
    if (!(await bcrypt.compare(req.body.password, u.password_hash))) throw new ApiError(400, "wrong_password", "Your password isn't right");
    const blocking = await soleOwnerOf(req);
    if (blocking.length) {
      throw new ApiError(409, "sole_owner", `You're the only owner of ${blocking.map((o) => o.name).join(", ")}. Make someone else an owner, or delete ${blocking.length > 1 ? "those organizations" : "that organization"}, first.`, { orgs: blocking });
    }
    // Memberships, sessions and links go with the account; audit entries and issues keep the action, not the person
    await withContext(db, { userId: req.user!.id }, (q) => q("delete from users where id = $1", [req.user!.id]));
    res.status(204).end();
  }),
);

export const AuthRoutes = router;
