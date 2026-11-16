import { Router, type Request } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { deps, scoped } from "../../lib/context.js";
import { withContext, type Query } from "../../db/index.js";
import { ApiError, handle, validate } from "../../lib/http.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { loginResult, revokeSessions, issueTokens } from "../../lib/sessions.js";
import { consumeMfa } from "./mfa.routes.js";

export const SsoRouter = Router();
const invalid = () => new ApiError(401, "invalid_sso", "SSO sign-in could not be verified. Start again.");
const reauthSchema = z.object({ password: z.string().min(1).max(200), code: z.string().max(100).optional() }).strict();
async function reauthenticate(req: Request, q: Query) {
  const [u] = await q("select * from users where id = $1 for update", [req.user!.id]);
  if (!u || !await bcrypt.compare(req.body.password, u.password_hash)) return null;
  const [m] = await q("select enabled from user_mfa where user_id = $1", [u.id]);
  if (m?.enabled && !await consumeMfa(q, deps(req).vault, u.id, req.body.code ?? "")) return null;
  return u;
}
async function start(req: Request, link: boolean) {
  const { db, identity, vault } = deps(req);
  if (!identity) throw new ApiError(503, "sso_disabled", "SSO is not configured");
  const state = randomToken(), browserToken = randomToken(), verifier = randomToken(48), nonce = randomToken();
  const created = await withContext(db, {}, async (q) => {
    const user = link ? await reauthenticate(req, q) : undefined;
    if (link && !user) return false;
    await q("delete from sso_transactions where expires_at <= now()");
    await q("insert into sso_transactions(state_hash,browser_hash,verifier_enc,nonce,user_id,auth_version) values ($1,$2,$3,$4,$5,$6)",
      [sha256(state), sha256(browserToken), vault.encrypt(verifier, `oidc:${sha256(state)}`), nonce, user?.id ?? null, user?.auth_version ?? null]);
    return true;
  });
  if (!created) throw invalid();
  try { return { authorizationUrl: await identity.authorization({ state, nonce, verifier }), browserToken }; }
  catch { throw new ApiError(502, "identity_unavailable", "Identity provider is unavailable"); }
}

SsoRouter.get("/sso", auth(), handle(async (req, res) => {
  const identities = await scoped(req, (q) => q("select issuer, created_at as \"createdAt\" from sso_identities where user_id = $1", [req.user!.id]));
  res.json({ configured: !!deps(req).identity, identities });
}));
SsoRouter.post("/sso/start", validate({ body: z.object({}).strict() }), handle(async (req, res) => {
  res.setHeader("Cache-Control", "no-store"); res.json(await start(req, false));
}));
SsoRouter.post("/sso/link", auth(), validate({ body: reauthSchema }), handle(async (req, res) => {
  res.setHeader("Cache-Control", "no-store"); res.json(await start(req, true));
}));
SsoRouter.post("/sso/complete", validate({ body: z.object({ code: z.string().min(1).max(4000), state: z.string().min(20).max(100), browserToken: z.string().min(20).max(100) }).strict() }), handle(async (req, res) => {
  const { db, identity, vault } = deps(req);
  if (!identity) throw invalid();
  const stateHash = sha256(req.body.state);
  const [transaction] = await withContext(db, {}, (q) => q("delete from sso_transactions where state_hash = $1 and browser_hash = $2 and expires_at > now() returning *", [stateHash, sha256(req.body.browserToken)]));
  if (!transaction) throw invalid();
  let subject: string;
  try { ({ subject } = await identity.exchange({ code: req.body.code, state: req.body.state, nonce: transaction.nonce, verifier: vault.decrypt(transaction.verifier_enc, `oidc:${stateHash}`) })); }
  catch { throw invalid(); }
  const result = await withContext(db, {}, async (q) => {
    if (transaction.user_id) {
      const [user] = await q("select auth_version from users where id = $1 for update", [transaction.user_id]);
      if (!user || user.auth_version !== transaction.auth_version) throw invalid();
      await q("insert into sso_identities(issuer,subject,user_id) values ($1,$2,$3)", [identity.issuer, subject, transaction.user_id]);
      return { linked: true };
    }
    const [id] = await q("select user_id from sso_identities where issuer = $1 and subject = $2", [identity.issuer, subject]);
    if (!id) throw new ApiError(403, "sso_not_linked", "Sign in with your password and link SSO in account settings first.");
    const [user] = await q("select * from users where id = $1 for update", [id.user_id]);
    if (!user) throw invalid();
    const [stillLinked] = await q("select 1 from sso_identities where issuer = $1 and subject = $2 and user_id = $3", [identity.issuer, subject, user.id]);
    if (!stillLinked) throw invalid();
    return loginResult(req, q, user);
  });
  res.setHeader("Cache-Control", "no-store"); res.json(result);
}));
SsoRouter.delete("/sso", auth(), validate({ body: reauthSchema.extend({ issuer: z.string().max(1000) }) }), handle(async (req, res) => {
  const result = await scoped(req, async (q) => {
    const user = await reauthenticate(req, q); if (!user) return null;
    await q("delete from sso_identities where user_id = $1 and issuer = $2", [user.id, req.body.issuer]);
    await revokeSessions(q, user.id); return { tokens: await issueTokens(req, q, user.id) };
  });
  if (!result) throw invalid(); res.json(result);
}));
