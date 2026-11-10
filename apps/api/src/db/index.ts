/**
 * Database access. One small interface over two drivers:
 *   - pg (node-postgres) for real PostgreSQL in staging/production
 *   - PGlite (PostgreSQL compiled to WASM, in-process) for local dev and tests
 * Both run the same SQL, migrations and RLS policies.
 *
 * Request code never queries directly: it calls withContext(), which opens a
 * transaction, switches to role qa_app and sets app.org_id / app.user_id, so
 * Postgres row-level security scopes every statement to one organization.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

export type Query = <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface Db {
  kind: "pg" | "pglite";
  /** Unscoped query as the connection user. Only for migrations, health checks and tests. */
  raw: Query;
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  /** Run a multi-statement SQL script in one transaction (migrations) */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface Ctx {
  orgId?: string | null;
  userId?: string | null;
}

export async function openDb(url: string): Promise<Db> {
  if (url.startsWith("pglite://")) {
    const where = url.slice("pglite://".length);
    const lite = where === "memory" ? new PGlite() : new PGlite(path.resolve(where));
    await lite.waitReady;
    const run = (exec: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Query =>
      async (sql, params) => (await exec.query(sql, params as any[])).rows as any;
    return {
      kind: "pglite",
      raw: run(lite),
      tx: (fn) => lite.transaction((t) => fn(run(t))),
      exec: async (sql) => { await lite.transaction(async (t) => { await t.exec(sql); }); },
      close: () => lite.close(),
    };
  }
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const run = (c: pg.Pool | pg.PoolClient): Query => async (sql, params) => (await c.query(sql, params as any[])).rows;
  const db: Db = {
    kind: "pg",
    raw: run(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(run(client));
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      await db.tx(async (q) => { await q(sql); });
    },
    close: () => pool.end(),
  };
  return db;
}

/** Run fn in one transaction as qa_app, scoped to an org and/or user by RLS */
export function withContext<T>(db: Db, ctx: Ctx, fn: (q: Query) => Promise<T>): Promise<T> {
  return db.tx(async (q) => {
    await q("set local role qa_app");
    await q("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [ctx.orgId ?? "", ctx.userId ?? ""]);
    return fn(q);
  });
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/** Apply pending migrations in filename order, each in its own transaction */
export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.raw(`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.raw<{ version: string }>("select version from schema_migrations")).map((r) => r.version));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    await db.exec(`${sql}\ninsert into schema_migrations (version) values ('${f.replace(/'/g, "''")}');`);
    applied.push(f);
    log(`applied ${f}`);
  }
  return applied;
}

/** Migration files not yet applied; null if the app role can't read the table (then the check is skipped) */
export async function pendingMigrations(db: Db): Promise<string[] | null> {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  try {
    const done = new Set((await db.raw<{ version: string }>("select version from schema_migrations")).map((r) => r.version));
    return files.filter((f) => !done.has(f));
  } catch (e: any) {
    if (e?.code === "42P01") return files; // no table yet: nothing applied
    return null;
  }
}
