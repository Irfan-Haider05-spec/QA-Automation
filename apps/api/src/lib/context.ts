/**
 * Per-request context: the logged-in user, their membership in the org named
 * in the URL, or the runner's API key. Handlers use `scoped(req, fn)` for every
 * database call so RLS is always set from this context.
 */
import type { Request } from "express";
import type { ApiKeyScope, Role } from "@qa/shared";
import type { Config } from "../config.js";
import { withContext, type Db, type Query } from "../db/index.js";
import type { Vault } from "./crypto.js";
import { notFound } from "./http.js";

export interface Deps {
  db: Db;
  config: Config;
  vault: Vault;
}

export interface Member {
  orgId: string;
  role: Role;
  /** null = all clients */
  clientIds: string[] | null;
}

export interface Runner {
  apiKeyId: string;
  orgId: string;
  projectId: string;
  scopes: ApiKeyScope[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string };
      member?: Member;
      runner?: Runner;
      /** A platform-operated hosted runner (authRunner) */
      hostedRunner?: { id: string };
    }
  }
}

export const deps = (req: Request): Deps => req.app.locals.deps as Deps;

export function scoped<T>(req: Request, fn: (q: Query) => Promise<T>): Promise<T> {
  const orgId = req.member?.orgId ?? req.runner?.orgId ?? null;
  return withContext(deps(req).db, { orgId, userId: req.user?.id ?? null }, fn);
}

/** Load a project in the current org and enforce the member's client scope */
export async function loadProject(q: Query, req: Request, projectId: string) {
  const [p] = await q<{ id: string; client_id: string | null; name: string }>("select * from projects where id = $1", [projectId]);
  if (!p) throw notFound("Project");
  const scope = req.member?.clientIds;
  if (scope && (!p.client_id || !scope.includes(p.client_id))) throw notFound("Project");
  return p;
}

export async function loadEnvironment(q: Query, req: Request, projectId: string, environmentId: string) {
  await loadProject(q, req, projectId);
  const [e] = await q<any>("select * from environments where id = $1 and project_id = $2", [environmentId, projectId]);
  if (!e) throw notFound("Environment");
  return e;
}

/** Append an audit event inside the caller's transaction. Never pass secrets in data. */
export function audit(q: Query, req: Request, action: string, entityType: string, entityId: string | null, data?: Record<string, unknown>) {
  return q(
    "insert into audit_events (org_id, actor_user_id, actor_api_key_id, action, entity_type, entity_id, data) values (app_org(), $1, $2, $3, $4, $5, $6)",
    [req.user?.id ?? null, req.runner?.apiKeyId ?? null, action, entityType, entityId, data ? JSON.stringify(data) : null],
  );
}
