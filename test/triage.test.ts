/**
 * Findings must never disappear between a plugin and the report. Found during real-project
 * acceptance on the MLITech backend: 14 of 33 missing-index findings and 10 of 20 Semgrep
 * matches were silently dropped because they shared a fingerprint with another finding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import type { Finding, PluginResult } from '../src/core/types.js';
import { fingerprintOf, gate, triage } from '../src/core/triage.js';
import { uploadResults } from '../src/core/upload.js';
import type { RunSummary } from '../src/core/report.js';
import { FindingUploadSchema, PluginResultUploadSchema } from '../packages/shared/src/index.js';
import { EXPANDED_PLUGINS } from '../src/plugins/expanded/index.js';
import { sarifPaths } from '../src/plugins/expanded/scanner-adapters.js';

const f = (over: Partial<Finding>): Finding => ({ plugin: 'demo', severity: 'medium', title: 'Query has no supporting index', target: 'User', category: 'quality', ...over });
const result = (findings: Finding[]): PluginResult => ({ plugin: 'demo', status: 'failed', durationMs: 1, findings });

test('Fingerprints without a key are unchanged, so existing baselines and platform issues keep matching', () => {
  const legacy = crypto.createHash('sha1').update(['demo', 'query has no supporting index', 'user'].join('|')).digest('hex').slice(0, 12);
  assert.equal(fingerprintOf(f({})), legacy);
  assert.equal(fingerprintOf(f({ target: 'User 42' })), fingerprintOf(f({ target: 'User 7' })), 'volatile numbers are still ignored in targets');
  assert.notEqual(fingerprintOf(f({ key: 'a.ts|10:1' })), fingerprintOf(f({ key: 'a.ts|20:1' })), 'a key is used verbatim, numbers included');
  assert.equal(fingerprintOf(f({ key: 'k' })), fingerprintOf(f({ key: 'k', detail: 'different wording' })), 'detail never enters the fingerprint');
});

test('Exact repeats are dropped; different problems sharing a fingerprint are merged visibly without weakening the gate', () => {
  const [r] = triage([result([
    f({ detail: 'User.find filters on { role }' }),
    f({ detail: 'User.find filters on { role }' }),                                // exact repeat
    f({ detail: 'User.find filters on { fcmToken }\nsrc/a.ts:1', severity: 'critical' }),
    f({ title: 'Other', detail: 'separate finding' }),
  ])], []);
  assert.equal(r.findings.length, 2);
  const merged = r.findings[0];
  assert.equal(merged.severity, 'critical', 'the kept finding takes the worst severity of what was merged');
  assert.match(merged.detail!, /1 more finding\(s\) with the same title and target were merged here:\n- User\.find filters on \{ fcmToken \}$/);
  assert.equal(gate([r], 'high').blocking.length, 1);

  const [flaky] = triage([result([f({ flaky: true, detail: 'a' }), f({ detail: 'b' })])], []);
  assert.equal(flaky.findings[0].flaky, undefined, 'a confirmed occurrence keeps the merged finding blocking');
  assert.equal(gate([flaky], 'medium').blocking.length, 1);

  const many = triage([result(Array.from({ length: 25 }, (_, i) => f({ detail: `shape ${'x'.repeat(i)}` })))], [])[0];
  assert.equal(many.findings.length, 1);
  assert.match(many.findings[0].detail!, /24 more finding\(s\)[\s\S]*…and 4 more$/);
});

test('Uploads fit the platform limits and keep engine-only fields out', () => {
  const long = 'x'.repeat(30_000);
  const summary = { results: [{ plugin: 'demo', status: 'failed', durationMs: 1, reason: long, findings: [{ ...f({ key: 'k', detail: long, title: long, target: long, remediation: long }), fingerprint: 'abcdef123456' }] }] } as unknown as RunSummary;
  const [r] = uploadResults(summary);
  PluginResultUploadSchema.parse(r);
  const finding = r.findings[0];
  FindingUploadSchema.parse(finding);
  assert.equal('key' in finding, false);
  assert.equal(finding.detail!.length, 5000);
  assert.match(finding.detail!, /…\[shortened; full text in report\.json\]$/);
  assert.equal(r.reason!.length, 2000);
  const short = uploadResults({ results: [{ plugin: 'demo', status: 'passed', durationMs: 1, findings: [{ ...f({ detail: 'short' }), fingerprint: 'abcdef123456' }] }] } as unknown as RunSummary);
  assert.equal(short[0].findings[0].detail, 'short', 'text within the limits is untouched');
});

test('SARIF locations are matched to changed files whatever form the scanner wrote', () => {
  const backend = path.resolve('/work/backend'), config = path.resolve('/work/qa');
  const abs = path.join(backend, 'src', 'a b.ts');
  assert.deepEqual(sarifPaths(abs, backend, config), ['src/a b.ts']);
  assert.deepEqual(sarifPaths(`file://${abs.split(path.sep).join('/').replace(/^([A-Za-z]):/, '/$1:').replace(/ /g, '%20')}`, backend, config), ['src/a b.ts']);
  assert.deepEqual(sarifPaths('../backend/src/a.ts', backend, config), ['src/a.ts'], 'relative to the configuration folder, where VeriQ runs the scanner');
  assert.deepEqual(sarifPaths('src/a.ts', backend, config), ['src/a.ts'], 'relative to the scanned backend');
  assert.deepEqual(sarifPaths(path.resolve('/elsewhere/x.ts'), backend, config), [], 'outside the backend: never a changed backend file');
  assert.deepEqual(sarifPaths('https://example.com/x', backend, config), ['https://example.com/x']);
});

test('Scanner matches: two hits of one rule in one file stay two findings, and changed-file runs keep absolute paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-sarif-'));
  try {
    const backend = path.join(dir, 'backend'); fs.mkdirSync(path.join(backend, 'src'), { recursive: true });
    const loc = (file: string, line: number) => ({ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: line, startColumn: 3 } } });
    const hit = (file: string, line: number, extra = {}) => ({ ruleId: 'path-join', level: 'warning', message: { text: 'join' }, locations: [loc(file, line)], ...extra });
    fs.writeFileSync(path.join(dir, 'scan.sarif'), JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'Semgrep' } }, results: [
      hit(path.join(backend, 'src', 'upload.ts'), 139, { fingerprints: { 'matchBasedId/v1': 'requires login' } }),
      hit(path.join(backend, 'src', 'upload.ts'), 143),
      hit(path.join(backend, 'src', 'other.ts'), 8),
    ] }] }));
    const { config } = await loadConfig('test/fixture.config.ts', {});
    config.backend.dir = backend;
    config.pluginSettings = { sast: { report: 'scan.sarif' } };
    const ctx = { config, configDir: dir, outDir: dir, suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, openapiPath: '', log: { info() {}, warn() {}, debug() {} } } as unknown as RunContext;
    const sast = EXPANDED_PLUGINS.find((p) => p.name === 'sast')!;
    const all = await sast.run(ctx);
    const findings = (Array.isArray(all) ? all : all.findings) as Finding[];
    assert.deepEqual(findings.map((x) => x.target), ['src/upload.ts:139', 'src/upload.ts:143', 'src/other.ts:8'], 'shown relative to the backend, not as a local machine path');
    const [triaged] = triage([{ plugin: 'sast', status: 'failed', durationMs: 1, findings }], []);
    assert.equal(triaged.findings.length, 3);

    const changed = await sast.run({ ...ctx, changedFiles: ['src/upload.ts'] });
    assert.deepEqual(((Array.isArray(changed) ? changed : changed.findings) as Finding[]).map((x) => x.target), ['src/upload.ts:139', 'src/upload.ts:143'],
      'before the fix an absolute SARIF path never equalled a changed file, so PR runs silently reported nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('One operation broken twice and parameterised tests failing twice stay separate findings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-keys-'));
  try {
    const op = (params: object[]) => ({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: { '/items': { get: { parameters: params, responses: { 200: { description: 'ok' } } } } } });
    fs.writeFileSync(path.join(dir, 'base.json'), JSON.stringify(op([])));
    fs.writeFileSync(path.join(dir, 'head.json'), JSON.stringify(op([{ in: 'query', name: 'page1', required: true, schema: { type: 'string' } }, { in: 'query', name: 'page2', required: true, schema: { type: 'string' } }])));
    fs.writeFileSync(path.join(dir, 'junit.xml'), '<testsuite><testcase name="pays order 1"><failure/></testcase><testcase name="pays order 2"><failure/></testcase></testsuite>');
    const { config } = await loadConfig('test/fixture.config.ts', {});
    config.pluginSettings = { 'api-contract': { baseline: 'base.json', current: 'head.json' }, 'test-results': { junit: 'junit.xml' } };
    const ctx = { config, configDir: dir, outDir: dir, suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, openapiPath: '', log: { info() {}, warn() {}, debug() {} } } as unknown as RunContext;
    for (const name of ['api-contract', 'test-results']) {
      const out = await EXPANDED_PLUGINS.find((p) => p.name === name)!.run(ctx);
      const findings = (Array.isArray(out) ? out : out.findings) as Finding[];
      assert.equal(findings.length, 2, name);
      assert.equal(triage([{ plugin: name, status: 'failed', durationMs: 1, findings }], [])[0].findings.length, 2, `${name}: digits that differ are not merged`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
