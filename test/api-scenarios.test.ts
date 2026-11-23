import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { AuthProvider } from '../src/core/auth.js';
import { HttpClient } from '../src/core/http.js';
import { parseJUnit } from '../src/core/junit.js';
import { runPlugins } from '../src/core/runner.js';
import { gate } from '../src/core/triage.js';
import { check, diffValues, getPath, show, snapshotValue, validateSchema, checkSchemaKeywords } from '../src/core/json-assert.js';
import { apiScenariosPlugin, apiScenariosSchema, interpolate, loadScenarios, selectScenarios } from '../src/plugins/expanded/api-scenarios.js';
import { PGlite } from '@electric-sql/pglite';

const PORT = 4041;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-scenarios-'));
let server: ChildProcess;
let base: RunContext;
const A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };

before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', path.resolve('test/fixture-api/src/server.ts')], { env: { ...process.env, PORT: String(PORT), CLIENT_URL: 'http://localhost:5173' }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const { config } = await loadConfig('test/fixture.config.ts', {});
  config.target.baseUrl = `http://127.0.0.1:${PORT}`;
  const http = new HttpClient(config.target.baseUrl, 6000, 10_000);
  base = { config, configDir: root, outDir: path.join(root, 'out'), suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, http, auth: new AuthProvider(config, http), log: { info() {}, warn() {}, debug() {} } };
});
after(() => { server?.kill(); fs.rmSync(root, { recursive: true, force: true }); });

async function run(settings: Record<string, unknown>, extra: Partial<RunContext> = {}, writes = false) {
  const config = { ...structuredClone(base.config), pluginSettings: { 'api-scenarios': settings }, allowMutations: writes, disposable: writes };
  return (await runPlugins([apiScenariosPlugin], { ...base, ...extra, config }))[0];
}

const READS = `
version: 1
scenarios:
  - name: Merchant lists and opens own promotions
    tags: [smoke, regression]
    account: merchantA
    vars: { merchant: "${A}" }
    steps:
      - name: list
        request: { method: GET, path: /api/v1/promotion }
        expect:
          status: 200
          maxMs: 5000
          headers: { content-type: { contains: application/json } }
          json:
            - { path: $.success, equals: true }
            - { path: $.data, type: array, length: 2 }
            - { path: $.data, every: [{ path: $.merchantId, equals: "{{merchant}}" }] }
            - { path: $.data, some: [{ path: $.title, contains: "coffee" }] }
          schema:
            type: object
            required: [success, data]
            properties:
              success: { const: true }
              data:
                type: array
                items: { type: object, required: [_id, merchantId, title], properties: { _id: { type: string, format: objectid } } }
        save: { firstId: "$.data[0]._id", firstTitle: "$.data[0].title" }
      - name: open first
        request: { method: GET, path: "/api/v1/promotion/{{firstId}}" }
        expect:
          status: 200
          json: [{ path: $.data.title, equals: "{{firstTitle}}" }]
          snapshot: { ignore: [$.data._id] }
  - name: Anonymous user cannot list promotions
    tags: [smoke]
    steps:
      - request: { method: GET, path: /api/v1/promotion }
        expect: { status: 401, json: [{ path: $.success, equals: false }] }
  - name: Merchant B cannot open merchant A's promotion
    tags: [regression, security]
    severity: critical
    steps:
      - account: merchantA
        request: { method: GET, path: /api/v1/promotion }
        save: { aId: "$.data[0]._id" }
      - name: read as merchant B
        account: merchantB
        request: { method: GET, path: "/api/v1/promotion/{{aId}}" }
        expect: { status: [403, 404] }
`;

const WRITES = `
scenarios:
  - name: Merchant creates a promotion and reads it back
    tags: [regression, uat]
    account: merchantA
    vars: { title: "QA promo {{unique}}", discount: 15 }
    steps:
      - name: create
        request: { method: POST, path: /api/v1/promotion, json: { title: "{{title}}", discount: "{{discount}}" } }
        expect:
          status: 201
          json:
            - { path: $.data.title, equals: "{{title}}" }
            - { path: $.data.discount, equals: 15 }
            - { path: $.data.merchantId, equals: "${A}" }
        save: { promoId: $.data._id }
      - name: read back
        request: { method: GET, path: "/api/v1/promotion/{{promoId}}" }
        expect: { status: 200, json: [{ path: $.data.title, equals: "{{title}}" }], snapshot: { ignore: [$.data._id] } }
    cleanup:
      - name: remove
        request: { method: DELETE, path: "/api/v1/promotion/{{promoId}}" }
        expect: { status: [200, 204, 404] }
      - name: remove never-saved
        request: { method: DELETE, path: "/api/v1/promotion/{{neverSaved}}" }
  - name: Invalid promotion is rejected
    tags: [regression]
    account: merchantA
    steps:
      - request: { method: POST, path: /api/v1/promotion, json: { title: "x", discount: 500 } }
        expect: { status: 400, json: [{ path: $.success, equals: false }] }
`;

test('Read scenarios against a real API: passing checks, a tenant leak found, snapshots recorded then compared', async () => {
  write('scenarios/reads.yaml', READS);
  const settings = { files: 'scenarios/*.yaml' };

  const first = await run(settings);
  assert.equal(first.status, 'failed', first.reason);
  const titles = first.findings.map((f) => f.title).sort();
  assert.deepEqual(titles, ['API scenario failed: Merchant B cannot open merchant A\'s promotion', 'API snapshots not recorded yet']);
  const leak = first.findings.find((f) => f.title.includes('Merchant B'))!;
  assert.equal(leak.severity, 'critical');
  assert.match(leak.detail ?? '', /Step 2 of 2 "read as merchant B" \(GET \/api\/v1\/promotion\/5f0000000000000000000a01 as merchantB, HTTP 200\):\n- status: expected 403 or 404, got 200/);
  assert.match(leak.evidence?.curl ?? '', /Bearer \$QA_TOKEN_MERCHANTB/, 'the token is never in the evidence');
  assert.equal(leak.evidence?.status, 200);
  assert.equal(first.stats?.passed, 2);
  assert.equal(gate([first], 'high').blocking.length, 2, 'the leak and the unrecorded snapshot both block');

  const recorded = await run(settings, { updateBaseline: true });
  assert.ok(!recorded.findings.some((f) => f.title === 'API snapshots not recorded yet'));
  const snapFile = path.join(root, '.veriq/api-snapshots/merchant-lists-and-opens-own-promotions--open-first.json');
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  assert.deepEqual(snap.value, { data: { merchantId: A, title: 'A: 10% off' }, success: true }, 'ignored fields are left out');

  const again = await run(settings);
  assert.deepEqual(again.findings.map((f) => f.title), ['API scenario failed: Merchant B cannot open merchant A\'s promotion']);

  // The API's answer differs from the approved snapshot: reported as a regression with the changed path.
  snap.value.data.title = 'A: 5% off';
  fs.writeFileSync(snapFile, JSON.stringify(snap));
  const changed = await run(settings);
  const reg = changed.findings.find((f) => f.title === 'API scenario failed: Merchant lists and opens own promotions')!;
  assert.match(reg.detail ?? '', /snapshot: \$\.data\.title: was "A: 5% off", now "A: 10% off"/);

  // Reports: JSON and JUnit, readable by VeriQ's own JUnit parser (test-results, flaky-tests).
  const junit = parseJUnit(fs.readFileSync(path.join(root, 'out', 'api-scenarios.junit.xml'), 'utf8'));
  assert.deepEqual(junit.map((c) => [c.name, c.outcome]), [
    ['scenarios/reads.yaml Merchant lists and opens own promotions', 'failed'],
    ['scenarios/reads.yaml Anonymous user cannot list promotions', 'passed'],
    ["scenarios/reads.yaml Merchant B cannot open merchant A's promotion", 'failed'],
  ]);
  const json = JSON.parse(fs.readFileSync(path.join(root, 'out', 'api-scenarios.json'), 'utf8'));
  assert.equal(json.results[0].steps[0].status, 200);
  fs.rmSync(path.join(root, 'scenarios'), { recursive: true });
});

test('Writing scenarios run only in a disposable environment; failures stop later steps, cleanup always runs', async () => {
  write('scenarios/writes.yaml', WRITES);
  const settings = { files: 'scenarios/writes.yaml' };
  const notAllowed = await run(settings);
  assert.equal(notAllowed.status, 'skipped');
  assert.match(notAllowed.reason ?? '', /All 2 selected scenario\(s\) write data/);

  const r = await run(settings, {}, true);
  assert.equal(r.status, 'failed', r.reason);
  assert.deepEqual(r.findings.map((f) => f.title), ['API scenario failed: Merchant creates a promotion and reads it back'], 'a step that already failed gets no extra "snapshot not recorded" finding');
  assert.match(r.findings[0].detail ?? '', /Step 2 of 2 "read back" \(GET \/api\/v1\/promotion\/5f00000000000000000000ff as merchantA, HTTP 404\):\n- status: expected 200, got 404/, 'a create that is not persisted is caught');
  assert.equal(r.stats?.passed, 1, 'the validation scenario passes');
  const report = JSON.parse(fs.readFileSync(path.join(root, 'out', 'api-scenarios.json'), 'utf8'));
  const created = report.results[0];
  assert.equal(created.steps[0].ok, true);
  assert.deepEqual(created.cleanup.map((c: { name: string; ok: boolean; skipped?: string }) => [c.name, c.ok, c.skipped ?? '']), [
    ['remove', true, ''],
    ['remove never-saved', false, 'Unknown variable {{neverSaved}}'],
  ]);
  fs.rmSync(path.join(root, 'scenarios'), { recursive: true });
});

test('Tags select smoke/regression sets, from settings or QA_SCENARIO_TAGS', async () => {
  write('scenarios/reads.yaml', READS);
  const smoke = await run({ files: 'scenarios/reads.yaml', tags: ['smoke'] });
  assert.equal(smoke.stats?.scenarios, 2);
  const noSecurity = await run({ files: 'scenarios/reads.yaml', excludeTags: ['security'] });
  assert.equal(noSecurity.stats?.scenarios, 2);
  process.env.QA_SCENARIO_TAGS = 'security';
  try {
    const env = await run({ files: 'scenarios/reads.yaml', tags: ['smoke'] });
    assert.equal(env.stats?.scenarios, 1, 'the environment variable overrides the configured tags');
  } finally { delete process.env.QA_SCENARIO_TAGS; }
  const none = await run({ files: 'scenarios/reads.yaml', tags: ['nothing'] });
  assert.equal(none.status, 'skipped');
  assert.match(none.reason ?? '', /No scenario matches tags nothing \(3 defined\)/);
  fs.rmSync(path.join(root, 'scenarios'), { recursive: true });
});

test('Timing, unknown variables, environment variables and an unreachable target are reported per step', async () => {
  process.env.QA_SCENARIO_SEARCH = 'coffee';
  process.env.SECRET_NOT_QA = 'x';
  write('scenarios/misc.yaml', `
scenarios:
  - name: Slow endpoint
    account: merchantA
    steps:
      - request: { method: GET, path: /api/v1/system/slow }
        expect: { maxMs: 500 }
  - name: Search uses an environment variable
    account: merchantA
    steps:
      - request: { method: GET, path: /api/v1/promotion/search, query: { q: "{{env.QA_SCENARIO_SEARCH}}", limit: 5 } }
        expect: { json: [{ path: "$.data[0].title", equals: "A: free coffee" }, { path: $.data, length: 1 }] }
  - name: Unknown variable
    steps:
      - request: { method: GET, path: "/api/v1/promotion/{{missing}}" }
  - name: Non-QA environment variable
    steps:
      - request: { method: GET, path: "/health", query: { x: "{{env.SECRET_NOT_QA}}" } }
`);
  try {
    const r = await run({ files: 'scenarios/misc.yaml' });
    const by = Object.fromEntries(r.findings.map((f) => [f.title.replace('API scenario failed: ', ''), f.detail ?? '']));
    assert.match(by['Slow endpoint'], /time: expected at most 500 ms, took \d{4} ms/);
    assert.ok(!by['Search uses an environment variable'], 'query string built from an environment variable');
    assert.match(by['Unknown variable'], /Unknown variable \{\{missing\}\}/);
    assert.match(by['Non-QA environment variable'], /Only QA_\* environment variables can be used/);

    const down = await run({ files: 'scenarios/misc.yaml' }, { http: new HttpClient('http://127.0.0.1:1', 600, 2000) });
    assert.match(down.findings.find((f) => f.title.endsWith('Slow endpoint'))!.detail ?? '', /No response: /);
  } finally { delete process.env.QA_SCENARIO_SEARCH; delete process.env.SECRET_NOT_QA; fs.rmSync(path.join(root, 'scenarios'), { recursive: true }); }
});

test('Step control: a step without expectations must return 2xx, later steps are not sent after a failure, path values stay one segment', async () => {
  write('scenarios/control.yaml', `
scenarios:
  - name: Missing product stops the scenario
    account: merchantA
    steps:
      - name: open product
        request: { method: GET, path: /api/v1/product/123 }
      - name: never sent
        request: { method: GET, path: /health }
  - name: Path values are encoded
    account: merchantA
    vars: { weird: "a/../promotion" }
    steps:
      - request: { method: GET, path: "/api/v1/promotion/{{weird}}" }
        expect: { status: 404 }
`);
  try {
    const r = await run({ files: 'scenarios/control.yaml' });
    const stop = r.findings.find((f) => f.title.endsWith('Missing product stops the scenario'))!;
    assert.match(stop.detail ?? '', /Step 1 of 2 "open product" \(GET \/api\/v1\/product\/123 as merchantA, HTTP 404\):\n- status: expected 2xx, got 404/);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'out', 'api-scenarios.json'), 'utf8'));
    const [first, second] = report.results;
    assert.deepEqual(first.steps.map((x: { name: string; skipped?: string; status?: number }) => [x.name, x.skipped ?? '', x.status ?? null]), [['open product', '', 404], ['never sent', 'an earlier step failed', null]]);
    assert.equal(r.stats?.requests, 2, 'only two requests were sent: the failing step and the encoded path');
    assert.equal(second.steps[0].path, '/api/v1/promotion/a%2F..%2Fpromotion', 'a value cannot add path segments or climb with ..');
    assert.equal(second.status, 'passed');
  } finally { fs.rmSync(path.join(root, 'scenarios'), { recursive: true }); }
});

test('Scenario files are validated: problems are configuration errors naming the file, never skipped', async () => {
  const cases: [string, string, RegExp][] = [
    ['bad.yaml', 'scenarios: [ { name: x, steps: [ { request: { path: /a } } ] }', /could not be parsed/],
    ['unquoted.yaml', 'scenarios:\n  - name: x\n    steps:\n      - request: { path: /a }\n        save: { id: $.data[0].id }', /put JSON paths with \[ \] in quotes/],
    ['dup.yaml', 'scenarios:\n  - { name: same, steps: [ { request: { path: /a } } ] }\n  - { name: same, steps: [ { request: { path: /b } } ] }', /used twice/],
    ['op.yaml', 'scenarios:\n  - { name: x, steps: [ { request: { path: /a }, expect: { json: [ { path: $.a } ] } } ] }', /Give the assertion an operator/],
    ['ref.yaml', 'scenarios:\n  - { name: x, steps: [ { request: { path: /a }, expect: { schema: { $ref: "#/x" } } } ] }', /unsupported JSON Schema keyword "\$ref"/],
    ['host.yaml', 'scenarios:\n  - { name: x, steps: [ { request: { path: "https://evil.example/a" } } ] }', /Use a path on the target/],
    ['extra.yaml', 'scenarios:\n  - { name: x, stesp: [] }', /scenarios\.0/],
    ['regex.yaml', 'scenarios:\n  - { name: x, steps: [ { request: { path: /a }, expect: { text: { matches: "(" } } } ] }', /invalid regular expression/],
  ];
  for (const [file, text, message] of cases) {
    write(`bad/${file}`, text);
    const r = await run({ files: `bad/${file}` });
    assert.equal(r.status, 'errored', file);
    assert.match(r.reason ?? '', message, file);
    assert.match(r.reason ?? '', new RegExp(file.replace('.', '\\.')).source === 'dup\\.yaml' ? /dup\.yaml/ : /./);
  }
  write('bad/data.json', JSON.stringify({ scenarios: [{ name: 'json file', steps: [{ request: { path: '/health' }, expect: { json: [{ path: '$.success', equals: true }] } }] }] }));
  assert.equal(loadScenarios(root, ['bad/data.json']).length, 1, 'JSON files work too');
  assert.match((await run({ files: 'none/*.yaml' })).reason ?? '', /No scenario file matches none\/\*\.yaml/);
  fs.rmSync(path.join(root, 'bad'), { recursive: true });
});

test('Database steps: what the API returned is checked against what the database stored, and values flow both ways', async () => {
  const dir = path.join(root, 'pg');
  const lite = new PGlite(dir);
  await lite.exec("CREATE TABLE promotions (id INT PRIMARY KEY, title TEXT NOT NULL, discount INT NOT NULL); INSERT INTO promotions VALUES (7, 'A: 10% off', 10)");
  await lite.close();
  process.env.QA_DB_URL_SCENARIOS = `pglite://${dir}`;
  write('scenarios/db.yaml', `
scenarios:
  - name: Listed promotion is stored with the same title
    account: merchantA
    steps:
      - request: { method: GET, path: /api/v1/promotion }
        save: { firstTitle: "$.data[0].title" }
      - name: stored row
        db: { sql: "SELECT id, discount FROM promotions WHERE title = $1", params: ["{{firstTitle}}"], expect: { count: 1, json: [{ path: "$[0].discount", equals: 10 }] } }
        save: { storedId: "$[0].id" }
      - request: { method: GET, path: /health, query: { id: "{{storedId}}" } }
  - name: Missing row is reported
    steps:
      - name: look up
        db: { sql: "SELECT id FROM promotions WHERE title = $1", params: ["no such promotion"] }
`);
  try {
    const r = await run({ files: 'scenarios/db.yaml', database: { type: 'postgres', urlEnv: 'QA_DB_URL_SCENARIOS' } });
    assert.deepEqual(r.findings.map((f) => f.title), ['API scenario failed: Missing row is reported']);
    assert.match(r.findings[0].detail ?? '', /Step 1 of 1 "look up" \(database read on sql\):\n- expected at least 1 row\(s\), found 0/, 'a db step without expectations needs at least one row');
    const report = JSON.parse(fs.readFileSync(path.join(root, 'out', 'api-scenarios.json'), 'utf8'));
    assert.equal(report.results[0].steps[2].path, '/health?id=7', 'a value read from the database is used in the next request');

    const noDb = await run({ files: 'scenarios/db.yaml' });
    assert.equal(noDb.status, 'errored');
    assert.match(noDb.reason ?? '', /reads the database; set database in the api-scenarios settings/);
    write('scenarios/db.yaml', 'scenarios:\n  - name: x\n    steps:\n      - db: { sql: "DELETE FROM promotions" }\n');
    assert.match((await run({ files: 'scenarios/db.yaml', database: { type: 'postgres', urlEnv: 'QA_DB_URL_SCENARIOS' } })).reason ?? '', /Only SELECT/);
  } finally { delete process.env.QA_DB_URL_SCENARIOS; fs.rmSync(path.join(root, 'scenarios'), { recursive: true }); }
  const check = new PGlite(dir);
  try { assert.equal((await check.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM promotions')).rows[0].n, 1); } finally { await check.close(); }
});

test('Variables: typed whole templates, URL-encoded path values, selection helper', () => {
  const vars = { n: 15, s: 'a/../b c', obj: { k: 1 } };
  assert.equal(interpolate('{{n}}', vars), 15);
  assert.equal(interpolate('x{{n}}', vars), 'x15');
  assert.deepEqual(interpolate({ a: ['{{obj}}', '{{ s }}'] }, vars), { a: [{ k: 1 }, 'a/../b c'] });
  assert.equal(interpolate('/p/{{s}}', vars, true), '/p/a%2F..%2Fb%20c', 'path values cannot add path segments');
  assert.throws(() => interpolate('{{nope}}', vars), /Unknown variable/);
  const s = (tags: string[]) => ({ name: tags.join(), tags, file: 'f', severity: 'high' as const, vars: {}, steps: [], cleanup: [] });
  assert.deepEqual(selectScenarios([s(['smoke']), s(['regression']), s(['smoke', 'slow'])], ['smoke'], ['slow']).map((x) => x.name), ['smoke']);
  assert.equal(apiScenariosSchema.safeParse({ files: '/abs.yaml' }).success, false);
  assert.equal(apiScenariosSchema.safeParse({ files: 'a.yaml', tags: ['bad tag'] }).success, false);
});

test('JSON assertions, schema subset and snapshot helpers', () => {
  const doc = { data: { items: [{ id: 1, price: 10, tags: ['a'] }, { id: 2, price: 30, tags: [] }], 'odd key': 'x', password: 'hunter2' } };
  assert.deepEqual(getPath(doc, '$.data.items[-1].id'), { found: true, value: 2 });
  assert.deepEqual(getPath(doc, '$.data.items.length'), { found: true, value: 2 });
  assert.deepEqual(getPath(doc, '$.data["odd key"]'), { found: true, value: 'x' });
  assert.equal(getPath(doc, '$.data.__proto__').found, false, 'inherited properties are not reachable');
  assert.equal(getPath(doc, '$.data.constructor').found, false);
  assert.deepEqual(check(doc, { path: '$.data.items', every: [{ path: '$.price', gte: 5 }, { path: '$.tags', type: 'array' }] }), []);
  assert.deepEqual(check(doc, { path: '$.data.items', every: [{ path: '$.price', lt: 20 }] }), ['$.data.items[1].price: expected lt 20, got 30']);
  assert.deepEqual(check(doc, { path: '$.data.items', contains: { id: 2 } }), []);
  assert.deepEqual(check(doc, { path: '$.data.missing', exists: false }), []);
  assert.deepEqual(check(doc, { path: '$.data.password', equals: 'x' }), ['$.data.password: expected [redacted], got [redacted]'], 'secret values are not printed');
  assert.deepEqual(check(doc, { path: '$.data.items[0].id', type: 'integer', oneOf: [1, 3] }), []);
  assert.equal(show({ token: 'abc', a: 1 }), '{"token":"[redacted]","a":1}');

  const schema = { type: 'object', required: ['data'], additionalProperties: false, properties: { data: { type: 'object', properties: { items: { type: 'array', minItems: 1, items: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } } } } } };
  assert.deepEqual(validateSchema(doc, schema), []);
  assert.deepEqual(validateSchema({ data: { items: [{ id: 0 }] }, extra: 1 }, schema), ['$.data.items[0].id: below minimum 1', '$: unexpected property extra']);
  assert.deepEqual(validateSchema('2026-11-18T10:00:00Z', { type: 'string', format: 'date-time' }), []);
  assert.deepEqual(validateSchema(5, { anyOf: [{ type: 'string' }, { type: 'integer' }], not: { const: 4 } }), []);
  assert.throws(() => checkSchemaKeywords({ type: 'object', patternProperties: {} }), /unsupported JSON Schema keyword "patternProperties"/);
  assert.throws(() => checkSchemaKeywords({ type: 'string', format: 'ipv6' }), /unsupported format/);

  const snap = snapshotValue({ b: 1, a: { updatedAt: 't1', id: 'x', secret: 's' }, list: [{ at: 1, v: 1 }, { at: 2, v: 2 }] }, ['$.a.updatedAt', '$.list[*].at'], 'values');
  assert.deepEqual(snap, { a: { id: 'x', secret: '[redacted]' }, b: 1, list: [{ v: 1 }, { v: 2 }] });
  assert.deepEqual(snapshotValue({ a: 1, b: 'x', c: [true] }, [], 'shape'), { a: 'number', b: 'string', c: ['boolean'] });
  assert.deepEqual(diffValues({ a: 1, b: [1, 2] }, { a: 2, b: [1], c: true }), ['$.a: was 1, now 2', '$.b: 2 item(s) before, 1 now', '$.c: new property (true)']);
});
