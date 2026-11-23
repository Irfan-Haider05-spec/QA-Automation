import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { HttpClient } from '../src/core/http.js';
import { runPlugins } from '../src/core/runner.js';
import { gate } from '../src/core/triage.js';
import { injectionProbesPlugin, injectionProbesSchema, place } from '../src/plugins/expanded/injection-probes.js';

const PORT = 4051;
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-inject-'));
let server: ChildProcess;
let base: RunContext;
const sent: string[] = [];

before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', path.resolve('test/injection-api.ts')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const { config } = await loadConfig('test/fixture.config.ts', {});
  const http = new HttpClient(`http://127.0.0.1:${PORT}`, 6000, 15_000);
  const orig = http.send.bind(http);
  http.send = async (req) => { sent.push(JSON.stringify({ path: req.path, json: req.json })); return orig(req); };
  base = { config, configDir: out, outDir: out, suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, http, log: { info() {}, warn() {}, debug() {} } };
});
after(() => { server?.kill(); fs.rmSync(out, { recursive: true, force: true }); });

async function run(cases: unknown[], writes = true) {
  const config = { ...structuredClone(base.config), pluginSettings: { 'injection-probes': { cases } }, allowMutations: writes, disposable: writes };
  return (await runPlugins([injectionProbesPlugin], { ...base, config }))[0];
}
const login = (p: string, kinds: string[]) => ({ name: p, path: p, json: { email: 'ali@shop.test', password: '{{probe}}' }, kinds, success: { status: [200], json: [{ path: '$.data.accessToken', exists: true }] } });
const search = (p: string, kinds: string[], extra = {}) => ({ name: p, method: 'GET', path: p, query: { q: '{{probe}}' }, kinds, resultPath: '$.data', ...extra });

test('NoSQL: an operator object that logs in or widens a search is found; the safe twin is not; a crash is reported as missing validation', async () => {
  const crash = { ...login('/nosql/login-crash', ['nosql']), json: { email: '{{probe}}', password: 'x' } };
  const r = await run([login('/nosql/login-vulnerable', ['nosql']), login('/nosql/login-safe', ['nosql']), crash, search('/nosql/search-vulnerable', ['nosql'])]);
  assert.equal(r.status, 'failed', r.reason);
  const got = r.findings.map((f) => [f.title, f.target, f.severity]);
  assert.deepEqual(got, [
    ['NoSQL operator injection', 'POST /nosql/login-vulnerable › /nosql/login-vulnerable', 'critical'],
    ['Operator input causes a server error', 'POST /nosql/login-crash › /nosql/login-crash', 'medium'],
    ['NoSQL operator injection', 'GET /nosql/search-vulnerable › /nosql/search-vulnerable', 'critical'],
  ]);
  assert.match(r.findings[0].detail ?? '', /control \(ordinary value\): HTTP 401, not accepted\n- operator \{"\$ne":null\}: HTTP 200, accepted/);
  assert.match(r.findings[2].detail ?? '', /control \(ordinary value\): HTTP 200, 0 result\(s\)\n- operator \{"\$ne":null\}: HTTP 200, 3 result\(s\)/);
  assert.match(r.findings[2].evidence?.curl ?? '', /q%5B%24ne%5D=/, 'query strings use the field[$op]= form');
  assert.deepEqual(r.findings[0].cwe, ['CWE-943']);
  assert.equal(gate([r], 'high').blocking.length, 2);
});

test('SQL: boolean, error-based and (when asked) time-based injection on real PostgreSQL queries; parameterised queries stay quiet; nothing is changed', async () => {
  const before = await (await fetch(`http://127.0.0.1:${PORT}/sql/count`)).json();
  sent.length = 0;
  const r = await run([
    login('/sql/login-vulnerable', ['sql']),
    search('/sql/search-vulnerable', ['sql']),
    search('/sql/search-errors', ['sql']),
    search('/sql/search-safe', ['sql', 'nosql']),
    search('/sql/search-blind', ['sql'], { timeBased: true, delaySeconds: 2 }),
  ]);
  assert.equal(r.status, 'failed', r.reason);
  assert.deepEqual(r.findings.map((f) => [f.title, f.target.split(' › ')[1], f.severity]), [
    ['SQL injection (boolean condition)', '/sql/login-vulnerable', 'critical'],
    ['SQL injection (boolean condition)', '/sql/search-vulnerable', 'critical'],
    ['SQL injection (database error exposed)', '/sql/search-errors', 'high'],
    ['SQL injection (time delay)', '/sql/search-blind', 'critical'],
  ]);
  assert.match(r.findings[1].detail ?? '', /TRUE condition "veriq' OR '1'='1": HTTP 200, 3 result\(s\)\n- FALSE condition "veriq' AND '1'='2": HTTP 200, 0 result\(s\)/);
  assert.match(r.findings[2].detail ?? '', /unterminated quoted string/);
  assert.match(r.findings[3].detail ?? '', /slowed the answer twice/);
  assert.deepEqual(r.findings[0].cwe, ['CWE-89']);
  assert.ok(!sent.some((s) => /;\s*\w/.test(JSON.parse(s).path + JSON.stringify(JSON.parse(s).json ?? ''))), 'no stacked statements are sent');
  assert.ok(!sent.some((s) => /drop|delete|update|insert/i.test(s)), 'no data-changing SQL is sent');
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${PORT}/sql/count`)).json(), before);

  const noTime = await run([search('/sql/search-blind', ['sql'])]);
  assert.equal(noTime.status, 'passed', 'blind injection is only tested by delay when timeBased is on');
});

test('Only in a disposable environment; misconfigured cases are inconclusive, not passed', async () => {
  const skip = await run([login('/nosql/login-vulnerable', ['nosql'])], false);
  assert.equal(skip.status, 'skipped');
  // A success rule every answer meets makes the control "accepted": a bypass cannot be told apart.
  const loose = { name: 'loose', path: '/nosql/login-vulnerable', json: { email: '{{probe}}', password: 'x' }, kinds: ['nosql'], success: { status: [200, 401], json: [] } };
  const inc = await run([loose]);
  assert.equal(inc.status, 'errored');
  assert.match(inc.reason ?? '', /Every case was inconclusive: loose: the control value is already accepted/);
  const mixed = await run([loose, login('/nosql/login-vulnerable', ['nosql'])]);
  assert.equal(mixed.status, 'failed');
  assert.equal(mixed.stats?.inconclusive, 1);
});

test('No false positives: a flaky endpoint and an endpoint that treats any quote as a wildcard are not called injectable', async () => {
  const r = await run([login('/nosql/flaky', ['nosql']), search('/sql/quote-wildcard', ['sql'])]);
  assert.equal(r.status, 'passed', JSON.stringify(r.findings.map((f) => f.title)));
});

test('With a QA account, a refused control means the account does not work: inconclusive', async () => {
  const config = { ...structuredClone(base.config), pluginSettings: { 'injection-probes': { cases: [{ ...login('/nosql/login-vulnerable', ['nosql']), account: 'merchantA' }] } }, allowMutations: true, disposable: true };
  const auth = { header: async () => ({ Authorization: 'Bearer test-token' }), secretValues: () => ['test-token'] } as unknown as RunContext['auth'];
  const r = (await runPlugins([injectionProbesPlugin], { ...base, auth, config }))[0];
  assert.equal(r.status, 'errored');
  assert.match(r.reason ?? '', /control was refused \(HTTP 401\); check the account/);
});

test('Settings validation and probe placement', () => {
  const bad = (x: unknown) => assert.equal(injectionProbesSchema.safeParse({ cases: [x] }).success, false, JSON.stringify(x));
  bad({ name: 'a', path: '/a', json: { email: 'x' }, success: { status: [200] } });
  bad({ name: 'a', path: '/a', json: { email: '{{probe}}', password: '{{probe}}' }, success: { status: [200] } });
  bad({ name: 'a', path: '/a', json: { email: '{{probe}}' }, success: { status: [200] }, resultPath: '$.data' });
  bad({ name: 'a', method: 'GET', path: '/a', json: { email: '{{probe}}' }, success: { status: [200] } });
  bad({ name: 'a', path: 'https://evil.example/a', json: { email: '{{probe}}' }, success: { status: [200] } });
  assert.deepEqual(place({ user: { email: '{{probe}}', roles: ['a'] } }, { $ne: null }), { user: { email: { $ne: null }, roles: ['a'] } });
});
