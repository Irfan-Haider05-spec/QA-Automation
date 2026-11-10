/**
 * Test harness: a real API server on a random port, backed by in-memory
 * PostgreSQL (PGlite) with all migrations and RLS policies applied.
 */
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadConfig } from "../src/config.js";
import { openDb, migrate, type Db } from "../src/db/index.js";
import { createApp } from "../src/app.js";

export interface TestApi {
  url: string;
  db: Db;
  vaultKey: string;
  call: (method: string, path: string, opts?: { token?: string; body?: unknown; raw?: boolean; headers?: Record<string, string> }) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

/**
 * Real PostgreSQL instead of PGlite when TEST_PG_ADMIN_URL is set, with roles as
 * in production: each test file gets a fresh database owned by the schema owner
 * (migrations run as it), and the API connects as the restricted qa_app role,
 * so row-level security and grants are exercised for real.
 *
 *   TEST_PG_ADMIN_URL=postgres://qa_admin:…@127.0.0.1/postgres   (may create databases, member of the owner role)
 *   TEST_PG_OWNER=qa_owner:password  TEST_PG_APP=qa_app:password
 */
async function realPostgres() {
  const admin = process.env.TEST_PG_ADMIN_URL!;
  const name = `qa_t_${crypto.randomBytes(6).toString("hex")}`;
  const [ownerUser] = (process.env.TEST_PG_OWNER ?? "qa_owner:").split(":");
  const at = (cred: string) => { const u = new URL(admin); const [user, pw] = cred.split(":"); u.username = user; u.password = pw; u.pathname = `/${name}`; return u.toString(); };
  const adminDb = await openDb(admin);
  await adminDb.raw(`create database ${name} owner ${ownerUser}`);
  await adminDb.close();
  const owner = await openDb(at(process.env.TEST_PG_OWNER ?? "qa_owner:"));
  await migrate(owner);
  await owner.raw(`grant connect on database ${name} to qa_app`);
  const app = await openDb(at(process.env.TEST_PG_APP ?? "qa_app:"));
  return {
    // The server uses the qa_app connection; tests' fixture tweaks (db.raw) run as the owner
    db: { ...app, raw: owner.raw } as Db,
    close: async () => {
      await app.close();
      await owner.close();
      const a = await openDb(admin);
      await a.raw(`drop database if exists ${name} with (force)`);
      await a.close();
    },
  };
}

export async function startApi(extraEnv: Record<string, string> = {}): Promise<TestApi> {
  const vaultKey = crypto.randomBytes(32).toString("base64");
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://memory",
    JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    VAULT_MASTER_KEY: vaultKey,
    ALLOW_HTTP_VERIFICATION: "true",
    ...extraEnv,
  });
  const pgReal = process.env.TEST_PG_ADMIN_URL ? await realPostgres() : null;
  const db = pgReal?.db ?? (await openDb(config.DATABASE_URL));
  if (!pgReal) await migrate(db);
  const server: Server = await new Promise((resolve) => {
    const s = createApp(db, config).listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: TestApi["call"] = async (method, path, opts = {}) => {
    const res = await fetch(url + (path.startsWith("/health") ? path : `/api/v1${path}`), {
      method,
      headers: { ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
    return { status: res.status, body };
  };
  return {
    url, db, vaultKey, call,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      if (pgReal) await pgReal.close();
      else await db.close();
    },
  };
}

let n = 0;
/** Sign up a new user with their own org; returns token, ids and the password */
export async function signup(api: TestApi, label = "user", orgName?: string) {
  n++;
  const email = `${label}-${n}-${crypto.randomBytes(3).toString("hex")}@test.invalid`;
  const password = "correct-horse-battery";
  const r = await api.call("POST", "/auth/signup", { body: { name: `${label} ${n}`, email, password, orgName } });
  if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.tokens.accessToken as string, refresh: r.body.tokens.refreshToken as string, userId: r.body.user.id as string, orgId: r.body.org.id as string, email, password };
}

/** Invite someone into an org with a role and accept as a freshly signed-up user */
export async function addMember(api: TestApi, owner: { token: string; orgId: string }, role: "admin" | "developer" | "viewer", clientIds?: string[]) {
  const u = await signup(api, role);
  const inv = await api.call("POST", `/orgs/${owner.orgId}/invites`, { token: owner.token, body: { email: u.email, role, clientIds } });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const acc = await api.call("POST", "/invites/accept", { token: u.token, body: { token: inv.body.token } });
  if (acc.status !== 200) throw new Error(`accept failed: ${acc.status} ${JSON.stringify(acc.body)}`);
  return u;
}

export const sampleRun = (findings: Array<{ fp: string; plugin?: string; severity?: string; known?: boolean }>, opts: { selected?: number; total?: number; skipPlugins?: string[] } = {}) => {
  const plugins = new Map<string, any[]>();
  for (const f of findings) {
    const p = f.plugin ?? "api-auth";
    if (!plugins.has(p)) plugins.set(p, []);
    plugins.get(p)!.push({
      plugin: p, severity: f.severity ?? "high", title: `Finding ${f.fp}`, target: `GET /x/${f.fp}`, category: "security", fingerprint: f.fp,
      evidence: { status: 200, curl: "curl -i 'https://staging.example.com/x' -H 'authorization: Bearer $QA_TOKEN_A'" },
      ...(f.known ? { known: { reason: "baseline" } } : {}),
    });
  }
  for (const p of ["api-auth", "route-auth"]) if (!plugins.has(p)) plugins.set(p, []);
  const results = [...plugins.entries()].map(([plugin, fs]) => ({
    plugin, status: opts.skipPlugins?.includes(plugin) ? "skipped" : fs.length ? "failed" : "passed", durationMs: 120, findings: opts.skipPlugins?.includes(plugin) ? [] : fs,
  }));
  return {
    project: "Test", suite: "staging", target: "https://staging.example.com", startedAt: new Date().toISOString(), durationMs: 5000,
    routesTotal: opts.total ?? 10, routesSelected: opts.selected ?? opts.total ?? 10, selectionReason: "all routes", requests: 42,
    results, gate: { failOn: "high", passed: findings.length === 0, blocking: findings.length }, source: "ci",
  };
};
