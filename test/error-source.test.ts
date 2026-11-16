import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { runPlugins } from '../src/core/runner.js';
import { postDeployErrors } from '../src/plugins/expanded/operations-checks.js';
import { fingerprintOf, normalizeErrorText } from '../src/plugins/expanded/error-source.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-errors-'));
const deployedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
const deployed = Date.parse(deployedAt);
const TOKEN = 'error-source-fixture-token';
let url = '', base: RunContext, requests: URL[] = [], authHeaders: string[] = [], mode = 'paged';

/** Baseline hour: A×10. Current hour: A×10 (same rate), B×3 with varying personal data, C×2 from an old release. */
function events() {
  const list: Record<string, unknown>[] = [];
  for (let i = 0; i < 10; i++) list.push({ ts: new Date(deployed - 3_000_000 + i * 1000).toISOString(), fp: 'a1b2c3d4e5f60718', rel: 'v1' });
  for (let i = 0; i < 10; i++) list.push({ ts: new Date(deployed + 60_000 + i * 1000).toISOString(), fp: 'a1b2c3d4e5f60718', rel: 'v2' });
  for (let i = 0; i < 3; i++) list.push({ ts: new Date(deployed + 120_000 + i * 1000).toISOString(), msg: `Payment failed for user${i}@example.test order ${1000 + i}`, rel: 'v2' });
  for (let i = 0; i < 2; i++) list.push({ ts: new Date(deployed + 180_000 + i * 1000).toISOString(), msg: 'Stale client error', rel: 'v1' });
  list.push({ ts: new Date(deployed - 7_200_000).toISOString(), msg: 'outside both windows', rel: 'v0' });
  return list;
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url!, url); requests.push(u); authHeaders.push(req.headers.authorization ?? '');
  const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (mode === 'error') return reply(500, { error: TOKEN });
  if (mode === 'redirect') return reply(302, {}, { location: '/elsewhere' });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401);
  const all = events().filter(e => { const t = Date.parse(e.ts as string); return t >= Date.parse(u.searchParams.get('from')!) && t < Date.parse(u.searchParams.get('to')!); });
  const size = Number(u.searchParams.get('limit')), offset = Number(u.searchParams.get('cursor') ?? 0);
  const page = all.slice(offset, offset + size);
  const next = offset + size < all.length ? String(offset + size) : null;
  if (mode === 'oversized') return reply(200, { data: { items: all } });
  if (mode === 'repeat') return reply(200, { data: { items: page }, next: '0' });
  if (mode === 'no-array') return reply(200, { data: {} });
  reply(200, { data: { items: page }, next });
});
before(async () => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { config } = await loadConfig('test/fixture.config.ts', {});
  base = { config, configDir: dir, outDir: path.join(dir, 'out'), suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
  fs.writeFileSync(path.join(dir, 'events.ndjson'), events().map(e => JSON.stringify(e)).join('\n') + '\n');
});
after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.VERIQ_ERRORS_TOKEN; });

const fields = { timestamp: 'ts', fingerprint: 'fp', message: 'msg', release: 'rel' };
const windows = { deployedAt, baselineSeconds: 3600, currentSeconds: 3600 };
const httpSource = (extra: Record<string, unknown> = {}) => ({ kind: 'http', url: `${url}/events`, tokenEnv: 'VERIQ_ERRORS_TOKEN', pageSize: 4, eventsPath: 'data.items', nextCursorPath: 'next', fields, ...extra });
async function run(settings: Record<string, unknown>) {
  requests = []; authHeaders = [];
  const config = { ...structuredClone(base.config), pluginSettings: { 'post-deploy-errors': settings } };
  return (await runPlugins([postDeployErrors], { ...base, config }))[0];
}
function assertNoPersonalData(value: unknown, label: string) {
  const text = JSON.stringify(value);
  for (const secret of ['example.test', 'Payment failed', 'Stale client', TOKEN, 'a1b2c3d4e5f60718']) assert.ok(!text.includes(secret), `${label}: ${secret} leaked`);
}

test('An NDJSON source builds normalized windows, attributes by release and exports redacted, re-importable windows', async () => {
  const result = await run({ release: 'v2', source: { kind: 'ndjson', file: 'events.ndjson', fields }, windows });
  assert.equal(result.status, 'failed', result.reason);
  assert.deepEqual(result.findings.map(f => f.title), ['New post-deploy error type']);
  assert.equal(result.findings[0].target, fingerprintOf('msg', 'Payment failed for user0@example.test order 1000'));
  assert.equal(result.stats?.baselineEvents, 10); assert.equal(result.stats?.currentEvents, 13);
  assert.equal(result.stats?.otherReleaseEvents, 2, 'old-release events after the deploy are not attributed to v2');
  assertNoPersonalData(result, 'result');
  const baselineFile = path.join(dir, 'out', 'post-deploy-errors-baseline.json'), currentFile = path.join(dir, 'out', 'post-deploy-errors-current.json');
  for (const file of [baselineFile, currentFile]) assertNoPersonalData(fs.readFileSync(file, 'utf8'), path.basename(file));
  // The exports are valid window files: re-importing them gives the same verdict.
  const reimported = await run({ release: 'v2', baseline: 'out/post-deploy-errors-baseline.json', current: 'out/post-deploy-errors-current.json' });
  assert.deepEqual(reimported.findings.map(f => [f.title, f.target]), result.findings.map(f => [f.title, f.target]));
  // Without a release field, every post-deploy event counts.
  const noRelease = await run({ release: 'v2', source: { kind: 'ndjson', file: 'events.ndjson', fields: { timestamp: 'ts', fingerprint: 'fp', message: 'msg' } }, windows });
  assert.equal(noRelease.findings.length, 2);
});

test('A paged HTTP source follows cursors with the token, bounded time range and page size', async () => {
  process.env.VERIQ_ERRORS_TOKEN = TOKEN;
  const result = await run({ release: 'v2', source: httpSource(), windows });
  assert.equal(result.status, 'failed', result.reason);
  assert.deepEqual(result.findings.map(f => f.title), ['New post-deploy error type']);
  assert.equal(result.stats?.sourcePages, 7); // 25 in-range events, 4 per page
  assert.ok(authHeaders.every(h => h === `Bearer ${TOKEN}`));
  assert.ok(requests.every(r => r.searchParams.get('from') === new Date(deployed - 3_600_000).toISOString() && r.searchParams.get('to') === new Date(deployed + 3_600_000).toISOString() && r.searchParams.get('limit') === '4'));
  assertNoPersonalData(result, 'http');
});

test('Incomplete, unbounded or unreachable sources error without a partial pass or leaked secrets', async () => {
  process.env.VERIQ_ERRORS_TOKEN = TOKEN;
  const cases: Array<[string, Record<string, unknown>, string?]> = [
    ['too many pages', { release: 'v2', source: httpSource({ maxPages: 2 }), windows }],
    ['repeated cursor', { release: 'v2', source: httpSource(), windows }, 'repeat'],
    ['page larger than requested', { release: 'v2', source: httpSource(), windows }, 'oversized'],
    ['missing events array', { release: 'v2', source: httpSource(), windows }, 'no-array'],
    ['server error', { release: 'v2', source: httpSource(), windows }, 'error'],
    ['redirect', { release: 'v2', source: httpSource(), windows }, 'redirect'],
  ];
  for (const [label, settings, nextMode] of cases) {
    mode = nextMode ?? 'paged';
    const result = await run(settings);
    assert.equal(result.status, 'errored', label);
    assert.ok(!JSON.stringify(result).includes(TOKEN), `${label}: token leaked`);
  }
  mode = 'paged';
  const before = requests.length;
  const unfinished = await run({ release: 'v2', source: httpSource(), windows: { ...windows, deployedAt: new Date(Date.now() - 1_800_000).toISOString() } });
  assert.equal(unfinished.status, 'errored'); assert.match(unfinished.reason ?? '', /not finished/); assert.equal(requests.length, 0, `no request for an unfinished window (${before})`);
  for (const [label, source] of [
    ['plain http to a remote host', httpSource({ url: 'http://errors.example.test/events' })],
    ['credentials in URL', httpSource({ url: `${url.replace('http://', 'http://user:pass@')}/events` })],
    ['paging parameter already in URL', httpSource({ url: `${url}/events?cursor=1` })],
  ] as const) {
    const result = await run({ release: 'v2', source, windows });
    assert.equal(result.status, 'errored', label); assert.equal(requests.length, 0, label);
  }
  delete process.env.VERIQ_ERRORS_TOKEN;
  assert.equal((await run({ release: 'v2', source: httpSource(), windows })).status, 'errored', 'missing token variable');
  assert.equal(requests.length, 0);
});

test('Invalid NDJSON input and unsafe paths error with a line number but no content', async () => {
  fs.writeFileSync(path.join(dir, 'bad.ndjson'), `${JSON.stringify(events()[0])}\n{"ts": "x", "msg": "secret@example.test"}\n`);
  const bad = await run({ release: 'v2', source: { kind: 'ndjson', file: 'bad.ndjson', fields }, windows });
  assert.equal(bad.status, 'errored'); assert.match(bad.reason ?? '', /line 2/); assert.ok(!(bad.reason ?? '').includes('secret'));
  fs.writeFileSync(path.join(dir, 'notjson.ndjson'), 'not json with secret@example.test\n');
  const notJson = await run({ release: 'v2', source: { kind: 'ndjson', file: 'notjson.ndjson', fields }, windows });
  assert.equal(notJson.status, 'errored'); assert.ok(!(notJson.reason ?? '').includes('secret'));
  fs.symlinkSync(path.join(dir, 'events.ndjson'), path.join(dir, 'link.ndjson'));
  for (const file of ['link.ndjson', '../events.ndjson', path.join(dir, 'events.ndjson'), 'missing.ndjson']) {
    assert.equal((await run({ release: 'v2', source: { kind: 'ndjson', file, fields }, windows })).status, 'errored', file);
  }
  for (const settings of [
    { release: 'v2', source: { kind: 'ndjson', file: 'events.ndjson', fields: { timestamp: 'ts' } }, windows },
    { release: 'v2', source: { kind: 'ndjson', file: 'events.ndjson', fields }, baseline: 'x.json', current: 'y.json', windows },
    { release: 'v2', source: { kind: 'ndjson', file: 'events.ndjson', fields } },
    { release: 'v2', source: { kind: 'ndjson', file: 'events.ndjson', fields }, windows: { ...windows, currentSeconds: 10 } },
  ]) assert.equal((await run(settings)).status, 'errored', JSON.stringify(settings));
});

test('Normalization groups equal messages and keeps distinct provider fingerprints distinct', () => {
  assert.equal(normalizeErrorText('User a.b@example.test failed 3 times at https://x.test/a?t=1 id 0f1e2d3c4b5a6978'), 'User <email> failed <n> times at <url> id <hex>');
  assert.equal(fingerprintOf('msg', 'Order 1 failed for x@example.test'), fingerprintOf('msg', 'Order 2 failed for y@example.test'));
  assert.notEqual(fingerprintOf('fp', 'a1b2c3d4e5f60718'), fingerprintOf('fp', 'ffffeeeeddddcccc'), 'hash-like provider fingerprints must not collapse');
  assert.equal(fingerprintOf('fp', 'Crash for a@example.test'), fingerprintOf('fp', 'Crash for b@example.test'));
});
