/**
 * auth(...roles)  → logged-in user (JWT). If the route has :orgId, the user must
 *                   be a member of that org; if roles are given, their role must
 *                   be one of them. Non-members get 404, not 403, so org ids
 *                   can't be probed.
 * authApiKey()    → runner authenticated by a project API key (qak_...).
 *
 * Every route declares its auth explicitly (no router-wide middleware), which
 * keeps the rule visible in the route file and lets the QA agent's route-auth
 * plugin audit this API too.
 */
import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import type { ApiKeyScope, Role } from "@qa/shared";
import { ApiError, forbidden, isUuid, notFound } from "../lib/http.js";
import { deps } from "../lib/context.js";
import { withContext } from "../db/index.js";
import { safeEqualHex, sha256 } from "../lib/crypto.js";

const unauthorized = (msg = "Authentication required") => new ApiError(401, "unauthorized", msg);

function bearer(header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7).trim();
}

export const auth =
  (...roles: Role[]): RequestHandler =>
  async (req, _res, next) => {
    try {
      const token = bearer(req.headers.authorization);
      if (!token) throw unauthorized();
      let payload: jwt.JwtPayload;
      try {
        payload = jwt.verify(token, deps(req).config.JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
      } catch {
        throw unauthorized("Invalid or expired token");
      }
      if (typeof payload.sub !== "string" || !isUuid(payload.sub)) throw unauthorized("Invalid token");
      req.user = { id: payload.sub };

      const orgId = req.params.orgId;
      if (orgId !== undefined) {
        if (!isUuid(orgId)) throw notFound("Organization");
        const [m] = await withContext(deps(req).db, { orgId, userId: req.user.id }, (q) =>
          q<{ role: Role; client_ids: string[] | null }>("select role, client_ids from memberships where org_id = $1 and user_id = $2", [orgId, req.user!.id]),
        );
        if (!m) throw notFound("Organization");
        req.member = { orgId, role: m.role, clientIds: m.client_ids };
        if (roles.length && !roles.includes(m.role)) throw forbidden();
      }
      next();
    } catch (e) {
      next(e);
    }
  };

/** Runner authentication with a project API key; `scope` is what this endpoint needs beyond uploading runs */
export const authApiKey = (scope: ApiKeyScope = "runs:write"): RequestHandler => async (req, _res, next) => {
  try {
    const key = bearer(req.headers.authorization);
    if (!key || !key.startsWith("qak_")) throw unauthorized("Project API key required");
    const [row] = await withContext(deps(req).db, {}, (q) =>
      q<{ api_key_id: string; org_id: string; project_id: string; scopes: ApiKeyScope[] }>("select * from qa_resolve_api_key($1)", [sha256(key)]),
    );
    if (!row) throw unauthorized("Invalid or revoked API key");
    if (!row.scopes.includes(scope)) throw forbidden(`This API key can't do that (needs the "${scope}" permission)`);
    req.runner = { apiKeyId: row.api_key_id, orgId: row.org_id, projectId: row.project_id, scopes: row.scopes };
    next();
  } catch (e) {
    next(e);
  }
};

/**
 * Hosted runners: platform infrastructure, authenticated with the shared
 * RUNNER_TOKEN plus an X-Runner-Id naming the machine (recorded on jobs).
 */
export const authRunner = (): RequestHandler => (req, _res, next) => {
  try {
    // Always 401 for callers that aren't runners, also when hosted runs are off:
    // anonymous requests learn nothing about the platform's configuration
    const expected = deps(req).config.RUNNER_TOKEN;
    const token = bearer(req.headers.authorization);
    if (!token) throw unauthorized("Runner token required");
    if (!expected || !safeEqualHex(sha256(token), sha256(expected))) throw unauthorized("Invalid runner token");
    const id = String(req.headers["x-runner-id"] ?? "");
    if (!/^[\w.:-]{1,100}$/.test(id)) throw unauthorized("X-Runner-Id header required (letters, digits, . _ : -)");
    req.hostedRunner = { id };
    next();
  } catch (e) {
    next(e);
  }
};
