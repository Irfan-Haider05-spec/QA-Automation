import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { runPlugins } from '../src/core/runner.js';
import { codeQualityPlugin, codeQualitySchema, diagnosticKey, newDiagnostics, parseDartMachine, parseEslint, parseTsc } from '../src/plugins/expanded/code-quality.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-quality-'));
const repo = path.join(root, 'repo');
const out = path.join(root, 'out');
let base: RunContext;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=qa@example.test', '-c', 'user.name=QA', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });

// A fake ESLint package whose output is chosen by eslint-mode.txt, so exit codes 0/1/2 and bad output are all exercised.
const FAKE_ESLINT = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const mode = fs.readFileSync(path.join(process.cwd(), 'eslint-mode.txt'), 'utf8').trim();
const args = process.argv.slice(2);
if (!args.includes('--format') || args[args.indexOf('--format') + 1] !== 'json') { console.error('expected json'); process.exit(2); }
const f = path.join(process.cwd(), 'src/a.ts');
if (mode === 'clean') { console.log(JSON.stringify([{ filePath: f, messages: [] }])); process.exit(0); }
if (mode === 'problems') {
  console.log(JSON.stringify([{ filePath: f, messages: [
    { ruleId: 'no-unused-vars', severity: 2, message: "'x' is assigned a value but never used.", line: 4 },
    { ruleId: 'prefer-const', severity: 1, message: "'y' is never reassigned.", line: 5 },
    { ruleId: null, severity: 2, fatal: true, message: 'Parsing error: Unexpected token', line: 9 } ] }]));
  process.exit(1);
}
if (mode === 'crash') { console.error('Oops! Something went wrong!'); process.exit(2); }
if (mode === 'garbage') { console.log('not json'); process.exit(1); }
`;

const GOOD = `export const n: number = 1;\n`;
const ONE_ERROR = `export const n: number = 1;\nexport const s: number = "text";\n`;

before(async () => {
  fs.mkdirSync(repo, { recursive: true });
  write('package.json', JSON.stringify({ name: 'demo', private: true }));
  write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', skipLibCheck: true, types: [] }, include: ['src'] }));
  write('src/a.ts', ONE_ERROR);
  // The project's own TypeScript: link the real package, as npm install would provide it.
  const tsDir = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.symlinkSync(tsDir, path.join(repo, 'node_modules', 'typescript'), 'junction');
  write('node_modules/eslint/package.json', JSON.stringify({ name: 'eslint', version: '9.0.0-fake', bin: { eslint: './bin/eslint.js' } }));
  write('node_modules/eslint/bin/eslint.js', FAKE_ESLINT);
  write('eslint-mode.txt', 'clean');
  const { config } = await loadConfig('test/fixture.config.ts', {});
  base = { config, configDir: repo, outDir: out, suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function check(settings: Record<string, unknown>, extra: Partial<RunContext> = {}) {
  const config = { ...structuredClone(base.config), pluginSettings: { 'code-quality': settings } };
  return (await runPlugins([codeQualityPlugin], { ...base, ...extra, config }))[0];
}
const baselineFile = (name = '.veriq/code-quality-baseline.json') => path.join(repo, name);

test('Real tsc: no baseline errors with instructions; --baseline accepts the current state; then only new errors fail', async () => {
  fs.rmSync(baselineFile(), { force: true });
  write('src/a.ts', ONE_ERROR);
  const ts = { typescript: {} };

  const missing = await check(ts);
  assert.equal(missing.status, 'errored', 'no baseline must never pass silently');
  assert.match(missing.reason ?? '', /No code-quality baseline.*--baseline/);

  const written = await check(ts, { updateBaseline: true });
  assert.equal(written.status, 'passed', written.reason);
  assert.equal(written.stats?.diagnostics, 1);
  const saved = JSON.parse(fs.readFileSync(baselineFile(), 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.values(saved.counts), [1]);
  assert.ok(!JSON.stringify(saved).includes('text'), 'the baseline stores hashes, not source text or messages');

  const same = await check(ts);
  assert.equal(same.status, 'passed', same.reason);
  assert.equal(same.stats?.new, 0);

  // Moving the old error down two lines is not a new problem.
  write('src/a.ts', `// moved\n// down\n${ONE_ERROR}`);
  const moved = await check(ts);
  assert.equal(moved.status, 'passed', moved.reason);

  // A genuinely new error fails, and only the new one is listed.
  write('src/a.ts', `${ONE_ERROR}export const b: boolean = 3;\n`);
  const added = await check(ts);
  assert.equal(added.status, 'failed');
  assert.equal(added.findings.length, 1);
  const f = added.findings[0];
  assert.equal(f.title, 'New TypeScript problems');
  assert.equal(f.severity, 'high');
  assert.equal(f.category, 'quality');
  assert.match(f.detail ?? '', /1 new problem/);
  assert.match(f.detail ?? '', /src\/a\.ts:3 TS2322 Type 'number' is not assignable to type 'boolean'/);
  assert.doesNotMatch(f.detail ?? '', /'string' is not assignable/, 'the baseline error is not repeated as new');
  assert.match(f.remediation ?? '', /--baseline/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'code-quality.json'), 'utf8'));
  assert.equal(report.new, 1);
  assert.equal(report.total, 2);

  // The same error added a second time in the same file is still new (counts, not a set).
  write('src/a.ts', `${ONE_ERROR}export const t: number = "again";\n`);
  const duplicate = await check(ts);
  assert.equal(duplicate.status, 'failed', 'a second copy of a baselined message must count as new');
  assert.equal(duplicate.stats?.new, 1);

  // Fixing the old error passes and is reported as fixed.
  write('src/a.ts', GOOD);
  const fixed = await check(ts);
  assert.equal(fixed.status, 'passed', fixed.reason);
  assert.equal(fixed.stats?.fixedSinceBaseline, 1);

  // failOn "any" needs no baseline and fails on every error.
  write('src/a.ts', ONE_ERROR);
  const any = await check({ typescript: {}, failOn: 'any', baseline: '.veriq/none.json' });
  assert.equal(any.status, 'failed');
  assert.equal(any.findings[0].title, 'TypeScript problems');
});

test('tsc configuration problems and a missing tool are errors, never a pass', async () => {
  const noConfig = await check({ typescript: { tsconfig: 'tsconfig.missing.json' }, failOn: 'any' });
  assert.equal(noConfig.status, 'errored');
  assert.match(noConfig.reason ?? '', /not found/);

  write('tsconfig.bad.json', JSON.stringify({ compilerOptions: { strict: true }, files: ['src/does-not-exist.ts'] }));
  const bad = await check({ typescript: { tsconfig: 'tsconfig.bad.json' }, failOn: 'any' });
  assert.equal(bad.status, 'errored', bad.reason);
  assert.match(bad.reason ?? '', /TypeScript could not check the project \(TS6053\)|TS\d+/);

  const empty = fs.mkdtempSync(path.join(root, 'empty-'));
  fs.writeFileSync(path.join(empty, 'package.json'), '{}');
  fs.writeFileSync(path.join(empty, 'tsconfig.json'), '{}');
  const notInstalled = await check({ repoDir: empty, typescript: {}, failOn: 'any' });
  assert.equal(notInstalled.status, 'errored');
  assert.match(notInstalled.reason ?? '', /typescript is not installed in the project/);
});

test('ESLint run: errors count, warnings only when asked, fatal parse errors count, exit 2 and bad output error', async () => {
  const eslint = { eslint: { paths: ['src'] }, failOn: 'any' };
  write('eslint-mode.txt', 'clean');
  assert.equal((await check(eslint)).status, 'passed');

  write('eslint-mode.txt', 'problems');
  const problems = await check(eslint);
  assert.equal(problems.status, 'failed');
  assert.equal(problems.stats?.diagnostics, 2, 'the warning is ignored by default');
  assert.match(problems.findings[0].detail ?? '', /src\/a\.ts:4 no-unused-vars/);
  assert.match(problems.findings[0].detail ?? '', /src\/a\.ts:9 parse-error Parsing error/);
  assert.doesNotMatch(problems.findings[0].detail ?? '', /prefer-const/);
  const withWarnings = await check({ ...eslint, includeWarnings: true });
  assert.equal(withWarnings.stats?.diagnostics, 3);
  assert.match(withWarnings.findings[0].detail ?? '', /prefer-const/);

  write('eslint-mode.txt', 'crash');
  const crash = await check(eslint);
  assert.equal(crash.status, 'errored');
  assert.match(crash.reason ?? '', /ESLint could not run/);

  write('eslint-mode.txt', 'garbage');
  const garbage = await check(eslint);
  assert.equal(garbage.status, 'errored');
  assert.match(garbage.reason ?? '', /not JSON/);
});

test('Imported reports: ESLint JSON and Dart machine output (escaped pipes), with tools combined against one baseline', async () => {
  write('reports/eslint.json', JSON.stringify([{ filePath: path.join(repo, 'src/b.ts'), messages: [{ ruleId: 'eqeqeq', severity: 2, message: "Expected '===' and instead saw '=='.", line: 7 }] }]));
  write('reports/dart.txt', [
    'INFO|LINT|prefer_const_constructors|/x/lib/a.dart|1|1|1|Use const.',
    `ERROR|COMPILE_TIME_ERROR|undefined_identifier|${path.join(repo, 'lib/main.dart')}|12|3|4|Undefined name 'a\\|b'.`,
    `WARNING|STATIC_WARNING|dead_code|${path.join(repo, 'lib/main.dart')}|20|1|3|Dead code.`,
  ].join('\n'));
  const settings = { eslint: { report: 'reports/eslint.json' }, dart: { output: 'reports/dart.txt' }, baseline: '.veriq/import-baseline.json' };
  await check(settings, { updateBaseline: true });
  assert.equal((await check(settings)).status, 'passed');

  write('reports/dart.txt', [
    `ERROR|COMPILE_TIME_ERROR|undefined_identifier|${path.join(repo, 'lib/main.dart')}|12|3|4|Undefined name 'a\\|b'.`,
    `ERROR|COMPILE_TIME_ERROR|invalid_assignment|${path.join(repo, 'lib/main.dart')}|30|9|2|A value of type 'int' can't be assigned.`,
  ].join('\n'));
  const r = await check(settings);
  assert.equal(r.status, 'failed');
  assert.equal(r.findings.length, 1, 'only Dart has new problems');
  assert.equal(r.findings[0].title, 'New Dart analyzer problems');
  assert.match(r.findings[0].detail ?? '', /lib\/main\.dart:30 invalid_assignment/);
  assert.doesNotMatch(r.findings[0].detail ?? '', /undefined_identifier/);
});

test('A saved report older than the latest commit is rejected as stale', async () => {
  fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
  git('init', '-q', '-b', 'main'); git('add', 'src', 'package.json'); git('commit', '-q', '-m', 'init');
  write('reports/old.txt', 'src/a.ts(2,14): error TS2322: Type \'string\' is not assignable to type \'number\'.\n');
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(repo, 'reports/old.txt'), past, past);
  const stale = await check({ typescript: { output: 'reports/old.txt' }, failOn: 'any' });
  assert.equal(stale.status, 'errored');
  assert.match(stale.reason ?? '', /older than the latest commit/);
  fs.utimesSync(path.join(repo, 'reports/old.txt'), new Date(), new Date());
  const fresh = await check({ typescript: { output: 'reports/old.txt' }, failOn: 'any' });
  assert.equal(fresh.status, 'failed');
  fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
});

test('Listing is bounded and the JSON report is capped', async () => {
  const lines = Array.from({ length: 2100 }, (_, i) => `src/big.ts(${i + 1},1): error TS2304: Cannot find name 'v${i}'.`);
  write('reports/big.txt', lines.join('\n'));
  const r = await check({ typescript: { output: 'reports/big.txt' }, failOn: 'any' });
  assert.equal(r.status, 'failed');
  assert.match(r.findings[0].detail ?? '', /2100 problem\(s\)/);
  assert.match(r.findings[0].detail ?? '', /…and 2070 more \(see code-quality\.json\)/);
  assert.equal((r.findings[0].detail ?? '').split('\n').filter((l) => l.startsWith('src/big.ts')).length, 30);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'code-quality.json'), 'utf8'));
  assert.equal(report.newDiagnostics.length, 2000);
  assert.equal(report.truncated, true);
});

test('Parsers and settings validation', () => {
  assert.deepEqual(parseTsc("src/x.ts(3,5): error TS2322: Bad.\nnoise\n", '/p').map((d) => [d.file, d.line, d.code]), [['src/x.ts', 3, 'TS2322']]);
  assert.throws(() => parseTsc('error TS5058: The specified path does not exist.', '/p'), /TS5058/);
  assert.throws(() => parseEslint('[{"filePath":1}]', '/p'), /unexpected shape/);
  assert.throws(() => parseDartMachine('ERROR|only|three', '/p'), /--format=machine/);
  const d = parseDartMachine(`ERROR|T|code|/p/lib/a.dart|1|1|1|pipe \\| inside`, '/p');
  assert.equal(d[0].message, 'pipe | inside');
  assert.equal(d[0].file, 'lib/a.dart');
  // The key ignores line numbers but not file, rule or message.
  const k = { tool: 'typescript' as const, file: 'a.ts', line: 1, code: 'TS1', message: 'm', severity: 'error' as const };
  assert.equal(diagnosticKey(k), diagnosticKey({ ...k, line: 99 }));
  assert.notEqual(diagnosticKey(k), diagnosticKey({ ...k, file: 'b.ts' }));
  assert.notEqual(diagnosticKey(k), diagnosticKey({ ...k, code: 'TS2' }));
  assert.equal(newDiagnostics([k, k], { [diagnosticKey(k)]: 1 }).added.get(diagnosticKey(k)), 1);

  const bad = (s: unknown) => assert.equal(codeQualitySchema.safeParse(s).success, false, JSON.stringify(s));
  bad({});
  bad({ typescript: { tsconfig: 'a.json', output: 'b.txt' } });
  bad({ eslint: {} });
  bad({ eslint: { paths: ['src'], report: 'r.json' } });
  bad({ typescript: {}, baseline: '../outside.json' });
  bad({ typescript: {}, baseline: '/abs/baseline.json' });
  bad({ eslint: { paths: ['../../etc'] } });
  bad({ typescript: {}, unknown: true });
  assert.equal(codeQualitySchema.safeParse({ typescript: {} }).success, true);
});
