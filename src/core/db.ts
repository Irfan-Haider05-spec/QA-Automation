/**
 * Read-only database access for data checks and scenario database steps.
 *
 * Supported: MongoDB (the engine's own driver), PostgreSQL (`pg`, or `pglite://` for an
 * embedded local database) and MySQL/MariaDB (`mysql2`). The SQL drivers are optional:
 * when one is not installed the check errors and says what to install.
 *
 * Safety, in layers:
 *  - SQL: exactly one SELECT/WITH statement without comments; data-changing keywords are
 *    refused; it runs inside a READ ONLY transaction that is always rolled back (the
 *    database itself refuses writes, including writes hidden in functions), with a
 *    server-side statement timeout where the server supports one, and at most 10 000 rows.
 *  - MongoDB: count, find or aggregate only; `$out`, `$merge` and server-side JavaScript
 *    (`$where`, `$function`, `$accumulator`) are refused; `maxTimeMS` limits time.
 * Connection strings come from an environment variable and never appear in messages.
 */
import { MongoClient, BSON } from "mongodb";

export type DbType = "mongodb" | "postgres" | "mysql";
export interface DbSpec { type: DbType; urlEnv: string; database?: string }
export type DbQuery =
  | { collection: string; filter?: Record<string, unknown>; pipeline?: Record<string, unknown>[] }
  | { sql: string; params?: unknown[] };
export interface DbResult { rows: Record<string, unknown>[]; count: number; truncated: boolean }
export interface DbConn { type: DbType; run(q: DbQuery): Promise<DbResult>; close(): Promise<void> }

export const MAX_ROWS = 10_000;

/** Never let a connection string or its password reach a report. */
export const scrubDbError = (msg: string) =>
  msg.replace(/\b(mongodb(\+srv)?|postgres(ql)?|mysql|mariadb|pglite):\/\/[^\s'"]+/gi, "$1://[redacted]").replace(/\/\/[^/\s:@]+:[^@\s]+@/g, "//[redacted]@").slice(0, 400);

// ---------- SQL ----------

// The statement must start with SELECT or WITH, so writes can only hide in a data-changing
// CTE or SELECT … INTO; functions with side effects are stopped by the READ ONLY transaction.
const WRITE_WORDS = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|into|execute|prepare)\b/i;

/** Text with string literals, quoted identifiers and dollar-quoted bodies blanked out. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " '' ")
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .replace(/"(?:[^"]|"")*"/g, " x ")
    .replace(/`(?:[^`]|``)*`/g, " x ");
}

/** One read-only statement, returned without a trailing semicolon. */
export function validateSql(sql: string): string {
  const text = sql.trim().replace(/;\s*$/, "");
  if (!text) throw new Error("The SQL query is empty");
  if (text.length > 20_000) throw new Error("The SQL query is longer than 20 000 characters");
  if (/\{\{/.test(text)) throw new Error("Put values in params ($1 / ?), not {{templates}} inside SQL");
  const bare = stripLiterals(text);
  if (/--|\/\*|#/.test(bare)) throw new Error("Remove comments from the SQL query");
  if (bare.includes(";")) throw new Error("Use exactly one SQL statement");
  if (!/^\s*(select|with)\b/i.test(bare)) throw new Error("Only SELECT (or WITH … SELECT) queries are allowed");
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(bare)) throw new Error("Row locks (FOR UPDATE/SHARE) are not allowed");
  const word = WRITE_WORDS.exec(bare);
  if (word) throw new Error(`SQL keyword "${word[1].toUpperCase()}" is not allowed in a read-only check`);
  return text;
}

// ---------- MongoDB ----------

const MONGO_FORBIDDEN = new Set(["$out", "$merge", "$where", "$function", "$accumulator"]);

export function validateMongoQuery(q: { collection: string; filter?: unknown; pipeline?: unknown[] }) {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(q.collection) || q.collection.startsWith("system.")) throw new Error(`Collection name ${JSON.stringify(q.collection)} is not allowed`);
  if (q.filter !== undefined && q.pipeline !== undefined) throw new Error("Use filter or pipeline, not both");
  if (q.pipeline && q.pipeline.length > 50) throw new Error("A pipeline can have at most 50 stages");
  const walk = (v: unknown, depth: number) => {
    if (depth > 40) throw new Error("The MongoDB query is nested too deeply");
    if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (MONGO_FORBIDDEN.has(k)) throw new Error(`${k} is not allowed in a read-only check`);
      walk(x, depth + 1);
    }
  };
  walk(q.filter, 0); walk(q.pipeline, 0);
}

/** Database values as plain JSON: ObjectId → hex, Date → ISO text, Decimal128/Long → text or number, Buffers summarised. */
export function toPlain(v: unknown, depth = 0): unknown {
  if (depth > 40) return "[too deep]";
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v ?? null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `[binary ${v.length} bytes]`;
  const bsonType = (v as { _bsontype?: string })._bsontype;
  if (bsonType === "ObjectId" || bsonType === "ObjectID") return (v as { toHexString(): string }).toHexString();
  if (bsonType === "Decimal128") return v.toString();
  if (bsonType === "Long") { const n = Number(v.toString()); return Number.isSafeInteger(n) ? n : v.toString(); }
  if (bsonType === "Binary") return `[binary ${(v as { length(): number }).length()} bytes]`;
  if (bsonType) return String(v);
  if (Array.isArray(v)) return v.map((x) => toPlain(x, depth + 1));
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, toPlain(x, depth + 1)]));
  return String(v);
}

/** Extended JSON in a filter/pipeline ({ "$oid": "…" }, { "$date": "…" }) becomes real BSON values. */
export const fromExtendedJson = <T>(v: T): T => BSON.EJSON.deserialize(JSON.parse(JSON.stringify(v ?? null)), { relaxed: true }) as T;

// ---------- connections ----------

async function optionalImport(name: string, purpose: string): Promise<any> {
  try { return await import(name); }
  catch { throw new Error(`${purpose} needs the ${name} package; install it in the project that runs VeriQ (npm install ${name})`); }
}

const wrapSql = (sql: string, limitPlaceholder: string) => `SELECT * FROM (${sql}) AS veriq_q LIMIT ${limitPlaceholder}`;

export async function openDb(spec: DbSpec, timeoutMs: number): Promise<DbConn> {
  const url = process.env[spec.urlEnv];
  if (!url) throw new Error(`Set ${spec.urlEnv} to a read-only connection string for the ${spec.type} database`);
  const ms = Math.max(1000, Math.floor(timeoutMs));

  if (spec.type === "mongodb") {
    if (!/^mongodb(\+srv)?:\/\//.test(url)) throw new Error(`${spec.urlEnv} is not a MongoDB connection string`);
    const client = new MongoClient(url, { appName: "veriq-qa", serverSelectionTimeoutMS: ms, connectTimeoutMS: ms, socketTimeoutMS: ms * 2, maxPoolSize: 2, retryWrites: false });
    try { await client.connect(); } catch (e) { await client.close().catch(() => undefined); throw new Error(`Cannot connect to MongoDB: ${scrubDbError((e as Error).message)}`); }
    const db = client.db(spec.database);
    return {
      type: "mongodb",
      async run(q) {
        if (!("collection" in q)) throw new Error("A MongoDB query needs a collection");
        validateMongoQuery(q);
        const coll = db.collection(q.collection);
        try {
          if (q.pipeline) {
            const rows = await coll.aggregate([...fromExtendedJson(q.pipeline), { $limit: MAX_ROWS + 1 }], { maxTimeMS: ms }).toArray();
            return { rows: rows.slice(0, MAX_ROWS).map((r) => toPlain(r) as Record<string, unknown>), count: Math.min(rows.length, MAX_ROWS), truncated: rows.length > MAX_ROWS };
          }
          const filter = fromExtendedJson(q.filter ?? {});
          const count = await coll.countDocuments(filter, { maxTimeMS: ms });
          const rows = await coll.find(filter, { limit: Math.min(count, 200), maxTimeMS: ms }).toArray();
          return { rows: rows.map((r) => toPlain(r) as Record<string, unknown>), count, truncated: false };
        } catch (e) { throw new Error(`MongoDB query on ${q.collection} failed: ${scrubDbError((e as Error).message)}`); }
      },
      close: () => client.close().catch(() => undefined),
    };
  }

  if (spec.type === "postgres") {
    let exec: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    let end: () => Promise<void>;
    let serverTimeout = true;
    if (url.startsWith("pglite://")) {
      // Embedded PostgreSQL for local use and tests; it cannot interrupt a running query, so no time limit applies.
      const { PGlite } = await optionalImport("@electric-sql/pglite", "A pglite:// database");
      const where = url.slice("pglite://".length);
      const lite = where === "memory" ? new PGlite() : new PGlite(where);
      exec = async (text, params) => ({ rows: (await lite.query(text, params ?? [])).rows });
      end = () => lite.close();
      serverTimeout = false;
    } else {
      if (!/^postgres(ql)?:\/\//.test(url)) throw new Error(`${spec.urlEnv} is not a PostgreSQL connection string`);
      const pg = (await optionalImport("pg", "A PostgreSQL check")).default;
      // COUNT(*) and other bigint results arrive as text from pg; give numbers when they fit, as MySQL and PGlite do.
      const types = { getTypeParser: (oid: number, format?: string) => (oid === 20 ? (v: string) => (Number.isSafeInteger(Number(v)) ? Number(v) : v) : pg.types.getTypeParser(oid, format)) };
      const client = new pg.Client({ connectionString: url, application_name: "veriq-qa", connectionTimeoutMillis: ms, statement_timeout: ms, query_timeout: ms + 2000, types });
      try { await client.connect(); } catch (e) { await client.end().catch(() => undefined); throw new Error(`Cannot connect to PostgreSQL: ${scrubDbError((e as Error).message)}`); }
      exec = async (text, params) => ({ rows: (await client.query(text, params ?? [])).rows });
      end = () => client.end().catch(() => undefined);
    }
    return {
      type: "postgres",
      async run(q) {
        if (!("sql" in q)) throw new Error("A PostgreSQL query needs sql");
        const sql = validateSql(q.sql);
        const params = q.params ?? [];
        await exec("BEGIN READ ONLY");
        try {
          if (serverTimeout) await exec(`SET LOCAL statement_timeout = ${ms}`);
          const r = await exec(wrapSql(sql, `$${params.length + 1}`), [...params, MAX_ROWS + 1]);
          return { rows: r.rows.slice(0, MAX_ROWS).map((x) => toPlain(x) as Record<string, unknown>), count: Math.min(r.rows.length, MAX_ROWS), truncated: r.rows.length > MAX_ROWS };
        } catch (e) { throw new Error(`PostgreSQL query failed: ${scrubDbError((e as Error).message)}`); }
        finally { await exec("ROLLBACK").catch(() => undefined); }
      },
      close: end,
    };
  }

  if (!/^(mysql|mariadb):\/\//.test(url)) throw new Error(`${spec.urlEnv} is not a MySQL connection string`);
  const mysql = await optionalImport("mysql2/promise", "A MySQL check");
  let conn: any;
  try { conn = await mysql.createConnection({ uri: url.replace(/^mariadb:/, "mysql:"), connectTimeout: ms, supportBigNumbers: true, dateStrings: false }); }
  catch (e) { throw new Error(`Cannot connect to MySQL: ${scrubDbError((e as Error).message)}`); }
  // MySQL limits SELECTs with max_execution_time (ms), MariaDB with max_statement_time (s); unknown variables are ignored.
  await conn.query(`SET SESSION max_execution_time = ${ms}`).catch(() => undefined);
  await conn.query(`SET SESSION max_statement_time = ${(ms / 1000).toFixed(3)}`).catch(() => undefined);
  return {
    type: "mysql",
    async run(q) {
      if (!("sql" in q)) throw new Error("A MySQL query needs sql");
      const sql = validateSql(q.sql);
      await conn.query("START TRANSACTION READ ONLY");
      try {
        const [rows] = await conn.query({ sql: wrapSql(sql, "?"), timeout: ms + 2000 }, [...(q.params ?? []), MAX_ROWS + 1]);
        const list = rows as Record<string, unknown>[];
        return { rows: list.slice(0, MAX_ROWS).map((x) => toPlain({ ...x }) as Record<string, unknown>), count: Math.min(list.length, MAX_ROWS), truncated: list.length > MAX_ROWS };
      } catch (e) { throw new Error(`MySQL query failed: ${scrubDbError((e as Error).message)}`); }
      finally { await conn.query("ROLLBACK").catch(() => undefined); }
    },
    close: () => conn.end().catch(() => undefined),
  };
}
