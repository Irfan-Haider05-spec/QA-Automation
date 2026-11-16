import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { HttpClient } from '../src/core/http.js';
import { AuthProvider } from '../src/core/auth.js';
import { runPlugins } from '../src/core/runner.js';
import { uptime } from '../src/plugins/expanded/operations-checks.js';
import {
  appendHistory, exportUptimeHistory, paginate, readHistory, redactTarget, resolveStorePath, summarizeTarget,
  uptimeRecordSchema, type UptimeRecord,
} from '../src/core/observation-history.js';

let url = '', closedUrl = '', base: RunContext, calls = 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-uptime-'));
const server = http.createServer((req, res) => {
  calls++;
  const pathname = new URL(req.url!, 'http://x').pathname;
  if (pathname === '/up') { res.end('ok'); return; }
  if (pathname === '/down') { res.writeHead(503); res.end(); return; }
  if (pathname === '/slow') { setTimeout(() => res.end('ok'), 150); return; }
  res.writeHead(404); res.end();
});
before(async () => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const closed = http.createServer(); await new Promise<void>(r => closed.listen(0, '127.0.0.1', r));
  closedUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`; await new Promise<void>(r => closed.close(() => r()));
  const { config } = await loadConfig('test/fixture.config.ts', {});
  config.target.baseUrl = url; config.target.requestsPerMinute = 60000;
  config.accounts = {};
  base = { config, configDir: dir, outDir: path.join(dir, 'out'), suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
});
after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(dir, { recursive: true, force: true }); });

const store = (file: string, extra: Record<string, unknown> = {}) => ({ path: file, intervalSeconds: 60, windowHours: 1, retentionDays: 2, ...extra });
async function run(settings: Record<string, unknown>, target = url) {
  calls = 0;
  const config = { ...structuredClone(base.config), pluginSettings: { uptime: settings } };
  config.target.baseUrl = target;
  const client = new HttpClient(target, 60000, 2000);
  return (await runPlugins([uptime], { ...base, config, http: client, auth: new AuthProvider(config, client) }))[0];
}
const lines = (file: string) => readHistory(path.join(dir, file), uptimeRecordSchema, 1e8, Date.now(), r => r.at);
const iso = (ms: number) => new Date(ms).toISOString();
function seed(file: string, records: UptimeRecord[]) { fs.writeFileSync(path.join(dir, file), records.map(r => JSON.stringify(r)).join('\n') + '\n'); }

test('Observations persist across separate runs with outcomes, redacted targets and a summary export', async () => {
  const settings = { requests: [{ path: '/up?token=fixture-secret' }, { path: '/down' }, { path: '/slow' }], maxMs: 50, store: store('history/a.jsonl') };
  const first = await run(settings);
  assert.equal(first.status, 'failed', first.reason);
  const second = await run(settings); // a fresh context, as after a restart
  assert.equal(second.status, 'failed', second.reason);
  const records = lines('history/a.jsonl');
  assert.equal(records.length, 6);
  assert.deepEqual(records.slice(0, 3).map(r => [r.target, r.outcome]), [['GET /up?[redacted]', 'up'], ['GET /down', 'down'], ['GET /slow', 'slow']]);
  assert.equal(records[1].status, 503); assert.equal(records[1].reason, 'http');
  const raw = fs.readFileSync(path.join(dir, 'history/a.jsonl'), 'utf8');
  assert.ok(!raw.includes('fixture-secret'));
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'uptime-history.json'), 'utf8'));
  assert.equal(summary.targets.length, 3);
  assert.equal(summary.targets.find((t: { target: string }) => t.target === 'GET /down').down, 2);
  assert.ok(!JSON.stringify(summary).includes('fixture-secret'));
  assert.equal(second.stats?.storedRecords, 6);
});

test('Failed checks and network outages are recorded differently and never as uptime', async () => {
  const authFailure = await run({ requests: [{ path: '/up', account: 'missing' }, { path: '/up' }], store: store('b.jsonl') });
  assert.equal(authFailure.status, 'errored', 'a check that cannot run must not pass');
  assert.match(authFailure.reason ?? '', /failed checks, not outages/);
  assert.deepEqual(lines('b.jsonl').map(r => [r.outcome, r.reason ?? null]), [['check-error', 'auth'], ['up', null]]);
  const network = await run({ requests: [{ path: '/up' }], store: store('c.jsonl') }, closedUrl);
  assert.equal(network.status, 'failed');
  const [record] = lines('c.jsonl');
  assert.equal(record.outcome, 'down'); assert.equal(record.reason, 'network');
  assert.ok(!JSON.stringify(network).includes(closedUrl.split(':').pop()!), 'raw network error text is not reported');
});

test('Coverage, availability, outage episodes and gaps count unobserved time as neither up nor down', () => {
  const now = Date.parse('2026-11-15T12:00:00.000Z'), start = now - 3600_000, t = 'GET /health';
  const at = (s: number, outcome: UptimeRecord['outcome']): UptimeRecord => ({ v: 1, at: iso(start + s * 1000), target: t, outcome });
  const records = [at(0, 'up'), at(300, 'up'), at(600, 'down'), at(900, 'down'), at(1200, 'up'), at(2000, 'check-error'), at(2700, 'up'), at(3000, 'up'), at(3300, 'up'),
    { v: 1 as const, at: iso(start + 100_000), target: 'GET /other', outcome: 'down' as const }];
  const s = summarizeTarget(records, t, now, 3600, 300);
  assert.equal(s.observations, 9); assert.equal(s.up, 6); assert.equal(s.down, 2); assert.equal(s.checkErrors, 1);
  assert.equal(s.coveragePercent, 70.833);            // 2550 of 3600 s observed
  assert.equal(s.observedAvailabilityPercent, 76.471); // 1950 of 2550 observed seconds up
  assert.equal(s.downSeconds, 600); assert.equal(s.outageEpisodes, 1); assert.equal(s.longestOutageSeconds, 600);
  assert.deepEqual(s.gaps, [{ from: iso(start + 1650_000), to: iso(start + 2700_000) }]);

  // An observation just before the window covers its start; an empty window has no availability.
  const seeded = summarizeTarget([at(-100, 'up'), at(1000, 'up')], t, now, 3600, 300);
  assert.equal(seeded.coveragePercent, Math.round((350 + 450) / 3600 * 100000) / 1000);
  const empty = summarizeTarget([], t, now, 3600, 300);
  assert.equal(empty.coveragePercent, 0); assert.equal(empty.observedAvailabilityPercent, null);
  assert.deepEqual(empty.gaps, [{ from: iso(start), to: iso(now) }]);
  // An outage still in progress runs to its last observation's reach.
  const ongoing = summarizeTarget([at(3000, 'up'), at(3300, 'down')], t, now, 3600, 300);
  assert.equal(ongoing.outageEpisodes, 1); assert.equal(ongoing.longestOutageSeconds, 300);
});

test('Availability targets are evaluated only with enough observed coverage', async () => {
  const now = Date.now();
  const full = Array.from({ length: 59 }, (_, i): UptimeRecord => ({ v: 1, at: iso(now - (59 - i) * 60_000), target: 'GET /up', outcome: i % 4 === 0 ? 'down' : 'up' }));
  seed('d.jsonl', full);
  const low = await run({ requests: [{ path: '/up' }], store: store('d.jsonl', { targetPercent: 99.9 }) });
  assert.equal(low.status, 'failed');
  assert.deepEqual(low.findings.map(f => f.title), ['Observed availability below target']);
  seed('e.jsonl', full.slice(-5));
  const sparse = await run({ requests: [{ path: '/up' }], store: store('e.jsonl', { targetPercent: 99.9 }) });
  assert.deepEqual(sparse.findings.map(f => f.title), ['Availability target not evaluable: history coverage too low']);
  seed('f.jsonl', full.map(r => ({ ...r, outcome: 'up' as const })));
  const healthy = await run({ requests: [{ path: '/up' }], store: store('f.jsonl', { targetPercent: 99.9 }) });
  assert.equal(healthy.status, 'passed', healthy.reason);
});

test('Retention prunes by age and count; concurrent writers do not lose records', async () => {
  const now = Date.now(), file = path.join(dir, 'g.jsonl');
  const rec = (ageMs: number, target = 'GET /up'): UptimeRecord => ({ v: 1, at: iso(now - ageMs), target, outcome: 'up' });
  seed('g.jsonl', [rec(3 * 86_400_000), rec(2000), rec(1000)]);
  const kept = await appendHistory(file, uptimeRecordSchema, [rec(0)], { retentionDays: 2, maxEntries: 2, maxBytes: 1e6 }, now, r => r.at);
  assert.deepEqual(kept.map(r => r.at), [rec(1000).at, rec(0).at]);
  await Promise.all(Array.from({ length: 8 }, (_, i) => appendHistory(file, uptimeRecordSchema, [rec(0, `GET /c${i}`)], { retentionDays: 2, maxEntries: 100, maxBytes: 1e6 }, now, r => r.at)));
  assert.equal(lines('g.jsonl').filter(r => r.target.startsWith('GET /c')).length, 8);
  assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.tmp') || f.endsWith('.lock')), 'no temporary or lock files remain');
});

test('Corrupt, future, linked or escaping history stops the run before any request and is left untouched', async () => {
  fs.writeFileSync(path.join(dir, 'bad.jsonl'), `${JSON.stringify({ v: 1, at: iso(Date.now()), target: 'GET /up', outcome: 'up' })}\n{"v":1,"at":"not-a-date","target":"private-value"}\n`);
  const before = fs.readFileSync(path.join(dir, 'bad.jsonl'));
  const corrupt = await run({ requests: [{ path: '/up' }], store: store('bad.jsonl') });
  assert.equal(corrupt.status, 'errored'); assert.match(corrupt.reason ?? '', /line 2 is invalid/);
  assert.ok(!(corrupt.reason ?? '').includes('private-value'));
  assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(path.join(dir, 'bad.jsonl')), before);

  seed('future.jsonl', [{ v: 1, at: iso(Date.now() + 3600_000), target: 'GET /up', outcome: 'up' }]);
  const future = await run({ requests: [{ path: '/up' }], store: store('future.jsonl') });
  assert.equal(future.status, 'errored'); assert.match(future.reason ?? '', /future/); assert.equal(calls, 0);

  fs.writeFileSync(path.join(dir, 'real.jsonl'), '');
  fs.symlinkSync(path.join(dir, 'real.jsonl'), path.join(dir, 'link.jsonl'));
  for (const file of ['link.jsonl', '../escape.jsonl', path.join(dir, 'abs.jsonl'), 'history.json']) {
    const result = await run({ requests: [{ path: '/up' }], store: store(file) });
    assert.equal(result.status, 'errored', file); assert.equal(calls, 0, file);
  }
  for (const extra of [{ windowHours: 49, retentionDays: 2 }, { intervalSeconds: 5 }, { maxEntries: 10 }]) {
    assert.equal((await run({ requests: [{ path: '/up' }], store: store('h.jsonl', extra) })).status, 'errored', JSON.stringify(extra));
  }
});

test('A fresh lock blocks the write and errors; a stale lock is recovered', async () => {
  seed('i.jsonl', []);
  const lock = path.join(dir, 'i.jsonl.lock');
  fs.writeFileSync(lock, '');
  const blocked = await run({ requests: [{ path: '/up' }], store: store('i.jsonl') });
  assert.equal(blocked.status, 'errored'); assert.match(blocked.reason ?? '', /locked/);
  assert.equal(lines('i.jsonl').length, 0, 'nothing written while locked');
  const old = new Date(Date.now() - 300_000); fs.utimesSync(lock, old, old);
  const recovered = await run({ requests: [{ path: '/up' }], store: store('i.jsonl') });
  assert.equal(recovered.status, 'passed', recovered.reason);
  assert.equal(lines('i.jsonl').length, 1); assert.ok(!fs.existsSync(lock));
});

test('Exports page through filtered records with filter-bound cursors', () => {
  const now = Date.now();
  seed('j.jsonl', Array.from({ length: 5 }, (_, i): UptimeRecord => ({ v: 1, at: iso(now - (5 - i) * 1000), target: i % 2 ? 'GET /b' : 'GET /a', outcome: i === 2 ? 'down' : 'up' })));
  const file = path.join(dir, 'j.jsonl');
  const first = exportUptimeHistory(file, { target: 'GET /a', limit: 2 });
  assert.equal(first.total, 3); assert.equal(first.records.length, 2); assert.ok(first.nextCursor);
  const second = exportUptimeHistory(file, { target: 'GET /a', limit: 2, cursor: first.nextCursor! });
  assert.equal(second.records.length, 1); assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.records, ...second.records].map(r => r.outcome), ['up', 'down', 'up']);
  assert.throws(() => exportUptimeHistory(file, { target: 'GET /b', cursor: first.nextCursor! }), /different filters/);
  assert.throws(() => exportUptimeHistory(file, { cursor: 'garbage' }), /Cursor/);
  assert.throws(() => exportUptimeHistory(file, { limit: 1001 }));
  assert.throws(() => exportUptimeHistory(file, { from: iso(now), to: iso(now - 1000) }));
  assert.equal(exportUptimeHistory(file, { outcome: 'down' }).total, 1);
  assert.throws(() => paginate([1, 2], 'k', Buffer.from('9.' + 'x'.repeat(16)).toString('base64url'), 1), /Cursor/);
  assert.equal(redactTarget('GET', '/health?key=1'), 'GET /health?[redacted]');
  assert.throws(() => resolveStorePath(dir, 'a/../../b.jsonl'));
});

test('uptime-export CLI prints a JSON page and refuses paths outside the working directory', () => {
  const cwd = dir;
  const cli = path.resolve('src/cli.ts');
  // Resolve tsx from the repository, since the CLI runs in a temporary directory.
  const tsx = pathToFileURL(createRequire(path.resolve('package.json')).resolve('tsx')).href;
  const out = execFileSync(process.execPath, ['--import', tsx, cli, 'uptime-export', '--file', 'j.jsonl', '--limit', '2'], { cwd, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  const page = JSON.parse(out);
  assert.equal(page.total, 5); assert.equal(page.records.length, 2); assert.ok(page.nextCursor);
  assert.throws(() => execFileSync(process.execPath, ['--import', tsx, cli, 'uptime-export', '--file', '../x.jsonl'], { cwd, stdio: 'pipe' }));
});
