import { Router } from "express";
import bcrypt from "bcryptjs";
import { Secret, TOTP } from "otpauth";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { deps, scoped } from "../../lib/context.js";
import { withContext, type Query } from "../../db/index.js";
import { ApiError, conflict, handle, validate } from "../../lib/http.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { issueTokens, revokeSessions } from "../../lib/sessions.js";
import type { Vault } from "../../lib/crypto.js";

export const MfaRouter = Router();
const password = z.string().min(1).max(200);
const code = z.string().min(6).max(100);
const denied = () => new ApiError(401, "invalid_mfa", "Invalid or expired authentication code");
const totp = (secret: string, email = "account") => new TOTP({ issuer: "VeriQ", label: email, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) });

async function checkPassword(q: Query, userId: string, value: string) {
  const [user] = await q("select id, email, password_hash from users where id = $1 for update", [userId]);
  if (!user || !await bcrypt.compare(value, user.password_hash)) throw denied();
  return user;
}

/** Caller locks the user before this row; accepted TOTP steps/recovery codes are single-use. */
export async function consumeMfa(q: Query, vault: Vault, userId: string, token: string): Promise<boolean> {
  const [m] = await q("select * from user_mfa where user_id = $1 for update", [userId]);
  if (!m?.enabled) return false;
  if (m.locked_until && new Date(m.locked_until).getTime() > Date.now()) return false;
  const invalid = async () => {
    await q("update user_mfa set failed_attempts = case when locked_until <= now() then 1 else failed_attempts + 1 end, locked_until = case when failed_attempts >= 4 and (locked_until is null or locked_until > now()) then now() + interval '5 minutes' else null end where user_id = $1", [userId]);
    return false;
  };
  const hashes: string[] = m.recovery_hashes;
  const recovery = sha256(token.trim());
  if (hashes.includes(recovery)) {
    await q("update user_mfa set recovery_hashes = $2, failed_attempts = 0, locked_until = null where user_id = $1", [userId, JSON.stringify(hashes.filter((h) => h !== recovery))]);
    return true;
  }
  if (!/^\d{6}$/.test(token)) return invalid();
  const time = Date.now();
  const delta = totp(vault.decrypt(m.secret_enc, `mfa:${userId}`)).validate({ token, window: 1, timestamp: time });
  if (delta === null) return invalid();
  const step = Math.floor(time / 30000) + delta;
  if (step <= Number(m.last_step)) return invalid();
  await q("update user_mfa set last_step = $2, failed_attempts = 0, locked_until = null where user_id = $1", [userId, step]);
  return true;
}

MfaRouter.get("/mfa", auth(), handle(async (req, res) => {
  const [m] = await scoped(req, (q) => q("select enabled, jsonb_array_length(recovery_hashes) as remaining from user_mfa where user_id = $1", [req.user!.id]));
  res.setHeader("Cache-Control", "no-store"); res.json({ enabled: !!m?.enabled, recoveryCodesRemaining: m?.enabled ? m.remaining : 0 });
}));

MfaRouter.post("/mfa/setup", auth(), validate({ body: z.object({ password }).strict() }), handle(async (req, res) => {
  const result = await scoped(req, async (q) => {
    const user = await checkPassword(q, req.user!.id, req.body.password);
    const [existing] = await q("select enabled from user_mfa where user_id = $1", [user.id]);
    if (existing?.enabled) throw conflict("Two-factor authentication is already enabled");
    const secret = new Secret({ size: 20 }).base32;
    await q("insert into user_mfa(user_id, secret_enc) values ($1,$2) on conflict (user_id) do update set secret_enc = excluded.secret_enc, setup_expires_at = now() + interval '10 minutes', last_step = -1", [user.id, deps(req).vault.encrypt(secret, `mfa:${user.id}`)]);
    return { secret, uri: totp(secret, user.email).toString() };
  });
  res.setHeader("Cache-Control", "no-store"); res.json(result);
}));

MfaRouter.post("/mfa/enable", auth(), validate({ body: z.object({ password, code }).strict() }), handle(async (req, res) => {
  const result = await scoped(req, async (q) => {
    const user = await checkPassword(q, req.user!.id, req.body.password);
    const [m] = await q("select * from user_mfa where user_id = $1 for update", [user.id]);
    if (!m || m.enabled || new Date(m.setup_expires_at).getTime() <= Date.now()) throw denied();
    const time = Date.now(), delta = totp(deps(req).vault.decrypt(m.secret_enc, `mfa:${user.id}`)).validate({ token: req.body.code, window: 1, timestamp: time });
    if (delta === null) throw denied();
    const recoveryCodes = Array.from({ length: 10 }, () => randomToken(18));
    await q("update user_mfa set enabled = true, last_step = $2, recovery_hashes = $3 where user_id = $1", [user.id, Math.floor(time / 30000) + delta, JSON.stringify(recoveryCodes.map(sha256))]);
    await revokeSessions(q, user.id);
    return { recoveryCodes, tokens: await issueTokens(req, q, user.id) };
  });
  res.setHeader("Cache-Control", "no-store"); res.json(result);
}));

MfaRouter.post("/mfa/verify", validate({ body: z.object({ challenge: z.string().min(20).max(100), code }).strict() }), handle(async (req, res) => {
  const result = await withContext(deps(req).db, {}, async (q) => {
    const hash = sha256(req.body.challenge);
    const [lookup] = await q("select user_id from login_challenges where token_hash = $1", [hash]);
    if (!lookup) return null;
    const [user] = await q("select * from users where id = $1 for update", [lookup.user_id]);
    const [challenge] = await q("select * from login_challenges where token_hash = $1 for update", [hash]);
    if (!user || !challenge || challenge.attempts >= 5 || new Date(challenge.expires_at).getTime() <= Date.now() || challenge.auth_version !== user.auth_version) return null;
    await q("update login_challenges set attempts = attempts + 1 where token_hash = $1", [hash]);
    if (!await consumeMfa(q, deps(req).vault, user.id, req.body.code)) return null;
    await q("delete from login_challenges where token_hash = $1", [hash]);
    return { tokens: await issueTokens(req, q, user.id) };
  });
  if (!result) throw denied(); // outside the transaction so failed-attempt counters persist
  res.setHeader("Cache-Control", "no-store"); res.json(result);
}));

MfaRouter.post("/mfa/disable", auth(), validate({ body: z.object({ password, code }).strict() }), handle(async (req, res) => {
  const result = await scoped(req, async (q) => {
    const user = await checkPassword(q, req.user!.id, req.body.password);
    if (!await consumeMfa(q, deps(req).vault, user.id, req.body.code)) return null;
    await q("delete from user_mfa where user_id = $1", [user.id]);
    await revokeSessions(q, user.id);
    return { tokens: await issueTokens(req, q, user.id) };
  });
  if (!result) throw denied();
  res.json(result);
}));
