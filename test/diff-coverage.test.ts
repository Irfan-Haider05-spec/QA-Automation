import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { runPlugins } from '../src/core/runner.js';
import { diffCoveragePlugin, globToRegExp, lineRanges, parseLcov, parseUnifiedDiff } from '../src/plugins/expanded/diff-coverage.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-diffcov-'));
const repo = path.join(root, 'repo');
let base: RunContext;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=qa@example.test', '-c', 'user.name=QA', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
const write = (file: string, lines: string[]) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), lines.join('\n') + '\n'); };
const code = (n: number, tag = 'v') => Array.from({ length: n }, (_, i) => `export const ${tag}${i + 1} = ${i + 1};`);

before(async () => {
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  write('src/a.ts', code(10));
  write('src/c.ts', ['export const c1 = 1;', '// old comment', 'export const c3 = 3;']);
  write('src/old.ts', code(4, 'o'));
  write('src/types.d.ts', ['export interface T { a: number }']);
  write('test/a.test.ts', ['test("a", () => {});']);
  git('add', '.'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  const a = code(10); a[2] = 'export const v3 = 300;'; a[3] = 'export const v4 = 400;';
  write('src/a.ts', [...a, ...code(4, 'w')]);                       // changed: 3, 4, 11-14
  write('src/b.ts', code(5, 'b'));                                   // new: 1-5
  write('src/c.ts', ['export const c1 = 1;', '// new comment', 'export const c3 = 3;']); // comment only: 2
  git('mv', 'src/old.ts', 'src/renamed.ts');
  const r = code(4, 'o'); r[1] = 'export const o2 = 20;'; write('src/renamed.ts', r); // renamed, changed: 2
  write('src/types.d.ts', ['export interface T { a: number; b: string }']);
  write('test/a.test.ts', ['test("a", () => { expect(1).toBe(1); });']);
  git('add', '.'); git('commit', '-q', '-m', 'feature');
  const { config } = await loadConfig('test/fixture.config.ts', {});
  base = { config, configDir: repo, outDir: path.join(root, 'out'), suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

type Hits = Record<string, Record<number, number>>;
function lcov(files: Hits, name = 'lcov.info', absolute = false) {
  const body = Object.entries(files).map(([file, lines]) =>
    `TN:\nSF:${absolute ? path.join(repo, file) : file}\n${Object.entries(lines).map(([n, h]) => `DA:${n},${h}`).join('\n')}\nend_of_record`).join('\n');
  fs.writeFileSync(path.join(repo, name), body + '\n');
  return name;
}
const all = (n: number, hit = 1) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, hit]));
const healthy = (): Hits => ({ 'src/a.ts': all(14), 'src/b.ts': all(5), 'src/c.ts': { 1: 1, 3: 1 }, 'src/renamed.ts': all(4) });
async function check(settings: Record<string, unknown>) {
  const config = { ...structuredClone(base.config), pluginSettings: { 'diff-coverage': { base: 'main', ...settings } } };
  return (await runPlugins([diffCoveragePlugin], { ...base, config }))[0];
}

test('Fully covered changes pass; tests, types and comment-only lines are not counted', async () => {
  const result = await check({ lcov: lcov(healthy()) });
  assert.equal(result.status, 'passed', result.reason);
  assert.equal(result.stats?.executableChangedLines, 12, 'a.ts 6 + b.ts 5 + renamed.ts 1; c.ts comment and excluded files do not count');
  assert.equal(result.stats?.coveredChangedLines, 12);
  assert.equal(result.stats?.consideredFiles, 4);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'out', 'diff-coverage.json'), 'utf8'));
  assert.equal(report.percent, 100);
  assert.deepEqual(report.files.map((f: { file: string }) => f.file), ['src/a.ts', 'src/b.ts', 'src/renamed.ts']);
  // An absolute SF path maps to the same file.
  assert.equal((await check({ lcov: lcov(healthy(), 'abs.info', true) })).status, 'passed');
});

test('Under-tested changes fail with the uncovered changed lines per file, worst first', async () => {
  const hits = healthy();
  for (const n of [11, 12, 13, 14]) hits['src/a.ts'][n] = 0;
  hits['src/b.ts'][5] = 0;
  hits['src/a.ts'][1] = 0; // an unchanged uncovered line must not count
  const result = await check({ lcov: lcov(hits) });
  assert.equal(result.status, 'failed');
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.equal(f.title, 'Changed lines are under-tested');
  assert.equal(f.severity, 'high');
  assert.match(f.detail!, /^7 of 12 changed executable lines ran in tests \(58\.33%; minimum 80%\)/);
  assert.ok(f.detail!.indexOf('src/a.ts (2/6): 11-14') < f.detail!.indexOf('src/b.ts (4/5): 5'), f.detail);
  assert.match(f.remediation!, /Add tests/);
  assert.equal((await check({ lcov: lcov(hits), minPercent: 50 })).status, 'passed', 'the threshold is configurable');
});

test('Changed files missing from the report are reported, never silently skipped', async () => {
  const hits = healthy(); delete hits['src/b.ts'];
  const strict = await check({ lcov: lcov(hits) });
  assert.equal(strict.status, 'failed');
  assert.deepEqual(strict.findings.map(f => [f.title, f.severity]), [['Changed source files are missing from the coverage report', 'high']]);
  assert.match(strict.findings[0].detail!, /src\/b\.ts/);
  const lenient = await check({ lcov: lcov(hits), missingFiles: 'report' });
  assert.equal(lenient.findings[0].severity, 'low');
  assert.equal((await check({ lcov: lcov(hits), exclude: ['src/b.ts'] })).status, 'passed', 'an explicit exclude removes it');
  assert.equal((await check({ lcov: lcov(healthy()), include: ['src/b.ts'] })).stats?.executableChangedLines, 5, 'include narrows the scope');
  // Turning the defaults off brings test and type files back into scope.
  const noDefaults = await check({ lcov: lcov(healthy()), defaultExcludes: false });
  assert.match(noDefaults.findings[0]?.detail ?? '', /test\/a\.test\.ts/);
});

test('Stale, empty, malformed or foreign reports error instead of passing', async () => {
  const stale = lcov(healthy(), 'stale.info');
  const old = new Date(Date.now() - 3600_000); fs.utimesSync(path.join(repo, stale), old, old);
  const s = await check({ lcov: stale });
  assert.equal(s.status, 'errored'); assert.match(s.reason ?? '', /older than the head commit/);

  fs.writeFileSync(path.join(repo, 'empty.info'), '');
  assert.match((await check({ lcov: 'empty.info' })).reason ?? '', /no line data/);
  fs.writeFileSync(path.join(repo, 'foreign.info'), 'SF:/elsewhere/x.ts\nDA:1,1\nend_of_record\n');
  assert.match((await check({ lcov: 'foreign.info' })).reason ?? '', /no line data/, 'files outside the repository are ignored');
  fs.writeFileSync(path.join(repo, 'bad.info'), 'SF:src/a.ts\nDA:x,1\nend_of_record\n');
  assert.match((await check({ lcov: 'bad.info' })).reason ?? '', /LCOV line 2/);
  assert.match((await check({ lcov: 'missing.info' })).reason ?? '', /not found/);

  // A changed file edited after the coverage run was not measured in its current form.
  const fresh = lcov(healthy(), 'fresh.info');
  const later = new Date(Date.now() + 120_000); fs.utimesSync(path.join(repo, 'src/b.ts'), later, later);
  const edited = await check({ lcov: fresh });
  fs.utimesSync(path.join(repo, 'src/b.ts'), new Date(), new Date());
  assert.equal(edited.status, 'errored'); assert.match(edited.reason ?? '', /newer than the LCOV report/);
});

test('Unknown or unsafe refs and settings are refused without running a diff', async () => {
  const report = lcov(healthy());
  const unknown = await check({ lcov: report, base: 'does-not-exist' });
  assert.equal(unknown.status, 'errored'); assert.match(unknown.reason ?? '', /fetch-depth: 0/);
  for (const bad of [{ base: '--output=/tmp/veriq-pwned' }, { head: '-p' }, { base: 'main;rm -rf /' }, { exclude: ['../x'] }, { include: ['/etc/*'] }, { minPercent: 101 }, { extensions: ['ts'] }]) {
    const r = await check({ lcov: report, ...bad });
    assert.equal(r.status, 'errored', JSON.stringify(bad));
  }
  assert.ok(!fs.existsSync('/tmp/veriq-pwned'));
  assert.match((await check({ lcov: report, repoDir: 'nope' })).reason ?? '', /repoDir/);
});

test('A repository config cannot make the check run external diff, textconv or fsmonitor programs', async () => {
  const marks = ['ext', 'textconv', 'fsmonitor'].map(m => path.join(root, `MARK-${m}`));
  git('config', 'diff.external', `sh -c 'touch ${marks[0]}'`);
  git('config', 'diff.evil.textconv', `sh -c 'touch ${marks[1]}; cat'`);
  git('config', 'core.fsmonitor', `sh -c 'touch ${marks[2]}'`);
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.ts diff=evil\n');
  try {
    const result = await check({ lcov: lcov(healthy()) });
    assert.equal(result.status, 'passed', result.reason);
    for (const m of marks) assert.ok(!fs.existsSync(m), `${path.basename(m)} ran`);
  } finally {
    for (const k of ['diff.external', 'diff.evil.textconv', 'core.fsmonitor']) git('config', '--unset', k);
    fs.rmSync(path.join(repo, '.git', 'info', 'attributes'));
  }
});

test('Parsers and helpers', () => {
  const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -3,2 +3,2 @@', '-a', '-b', '+A', '+B', '@@ -10,0 +11,3 @@', '+c', '+d', '+e', '@@ -20 +23 @@', '-z', '+Z',
    'diff --git a/gone.ts b/gone.ts', '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y',
    'diff --git "a/sp ace\\tx.ts" "b/sp ace\\tx.ts"', '+++ "b/sp ace\\tx.ts"', '@@ -0,0 +1 @@', '+n',
    '+++ b/only-deletes.ts', '@@ -4,2 +3,0 @@'].join('\n');
  const parsed = parseUnifiedDiff(diff);
  assert.deepEqual([...parsed.get('x.ts')!], [3, 4, 11, 12, 13, 23]);
  assert.ok(!parsed.has('gone.ts') && !parsed.has('only-deletes.ts'));
  assert.deepEqual([...parsed.get('sp ace\tx.ts')!], [1]);
  assert.equal(lineRanges([1, 2, 3, 5, 7, 8]), '1-3, 5, 7-8');
  assert.equal(lineRanges([]), '');
  assert.ok(globToRegExp('**/*.test.*').test('src/deep/a.test.ts') && globToRegExp('**/*.test.*').test('a.test.ts'));
  assert.ok(globToRegExp('test/**').test('test/x/y.ts') && !globToRegExp('test/**').test('src/test/y.ts'));
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts') && !globToRegExp('src/*.ts').test('src/x/a.ts'));
  assert.ok(!globToRegExp('a.b').test('axb'), 'dots are literal');
  const files = parseLcov('SF:src/a.ts\nDA:1,0\nDA:1,3\nDA:2,0,checksum\nend_of_record\nSF:../out.ts\nDA:1,1\nend_of_record\n', '/repo');
  assert.deepEqual([...files.get('src/a.ts')!], [[1, 3], [2, 0]]);
  assert.ok(!files.has('../out.ts'));
});
