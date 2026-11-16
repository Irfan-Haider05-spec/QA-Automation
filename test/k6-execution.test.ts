import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/core/config.js";
import type { RunContext } from "../src/core/context.js";
import { runPlugins } from "../src/core/runner.js";
import { loadStress } from "../src/plugins/expanded/operations-checks.js";
import { runBoundedProcess } from "../src/core/bounded-process.js";
import { AuthProvider } from "../src/core/auth.js";
import { HttpClient } from "../src/core/http.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veriq-k6-"));
let base: RunContext, url = "", hits = 0, redirected = 0;
const server = http.createServer((req, res) => {
  hits++;
  if (req.url === '/redirect') { res.writeHead(302, { location: url + '/redirected' }); res.end(); return; }
  if (req.url === '/redirected') redirected++;
  if (req.url === '/auth' && req.headers.authorization !== 'Bearer fixture-private-token') { res.writeHead(401); res.end(); return; }
  res.writeHead(req.url === '/broken' ? 500 : 200); res.end('fixture');
});
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { config } = await loadConfig('test/fixture.config.ts', {});
  config.target.baseUrl = url; config.target.requestsPerMinute = 600;
  config.allowMutations = true; config.disposable = true;
  base = { config, configDir: dir, outDir: dir, suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
});
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); });
const settings = (execution: Record<string, unknown> = {}) => ({ minRequests: 3, maxP95Ms: 5000, maxErrorRate: 0, execution: { path: '/healthy', iterations: 3, requestsPerSecond: 10, maxDurationSeconds: 5, ...execution } });
async function run(value: unknown, ctx = base) {
  return (await runPlugins([loadStress], { ...ctx, config: { ...ctx.config, pluginSettings: { 'load-stress': value } } }))[0];
}
function fake(name: string, body: string) {
  const file = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(file, '#!/usr/bin/env node\n' + body); fs.chmodSync(file, 0o700); return file;
}
const summary = (count = 3, ok = true) => ({ metrics: { iterations: { values: { count } }, http_reqs: { values: { count } }, http_req_duration: { values: { 'p(95)': 1 }, thresholds: { 'p(95)<=5000': { ok } } }, http_req_failed: { values: { rate: 0 } } } });

test('k6 preflight blocks unsafe configuration without launching a process', async () => {
  const marker = path.join(dir, 'launched');
  const executable = fake('marker', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  for (const overrides of [{ path: '//foreign.invalid' }, { path: '/x?token=secret' }, { requestsPerSecond: 11 }, { iterations: 60 }, { vus: 21 }]) {
    assert.equal((await run(settings({ executable, ...overrides }))).status, 'errored');
  }
  const inactive = { ...base, config: { ...base.config, disposable: false } };
  assert.equal((await run(settings({ executable }), inactive)).status, 'errored');
  assert.equal(fs.existsSync(marker), false);
});

test('fresh summary, environment isolation and contradictory/partial results fail closed', async () => {
  const previous = process.env.K6_INSECURE_SKIP_TLS_VERIFY;
  process.env.K6_INSECURE_SKIP_TLS_VERIFY = 'true';
  try {
    const good = fake('good', `import fs from 'node:fs'; if(process.env.K6_INSECURE_SKIP_TLS_VERIFY) process.exit(42); fs.writeFileSync(process.env.VERIQ_K6_REPORT, JSON.stringify(${JSON.stringify(summary())}));`);
    assert.equal((await run(settings({ executable: good }))).status, 'passed');
    for (const [name, data, code] of [['partial', summary(2), 0], ['false-green', summary(), 99], ['bad-exit', summary(), 42], ['false-exit', summary(3, false), 0]] as const) {
      const executable = fake(name, `import fs from 'node:fs'; fs.writeFileSync(process.env.VERIQ_K6_REPORT,JSON.stringify(${JSON.stringify(data)})); process.exitCode=${code};`);
      assert.equal((await run(settings({ executable }))).status, 'errored', name);
    }
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary()));
    assert.equal((await run(settings({ executable: fake('missing', '') }))).status, 'errored');
  } finally { if (previous === undefined) delete process.env.K6_INSECURE_SKIP_TLS_VERIFY; else process.env.K6_INSECURE_SKIP_TLS_VERIFY = previous; }
});

test('bounded process times out and removes signal handlers', async () => {
  const before = process.listenerCount('SIGINT');
  await assert.rejects(runBoundedProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: dir, timeoutMs: 200 }), /timeout/);
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('actual k6: healthy/failed targets, redirect refusal and environment-only authentication', { skip: process.env.QA_TEST_K6 !== '1' }, async () => {
  hits = 0;
  const healthy = await run(settings());
  assert.equal(healthy.status, 'passed', healthy.reason);
  assert.equal(healthy.stats?.requests, 3); assert.equal(hits, 3);
  const failed = await run(settings({ path: '/broken' }));
  assert.equal(failed.status, 'failed', failed.reason);
  assert.ok(failed.findings.some(f => f.title.includes('threshold failed')));
  assert.equal((await run(settings({ path: '/redirect' }))).status, 'failed');
  assert.equal(redirected, 0);
  const config = { ...base.config, accounts: { qa: { role: 'USER', device: 'web', accessToken: 'fixture-private-token' } } };
  const authed = { ...base, config, auth: new AuthProvider(config, new HttpClient(url, 600, 1000)) };
  assert.equal((await run(settings({ path: '/auth', account: 'qa' }), authed)).status, 'passed');
  for (const name of fs.readdirSync(dir).filter(n => n.startsWith('k6-'))) for (const file of fs.readdirSync(path.join(dir, name))) {
    assert.ok(!fs.readFileSync(path.join(dir, name, file), 'utf8').includes('fixture-private-token'), file);
  }
});
