import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { runPlugins } from '../src/core/runner.js';
import { mobileStatic } from '../src/plugins/expanded/scanner-adapters.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-mobsf-'));
// Wire-contract bytes only: this fixture is not a real installable APK/IPA.
const binary = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 4]);
const hash = createHash('md5').update(binary).digest('hex');
const sha256 = createHash('sha256').update(binary).digest('hex');
const key = 'fixture-private-mobsf-key-0123456789';
const previousKey = process.env.QA_MOBSF_FIXTURE_KEY;
let mode = 'healthy', url = '', base: RunContext, polls = 0;
let calls: string[] = [], uploads: Buffer[] = [], scans: URLSearchParams[] = [];
const report = () => ({ md5: mode === 'wrong-report' ? '0'.repeat(32) : hash,
  sha256: mode === 'wrong-sha' ? '0'.repeat(64) : sha256,
  code_analysis: { findings: mode === 'finding' ? { unsafe: { metadata: { severity: 'high', description: 'private-source-secret' } } } : mode === 'echo-key' ? { [key]: { metadata: { severity: 'high' } } } : { safe: { metadata: { severity: 'secure' } } } },
  ...(mode === 'ios' ? { binary_analysis: { findings: { insecure: { severity: 'high', detailed_desc: 'private-source-secret' } } } } : {}),
});
const server = http.createServer(async (req, res) => {
  calls.push(req.url!);
  const json = (body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== key) { json({ error: 'bad auth' }, 401); return; }
  if (mode === 'timeout') return;
  if (mode === 'redirect') { res.writeHead(307, { location: url + '/leak' }); res.end(); return; }
  if (mode === 'http-error') { json({ error: key }, 503); return; }
  if (mode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{' + key); return; }
  if (mode === 'oversized') { json('x'.repeat(1024 * 1024 + 10)); return; }
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (req.url === '/api/v1/upload') {
    const form = await new Request(url, { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: raw }).formData();
    const file = form.get('file') as File;
    uploads.push(Buffer.from(await file.arrayBuffer()));
    json({ hash: mode === 'wrong-upload' ? '0'.repeat(32) : hash, file_name: file.name, scan_type: file.name.endsWith('.ipa') ? 'ipa' : 'apk' }); return;
  }
  if (req.url === '/api/v1/scan') {
    scans.push(new URLSearchParams(raw.toString()));
    if (mode.startsWith('async')) json({ task_id: 'new_task' });
    else if (mode === 'cached') json({ task_id: null });
    else if (mode === 'scan-error') json({ error: key });
    else json({ md5: mode === 'wrong-scan' ? '0'.repeat(32) : hash });
    return;
  }
  if (req.url === '/api/v1/tasks') {
    polls++;
    json([{ task_id: 'new_task', checksum: mode === 'async-wrong' ? '0'.repeat(32) : hash,
      completed_at: polls > 1 ? '2026-11-14T00:00:00Z' : null,
      status: mode === 'async-failed' ? 'Scan Timeout' : 'Success', app_name: mode === 'async-failed' ? 'Failed' : 'Fixture' }]); return;
  }
  if (req.url === '/api/v1/report_json') { json(mode === 'bad-report' ? { md5: hash } : report()); return; }
  json({ error: 'unknown' }, 404);
});
before(async () => {
  process.env.QA_MOBSF_FIXTURE_KEY = key;
  fs.writeFileSync(path.join(dir, 'app.apk'), binary); fs.writeFileSync(path.join(dir, 'app.ipa'), binary);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { config } = await loadConfig('test/fixture.config.ts', {});
  base = { config, configDir: dir, outDir: dir, suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
});
after(async () => {
  if (previousKey === undefined) delete process.env.QA_MOBSF_FIXTURE_KEY; else process.env.QA_MOBSF_FIXTURE_KEY = previousKey;
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});
async function run(nextMode: string, execution: Record<string, unknown> = {}) {
  mode = nextMode; calls = []; uploads = []; scans = []; polls = 0;
  return (await runPlugins([mobileStatic], { ...base, config: { ...base.config, pluginSettings: { 'mobile-static': {
    execution: { serverUrl: url, binary: 'app.apk', apiKeyEnv: 'QA_MOBSF_FIXTURE_KEY', pollIntervalMs: 100, timeoutMs: 2000, ...execution },
  } } } }))[0];
}

test('MobSF sync upload/rescan/report preserves binary identity and code findings', async () => {
  const healthy = await run('healthy'); assert.equal(healthy.status, 'passed', healthy.reason);
  assert.deepEqual(calls, ['/api/v1/upload', '/api/v1/scan', '/api/v1/report_json']);
  assert.deepEqual(uploads[0], binary); assert.equal(scans[0].get('re_scan'), '1'); assert.equal(scans[0].get('hash'), hash);
  const bad = await run('finding'); assert.equal(bad.status, 'failed');
  assert.equal(bad.findings.length, 1); assert.ok(!JSON.stringify(bad).includes('private-source-secret'));
  const echoed = await run('echo-key'); assert.ok(!JSON.stringify(echoed).includes(key));
});
test('MobSF async polls only the returned task and rejects failure, stale or mismatched identity', async () => {
  assert.equal((await run('async')).status, 'passed'); assert.equal(polls, 2);
  for (const value of ['async-wrong', 'async-failed', 'cached', 'wrong-upload', 'wrong-scan', 'wrong-report', 'wrong-sha', 'scan-error', 'bad-report']) {
    const result = await run(value); assert.equal(result.status, 'errored', value); assert.ok(!JSON.stringify(result).includes(key));
    if (['async-wrong', 'async-failed', 'cached', 'wrong-upload', 'wrong-scan', 'scan-error'].includes(value)) assert.ok(!calls.includes('/api/v1/report_json'));
  }
});
test('MobSF IPA requires binary-analysis coverage and reports binary defects', async () => {
  assert.equal((await run('healthy', { binary: 'app.ipa' })).status, 'errored');
  const result = await run('ios', { binary: 'app.ipa' }); assert.equal(result.status, 'failed');
  assert.ok(result.findings.some(f => f.target === 'binary:insecure'));
});
test('MobSF redirects, oversized/malformed errors and timeout never leak or retry uploads', async () => {
  for (const value of ['redirect', 'http-error', 'malformed', 'oversized', 'timeout']) {
    const result = await run(value, { timeoutMs: 1000 }); assert.equal(result.status, 'errored', value);
    assert.deepEqual(calls, ['/api/v1/upload']); assert.ok(!JSON.stringify(result).includes(key));
  }
});
test('MobSF unsafe endpoints and invalid binaries are rejected before any upload', async () => {
  fs.writeFileSync(path.join(dir, 'invalid.apk'), 'not-a-zip');
  fs.writeFileSync(path.join(dir, 'large.apk'), Buffer.alloc(2 * 1024 * 1024));
  for (const execution of [{ serverUrl: 'http://remote.invalid' }, { serverUrl: 'https://remote.invalid' },
    { serverUrl: url + '?token=secret' }, { serverUrl: url.replace('http://', 'http://user:password@') },
    { binary: 'invalid.apk' }, { binary: 'large.apk', maxBinaryMiB: 1 }, { apiKeyEnv: 'VERIQ_MISSING_TEST_KEY' }]) {
    assert.equal((await run('healthy', execution)).status, 'errored'); assert.equal(calls.length, 0);
  }
});
test('actual configured MobSF scans a supplied local APK/IPA', { skip: process.env.QA_TEST_MOBSF !== '1' }, async () => {
  assert.ok(process.env.QA_MOBSF_URL && process.env.QA_MOBSF_BINARY, 'Set QA_MOBSF_URL and QA_MOBSF_BINARY');
  const result = await run('healthy', { serverUrl: process.env.QA_MOBSF_URL, binary: process.env.QA_MOBSF_BINARY, apiKeyEnv: 'MOBSF_API_KEY', timeoutMs: 300000 });
  assert.ok(['passed', 'failed'].includes(result.status), result.reason);
});
