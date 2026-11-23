import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { targetNeeded } from '../src/core/runner.js';
import type { QaPlugin } from '../src/core/types.js';
import { PLUGINS } from '../src/plugins/index.js';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-target-'));
let base: RunContext;
const get = (name: string) => PLUGINS.find((p) => p.name === name)!;

before(async () => {
  const { config } = await loadConfig('test/fixture.config.ts', {});
  base = { config, configDir: path.resolve('test'), outDir: out, suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, openapiPath: path.join(out, 'openapi.json'), log: { info() {}, warn() {}, debug() {} } };
});
after(() => fs.rmSync(out, { recursive: true, force: true }));

const ctxWith = (settings: Record<string, unknown>) => ({ ...base, config: { ...structuredClone(base.config), pluginSettings: settings } });

test('Only checks that will run and talk to the API make the target health check necessary', () => {
  const c = ctxWith({
    'code-quality': { typescript: {} }, 'tls-dns-mail': { host: 'example.com' }, 'post-deploy-errors': { release: 'v1' },
    'load-stress': { report: 'k6.json' }, 'log-hygiene': {},
  });
  for (const name of ['code-quality', 'tls-dns-mail', 'post-deploy-errors', 'load-stress', 'log-hygiene', 'secrets', 'route-auth'])
    assert.equal(targetNeeded([get(name)], c), false, name);
  for (const name of ['health-cors', 'api-smoke', 'tenant-isolation', 'api-fuzz', 'web-crawl', 'zap-baseline'])
    assert.equal(targetNeeded([get(name)], c), true, name);
  assert.equal(targetNeeded([get('authz-matrix')], c), false, 'a check that is not configured will be skipped, so it does not count');
  assert.equal(targetNeeded([get('code-quality'), get('health-cors')], c), true, 'one live check is enough');

  const live = ctxWith({ 'log-hygiene': { canary: { path: '/login', json: { password: '{{canary}}' }, logs: 'a.log' } }, 'load-stress': { execution: { path: '/health', iterations: 1 } } });
  assert.equal(targetNeeded([get('log-hygiene')], live), true, 'the canary sends a request');
  assert.equal(targetNeeded([get('load-stress')], live), true, 'k6 execution hits the target');

  const broken: QaPlugin = { name: 'broken', layer: 'static', description: 'x', skipReason() { throw new Error('bad settings'); }, async run() { return []; } };
  assert.equal(targetNeeded([broken], c), true, 'when a skip decision cannot be made, the target is checked as before');
});

function cli(only: string) {
  // 127.0.0.1:1 refuses connections: the target is down.
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'run', '-c', 'test/fixture.config.ts', '--only', only, '--out', path.join(out, only)],
    { env: { ...process.env, QA_BASE_URL: 'http://127.0.0.1:1' }, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, text: `${r.stdout}${r.stderr}` };
}

test('CLI exit codes with the target down: static-only runs are judged on their findings, live runs report the environment', () => {
  const statics = cli('env-drift,route-auth');
  assert.notEqual(statics.code, 3, statics.text);
  assert.match(statics.text, /No selected check uses the target API; its health check is skipped/);
  assert.doesNotMatch(statics.text, /Target unhealthy/);

  const liveRun = cli('health-cors');
  assert.equal(liveRun.code, 3, liveRun.text);
  assert.match(liveRun.text, /Target unhealthy, live plugins skipped/);
});
