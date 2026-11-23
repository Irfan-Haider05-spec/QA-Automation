import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { BSON } from 'mongodb';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { fromExtendedJson, openDb, scrubDbError, toPlain, validateMongoQuery, validateSql } from '../src/core/db.js';
import { runPlugins } from '../src/core/runner.js';
import { gate } from '../src/core/triage.js';
import { dbChecksPlugin, dbChecksSchema } from '../src/plugins/expanded/db-checks.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-db-'));
const pgDir = path.join(root, 'pgdata');
let base: RunContext;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };

// The same data in every engine: one orphan promotion, one duplicated email, one expired-but-active promotion.
const SEED = [
  'CREATE TABLE merchants (id INT PRIMARY KEY, email VARCHAR(200) NOT NULL)',
  "INSERT INTO merchants VALUES (1, 'ali@shop.pk'), (2, 'ALI@shop.pk'), (3, 'sara@shop.pk')",
  'CREATE TABLE promotions (id INT PRIMARY KEY, merchant_id INT NOT NULL, title VARCHAR(200) NOT NULL, discount INT NOT NULL, active BOOLEAN NOT NULL, expires_at DATE NOT NULL)',
  "INSERT INTO promotions VALUES (10, 1, 'A: 10% off', 10, true, '2099-01-01'), (11, 3, 'S: coffee', 5, true, '2020-01-01'), (12, 99, 'orphan', 20, false, '2099-01-01')",
  'CREATE TABLE audit (id INT)',
];
const CHECKS = (p: (n: number) => string) => `
version: 1
checks:
  - name: Promotions belong to an existing merchant
    severity: critical
    tags: [integrity]
    sql: "SELECT p.id FROM promotions p LEFT JOIN merchants m ON m.id = p.merchant_id WHERE m.id IS NULL"
  - name: Merchant emails are unique ignoring case
    tags: [integrity]
    sql: "SELECT LOWER(email) AS email, COUNT(*) AS n FROM merchants GROUP BY LOWER(email) HAVING COUNT(*) > 1"
    sampleField: email
  - name: No expired promotion is still active
    sql: "SELECT id FROM promotions WHERE active = ${p(1)} AND expires_at < ${p(2)}"
    params: [true, "2026-11-19"]
    expect: { max: 0 }
  - name: Discounts are between 1 and 100
    sql: "SELECT id FROM promotions WHERE discount < 1 OR discount > 100"
  - name: There are merchants
    sql: "SELECT COUNT(*) AS n FROM merchants"
    expect: { count: 1, json: [{ path: "$[0].n", equals: 3 }] }
  - name: Uses a table that does not exist
    sql: "SELECT id FROM coupons"
  - name: A function that writes is still refused
    sql: "SELECT bump() AS x"
`;

before(async () => {
  const lite = new PGlite(pgDir);
  for (const s of SEED) await lite.exec(s);
  await lite.exec("CREATE FUNCTION bump() RETURNS int AS $$ INSERT INTO audit VALUES (1) RETURNING 1 $$ LANGUAGE sql");
  await lite.close();
  const { config } = await loadConfig('test/fixture.config.ts', {});
  base = { config, configDir: root, outDir: path.join(root, 'out'), suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function run(settings: Record<string, unknown>) {
  const config = { ...structuredClone(base.config), pluginSettings: { 'db-checks': settings } };
  return (await runPlugins([dbChecksPlugin], { ...base, config }))[0];
}

async function expectIntegrityResults(type: 'postgres' | 'mysql', urlEnv: string, file: string) {
  const r = await run({ database: { type, urlEnv }, files: file });
  assert.equal(r.status, 'failed', r.reason);
  const by = Object.fromEntries(r.findings.map((f) => [f.title, f]));
  assert.deepEqual(Object.keys(by).sort(), [
    'Data check could not run: A function that writes is still refused',
    'Data check could not run: Uses a table that does not exist',
    'Data integrity check failed: Merchant emails are unique ignoring case',
    'Data integrity check failed: No expired promotion is still active',
    'Data integrity check failed: Promotions belong to an existing merchant',
  ]);
  const orphan = by['Data integrity check failed: Promotions belong to an existing merchant'];
  assert.equal(orphan.severity, 'critical');
  assert.match(orphan.detail ?? '', /- expected 0 row\(s\), found 1\nSample id: 12/);
  assert.match(by['Data integrity check failed: No expired promotion is still active'].detail ?? '', /expected at most 0 row\(s\), found 1\nSample id: 11/);
  const dup = by['Data integrity check failed: Merchant emails are unique ignoring case'].detail ?? '';
  assert.match(dup, /found 1/);
  assert.doesNotMatch(dup, /ali@shop\.pk/, 'personal data in samples is redacted');
  assert.match(by['Data check could not run: A function that writes is still refused'].detail ?? '', /read[- ]only transaction/i, 'the database itself refused the write');
  assert.equal(r.stats?.passed, 2);
  assert.equal(gate([r], 'high').blocking.length, 5);
  const report = fs.readFileSync(path.join(root, 'out', 'db-checks.json'), 'utf8');
  assert.doesNotMatch(report, /ali@|sara@|coffee/, 'the report holds counts, not row contents');
}

test('PostgreSQL rules (embedded engine): orphans, duplicates, impossible states found; a write inside a function is refused', async () => {
  write('checks/pg.yaml', CHECKS((n) => `$${n}`));
  process.env.QA_DB_URL_TEST = `pglite://${pgDir}`;
  try { await expectIntegrityResults('postgres', 'QA_DB_URL_TEST', 'checks/pg.yaml'); }
  finally { delete process.env.QA_DB_URL_TEST; }
  const lite = new PGlite(pgDir);
  try { assert.equal((await lite.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM audit')).rows[0].n, 0, 'nothing was written'); }
  finally { await lite.close(); }
});

test('Real PostgreSQL server: same rules, server statement timeout, password never shown', { skip: process.env.QA_TEST_PG_URL ? false : 'set QA_TEST_PG_URL to a disposable PostgreSQL database' }, async () => {
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: process.env.QA_TEST_PG_URL });
  await c.connect();
  try {
    await c.query('DROP TABLE IF EXISTS promotions, merchants, audit CASCADE; DROP FUNCTION IF EXISTS bump()');
    for (const s of SEED) await c.query(s);
    await c.query("CREATE FUNCTION bump() RETURNS int AS $$ INSERT INTO audit VALUES (1) RETURNING 1 $$ LANGUAGE sql");
  } finally { await c.end(); }
  write('checks/pg.yaml', CHECKS((n) => `$${n}`));
  process.env.QA_DB_URL_TEST = process.env.QA_TEST_PG_URL;
  try {
    await expectIntegrityResults('postgres', 'QA_DB_URL_TEST', 'checks/pg.yaml');
    write('checks/slow.yaml', 'checks:\n  - name: Slow\n    sql: "SELECT pg_sleep(5) AS x"\n    expect: { count: 1 }\n');
    const t0 = Date.now();
    const slow = await run({ database: { type: 'postgres', urlEnv: 'QA_DB_URL_TEST' }, files: 'checks/slow.yaml', timeoutMs: 1000 });
    assert.ok(Date.now() - t0 < 4000, 'the server stopped the query');
    assert.match(slow.findings[0].detail ?? '', /statement timeout/i);
    const u = new URL(process.env.QA_TEST_PG_URL!); u.password = 'Wr0ngSecretPass';
    process.env.QA_DB_URL_TEST = u.toString();
    const bad = await run({ database: { type: 'postgres', urlEnv: 'QA_DB_URL_TEST' }, files: 'checks/slow.yaml' });
    assert.equal(bad.status, 'errored');
    assert.match(bad.reason ?? '', /Cannot connect to PostgreSQL/);
    assert.doesNotMatch(bad.reason ?? '', /Wr0ngSecretPass/);
  } finally { delete process.env.QA_DB_URL_TEST; }
  const c2 = new pg.Client({ connectionString: process.env.QA_TEST_PG_URL });
  await c2.connect();
  try { assert.equal((await c2.query('SELECT COUNT(*)::int AS n FROM audit')).rows[0].n, 0); } finally { await c2.end(); }
});

test('Real MySQL/MariaDB server: same rules with ? parameters, READ ONLY transaction, statement time limit', { skip: process.env.QA_TEST_MYSQL_URL ? false : 'set QA_TEST_MYSQL_URL to a disposable MySQL database (needs the mysql2 package)' }, async () => {
  // mysql2 is optional and not a project dependency (like in src/core/db.ts): a computed
  // specifier keeps the typecheck from requiring it; the test itself is skipped without a server.
  const driver = 'mysql2/promise';
  const mysql = await import(driver);
  const c = await mysql.createConnection({ uri: process.env.QA_TEST_MYSQL_URL!, multipleStatements: false });
  try {
    for (const t of ['promotions', 'merchants', 'audit']) await c.query(`DROP TABLE IF EXISTS ${t}`);
    await c.query('DROP FUNCTION IF EXISTS bump');
    for (const s of SEED) await c.query(s);
    await c.query('CREATE FUNCTION bump() RETURNS INT MODIFIES SQL DATA BEGIN INSERT INTO audit VALUES (1); RETURN 1; END');
  } finally { await c.end(); }
  write('checks/my.yaml', CHECKS(() => '?'));
  process.env.QA_DB_URL_TEST = process.env.QA_TEST_MYSQL_URL;
  try {
    await expectIntegrityResults('mysql', 'QA_DB_URL_TEST', 'checks/my.yaml');
    write('checks/slow.yaml', 'checks:\n  - name: Slow\n    sql: "SELECT SLEEP(5) AS x"\n    expect: { count: 1 }\n');
    const t0 = Date.now();
    const slow = await run({ database: { type: 'mysql', urlEnv: 'QA_DB_URL_TEST' }, files: 'checks/slow.yaml', timeoutMs: 1000 });
    assert.ok(Date.now() - t0 < 4000, 'the query was stopped');
    assert.equal(slow.status, 'failed');
  } finally { delete process.env.QA_DB_URL_TEST; }
  const c2 = await mysql.createConnection({ uri: process.env.QA_TEST_MYSQL_URL! });
  try { const [rows] = await c2.query('SELECT COUNT(*) AS n FROM audit'); assert.equal(Number((rows as { n: number }[])[0].n), 0); } finally { await c2.end(); }
});

test('At most 10 000 rows are read; a larger result is reported as "or more", never as an exact count', async () => {
  process.env.QA_DB_URL_TEST = `pglite://${pgDir}`;
  const conn = await openDb({ type: 'postgres', urlEnv: 'QA_DB_URL_TEST' }, 5000);
  try {
    const big = await conn.run({ sql: 'SELECT g AS id FROM generate_series(1, 10005) g' });
    assert.equal(big.count, 10000);
    assert.equal(big.truncated, true);
    assert.equal(big.rows.length, 10000);
    const { checkResult } = await import('../src/plugins/expanded/db-checks.js');
    assert.deepEqual(checkResult(big, { max: 20000 }), ['expected at most 20000 row(s), found 10000 or more']);
    assert.deepEqual(checkResult(big, { count: 10000 }), ['expected 10000 row(s), found 10000 or more']);
  } finally { await conn.close(); delete process.env.QA_DB_URL_TEST; }
});

test('Check files are validated before any query runs', async () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['checks:\n  - name: x\n    sql: "WITH d AS (DELETE FROM promotions RETURNING id) SELECT id FROM d"', { type: 'postgres' }, /"DELETE" is not allowed/],
    ['checks:\n  - name: x\n    sql: "SELECT 1; DROP TABLE promotions"', { type: 'postgres' }, /exactly one SQL statement|"DROP" is not allowed/],
    ['checks:\n  - name: x\n    sql: "SELECT 1 -- hidden"', { type: 'postgres' }, /Remove comments/],
    ['checks:\n  - name: x\n    sql: "SELECT * INTO copy_t FROM promotions"', { type: 'postgres' }, /"INTO" is not allowed/],
    ['checks:\n  - name: x\n    sql: "SELECT id FROM t WHERE id = {{id}}"', { type: 'postgres' }, /Put values in params/],
    ['checks:\n  - name: x\n    sql: "UPDATE promotions SET active = false"', { type: 'postgres' }, /Only SELECT/],
    ['checks:\n  - name: x\n    sql: "SELECT id FROM promotions FOR UPDATE"', { type: 'postgres' }, /Row locks/],
    ['checks:\n  - name: x\n    collection: promotions\n    filter: {}', { type: 'postgres' }, /needs sql/],
    ['checks:\n  - name: x\n    sql: "SELECT 1"', { type: 'mongodb' }, /needs collection/],
    ['checks:\n  - name: x\n    collection: promotions\n    pipeline: [{ $out: copy }]', { type: 'mongodb' }, /\$out is not allowed/],
    ['checks:\n  - { name: x, sql: "SELECT 1" }\n  - { name: x, sql: "SELECT 2" }', { type: 'postgres' }, /used twice/],
  ];
  for (const [text, database, message] of cases) {
    write('checks/bad.yaml', text);
    const r = await run({ database: { ...database, urlEnv: 'QA_DB_NOT_SET' }, files: 'checks/bad.yaml' });
    assert.equal(r.status, 'errored', text);
    assert.match(r.reason ?? '', message, text);
  }
  // String literals and identifiers may contain any word; functions such as replace() are fine.
  assert.equal(validateSql("SELECT replace(title, 'delete', 'x') AS \"update\" FROM promotions;"), "SELECT replace(title, 'delete', 'x') AS \"update\" FROM promotions");
  write('checks/ok.yaml', 'checks:\n  - name: x\n    sql: "SELECT 1"');
  assert.match((await run({ database: { type: 'postgres', urlEnv: 'QA_DB_NOT_SET' }, files: 'checks/ok.yaml' })).reason ?? '', /Set QA_DB_NOT_SET to a read-only connection string/);
  assert.equal(dbChecksSchema.safeParse({ database: { type: 'oracle' }, files: 'a.yaml' }).success, false);
  assert.equal(dbChecksSchema.safeParse({ database: { type: 'postgres', urlEnv: 'postgres://u:p@h/db' }, files: 'a.yaml' }).success, false, 'a URL is not an environment variable name');
});

test('MongoDB helpers: forbidden stages, Extended JSON, plain values, connection errors without passwords', async () => {
  assert.throws(() => validateMongoQuery({ collection: 'p', pipeline: [{ $match: { a: 1 } }, { $merge: { into: 'x' } }] }), /\$merge is not allowed/);
  assert.throws(() => validateMongoQuery({ collection: 'p', filter: { $where: 'this.a > 1' } }), /\$where is not allowed/);
  assert.throws(() => validateMongoQuery({ collection: 'p', pipeline: [{ $group: { _id: null, x: { $accumulator: {} } } }] }), /\$accumulator/);
  assert.throws(() => validateMongoQuery({ collection: 'system.users', filter: {} }), /not allowed/);
  const filter = fromExtendedJson({ _id: { $oid: '5f0000000000000000000a01' }, at: { $gte: { $date: '2026-01-01T00:00:00Z' } } }) as Record<string, any>;
  assert.equal(filter._id._bsontype, 'ObjectId');
  assert.ok(filter.at.$gte instanceof Date);
  assert.deepEqual(toPlain({ _id: new BSON.ObjectId('5f0000000000000000000a01'), price: BSON.Decimal128.fromString('9.99'), n: BSON.Long.fromNumber(42), at: new Date('2026-01-02T03:04:05Z'), file: new BSON.Binary(Buffer.from('abc')), nested: [{ big: 12345678901234567890n }] }),
    { _id: '5f0000000000000000000a01', price: '9.99', n: 42, at: '2026-01-02T03:04:05.000Z', file: '[binary 3 bytes]', nested: [{ big: '12345678901234567890' }] });
  process.env.QA_DB_URL_TEST = 'mongodb://qa_reader:S3cretPassw0rd@127.0.0.1:1/mlitech';
  try { await assert.rejects(openDb({ type: 'mongodb', urlEnv: 'QA_DB_URL_TEST' }, 1000), (e: Error) => /Cannot connect to MongoDB/.test(e.message) && !/S3cretPassw0rd/.test(e.message)); }
  finally { delete process.env.QA_DB_URL_TEST; }
  assert.equal(scrubDbError('failed postgres://u:p@h/db and mysql://a:b@c'), 'failed postgres://[redacted] and mysql://[redacted]');
});
