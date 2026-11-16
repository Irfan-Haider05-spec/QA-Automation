import type { Request } from "express";
import jwt from "jsonwebtoken";
import { deps } from "./context.js";
import { randomToken, sha256 } from "./crypto.js";
import type { Query } from "../db/index.js";

export async function issueTokens(req: Request, q: Query, userId: string) {
  const { config } = deps(req);
  const [user] = await q("select auth_version from users where id = $1", [userId]);
  if (!user) throw new Error("Account no longer exists");
  const accessToken = jwt.sign({ ver: user.auth_version }, config.JWT_SECRET, { algorithm: "HS256", subject: userId, expiresIn: config.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"] });
  const refreshToken = randomToken(32);
  await q("insert into refresh_tokens (user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(days => $3))", [userId, sha256(refreshToken), config.REFRESH_TOKEN_DAYS]);
  return { accessToken, refreshToken, tokenType: "Bearer" };
}

export async function revokeSessions(q: Query, userId: string, reason = "password") {
  await q("update users set auth_version = auth_version + 1 where id = $1", [userId]);
  await q("update refresh_tokens set revoked_at = now(), revoke_reason = $2 where user_id = $1 and revoked_at is null", [userId, reason]);
  await q("delete from login_challenges where user_id = $1", [userId]);
}

export async function loginResult(req: Request, q: Query, user: any) {
  const [mfa] = await q("select enabled from user_mfa where user_id = $1", [user.id]);
  if (mfa?.enabled) {
    const challenge = randomToken();
    await q("delete from login_challenges where expires_at < now()");
    // Bound outstanding challenges per account without invalidating other browsers.
    await q("delete from login_challenges where token_hash in (select token_hash from login_challenges where user_id = $1 order by expires_at desc offset 9)", [user.id]);
    await q("insert into login_challenges(token_hash, user_id, auth_version) select $1, id, auth_version from users where id = $2", [sha256(challenge), user.id]);
    return { mfaRequired: true as const, challenge };
  }
  return { user: { id: user.id, email: user.email, name: user.name, emailVerified: !!user.email_verified_at }, tokens: await issueTokens(req, q, user.id) };
}
