import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { runPlugins } from '../src/core/runner.js';
import { gate } from '../src/core/triage.js';
import { EXPANDED_PLUGINS } from '../src/plugins/expanded/index.js';
import { addRun, analyse, codeFor, flakyTestsPlugin, flakyTestsSchema, type History } from '../src/plugins/expanded/flaky-tests.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-flaky-'));
let repo = '';
let base: RunContext;
let seq = 0;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=qa@example.test', '-c', 'user.name=QA', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };

type O = 'P' | 'F' | 'R' | 'E' | 'S';
/** JUnit with one testcase per entry. R = flakyFailure (passed on rerun), E = flakyError. Each report differs (run counter). */
function junit(outcomes: Record<string, O | O[]>, file = 'reports/junit.xml') {
  const cases = Object.entries(outcomes).flatMap(([name, o]) => (Array.isArray(o) ? o : [o]).map((x) => {
    const [cls, n] = name.includes('#') ? name.split('#') : ['suite', name];
    const body = { P: '', F: '<failure message="boom">password=hunter2 stack</failure>', R: '<flakyFailure message="x">flaky secret</flakyFailure>', E: '<flakyError message="x"/>', S: '<skipped/>' }[x];
    return `<testcase classname="${cls}" name="${n}" time="0.0${seq}">${body}</testcase>`;
  }));
  seq++;
  write(file, `<?xml version="1.0"?><testsuites><testsuite name="s" timestamp="2026-11-18T00:00:${String(seq % 60).padStart(2, '0')}">${cases.join('')}</testsuite></testsuites>`);
}
const commit = (msg = `c${seq}`) => git('commit', '-q', '--allow-empty', '-m', msg);

async function check(settings: Record<string, unknown> = {}) {
  const config = { ...structuredClone(base.config), pluginSettings: { 'flaky-tests': { junit: 'reports/junit.xml', ...settings } } };
  return (await runPlugins([flakyTestsPlugin], { ...base, configDir: repo, config }))[0];
}

before(async () => {
  const { config } = await loadConfig('test/fixture.config.ts', {});
  base = { config, configDir: root, outDir: path.join(root, 'out'), suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
});
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(root, 'repo-'));
  write('src/app.ts', 'export const a = 1;\n');
  git('init', '-q', '-b', 'main'); git('add', 'src'); git('commit', '-q', '-m', 'init');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('Failing and passing on the same clean commit is confirmed flaky; history builds up honestly before that', async () => {
  junit({ 'auth#logs in': 'F', 'auth#logs out': 'P' });
  const first = await check();
  assert.equal(first.status, 'skipped', 'one run cannot show a result change');
  assert.match(first.reason ?? '', /1 of the 5 runs.*this run was recorded/);
  assert.equal(first.stats?.recorded, undefined, 'skipped results carry no stats');

  const again = await check();
  assert.equal(again.status, 'skipped');
  assert.match(again.reason ?? '', /already recorded; rerun the tests/);
  const store = JSON.parse(fs.readFileSync(path.join(repo, '.veriq/test-history.json'), 'utf8'));
  assert.equal(store.runs.length, 1, 'the same report is not counted twice');

  junit({ 'auth#logs in': 'P', 'auth#logs out': 'P' }); // a CI "re-run failed jobs" on the same commit
  const second = await check();
  assert.equal(second.status, 'failed', second.reason);
  assert.equal(second.findings.length, 1);
  const f = second.findings[0];
  assert.equal(f.title, 'Flaky test: failed and passed on the same commit');
  assert.equal(f.target, 'auth logs in');
  assert.equal(f.severity, 'medium');
  assert.equal(f.confidence, 'high');
  assert.match(f.detail ?? '', /1 passed, 1 failed; 1 result change\(s\); both results on commit [0-9a-f]{12}; last failed 1 run\(s\) ago\./);
  assert.equal(gate([second], 'high').blocking.length, 0, 'a flaky test is reported, not blocking, under the default high gate');

  const saved = fs.readFileSync(path.join(repo, '.veriq/test-history.json'), 'utf8');
  assert.doesNotMatch(saved, /hunter2|boom|secret/, 'failure messages and output are never stored');
  const report = JSON.parse(fs.readFileSync(path.join(root, 'out', 'flaky-tests.json'), 'utf8'));
  assert.equal(report.flaky[0].kind, 'same-commit');
  assert.equal(report.recorded, 'added');
});

test('Uncommitted changes to tracked files are not "the same code"', async () => {
  junit({ 'a#t': 'F' }); await check();
  write('src/app.ts', 'export const a = 2;\n'); // the developer changed code between the runs
  junit({ 'a#t': 'P' });
  const r = await check();
  assert.equal(r.status, 'skipped', 'a fail then pass across an edit is not evidence of flakiness');
  const store = JSON.parse(fs.readFileSync(path.join(repo, '.veriq/test-history.json'), 'utf8'));
  assert.deepEqual(store.runs.map((x: { dirty: boolean }) => x.dirty), [false, true]);
});

test('Passing only after a retry is confirmed from a single report (flakyFailure and flakyError)', async () => {
  junit({ 'pay#charges card': 'R', 'pay#refunds': 'E', 'pay#lists': 'P', 'pay#later': 'S' });
  const r = await check();
  assert.equal(r.status, 'failed', r.reason);
  assert.deepEqual(r.findings.map((f) => [f.title, f.target]), [
    ['Flaky test: passed only after a retry', 'pay charges card'],
    ['Flaky test: passed only after a retry', 'pay refunds'],
  ]);
  assert.equal(r.stats?.testsInRun, 4);
  assert.equal(r.stats?.confirmed, 2);

  // test-results shares the parser: flakyError used to be counted as a plain pass.
  const testResults = EXPANDED_PLUGINS.find((p) => p.name === 'test-results')!;
  const config = { ...structuredClone(base.config), pluginSettings: { 'test-results': { junit: 'reports/junit.xml' } } };
  config.backend.none = true;
  const tr = (await runPlugins([testResults], { ...base, configDir: repo, config }))[0];
  assert.equal(tr.stats?.flaky, 2);
  assert.deepEqual(tr.findings.map((f) => f.target).sort(), ['pay charges card', 'pay refunds']);
});

test('Across commits: a result that keeps changing is suspected; a regression that was fixed, or a test that always fails, is not', async () => {
  const pattern: Record<string, O[]> = {
    'cart#total': ['P', 'F', 'P', 'F', 'P', 'P'],     // 4 changes
    'cart#discount': ['P', 'P', 'F', 'F', 'P', 'P'],  // broke, then fixed: 2 changes
    'cart#legacy': ['F', 'F', 'F', 'F', 'F', 'F'],    // always failing: test-results' job
    'cart#tax': ['P', 'P', 'P', 'P', 'P', 'P'],
  };
  let last;
  for (let i = 0; i < 6; i++) {
    commit();
    junit(Object.fromEntries(Object.entries(pattern).map(([k, v]) => [k, v[i]])));
    last = await check();
    if (i < 4) assert.equal(last.status, 'skipped', `run ${i + 1}: not enough history yet`);
  }
  assert.equal(last!.status, 'failed', last!.reason);
  assert.deepEqual(last!.findings.map((f) => [f.title, f.target, f.confidence]), [['Suspected flaky test: result keeps changing', 'cart total', 'medium']]);
  assert.match(last!.findings[0].detail ?? '', /6 recorded run\(s\) \(window 30\): 4 passed, 2 failed; 4 result change\(s\); last failed 2 run\(s\) ago/);
  assert.equal(last!.stats?.runsInHistory, 6);

  // A narrower window only sees the stable tail.
  const narrow = await check({ record: false, window: 2, minRuns: 2 });
  assert.equal(narrow.status, 'passed', narrow.reason);
  // minFlips is configurable: with 2, the fixed regression counts as well.
  const strict = await check({ record: false, minFlips: 2 });
  assert.deepEqual(strict.findings.map((f) => f.target), ['cart total', 'cart discount']);
});

test('Duplicate test names: a constant mix is not flaky, but a changing one is', async () => {
  for (const o of [['P', 'F'], ['P', 'F'], ['F', 'P'], ['P', 'F'], ['F', 'P']] as O[][]) { commit(); junit({ 'param#case': o, 'param#other': 'P' }); await check(); }
  const r = await check({ record: false });
  assert.equal(r.status, 'passed', 'same-named parameterized cases that always differ are not called flaky');
  assert.equal(codeFor([{ name: 'x', outcome: 'passed', retried: false }, { name: 'x', outcome: 'failed', retried: false }]), 'M');
  // Then every entry passes, mixes again, and passes: three changes (M→P→M→P).
  let changed;
  for (const o of [['P', 'P'], ['F', 'P'], ['P', 'P']] as O[][]) { commit(); junit({ 'param#case': o, 'param#other': 'P' }); changed = await check(); }
  assert.equal(changed!.status, 'failed', changed!.reason);
  assert.equal(changed!.findings[0].target, 'param case');
  assert.match(changed!.findings[0].detail ?? '', /3 result change\(s\)/);
  assert.equal(changed!.stats?.duplicateNames, 1, 'the current report has one name used by two test cases');
});

test('maxFlakyTests turns the count into a blocking finding; long lists are capped', async () => {
  junit(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`many#t${String(i).padStart(2, '0')}`, 'R' as O])));
  const r = await check({ maxFlakyTests: 5 });
  assert.equal(r.status, 'failed');
  assert.equal(r.findings.filter((f) => f.title === 'Flaky test: passed only after a retry').length, 50);
  assert.ok(r.findings.some((f) => f.title === 'More flaky tests than listed' && /10 more/.test(f.detail ?? '')));
  const limit = r.findings.find((f) => f.title === 'Flaky tests exceed the allowed number')!;
  assert.equal(limit.severity, 'high');
  assert.match(limit.detail ?? '', /60 flaky test\(s\) \(60 confirmed, 0 suspected\); the limit is 5/);
  assert.equal(gate([r], 'high').blocking.length, 1);
});

test('Sharded reports are combined by glob; missing, stale and unsafe inputs error', async () => {
  junit({ 'a#one': 'R' }, 'reports/shard-1/junit.xml');
  junit({ 'b#two': 'P' }, 'reports/shard-2/junit.xml');
  const r = await check({ junit: 'reports/**/junit.xml' });
  assert.equal(r.status, 'failed', r.reason);
  assert.equal(r.stats?.testsInRun, 2);

  assert.match((await check({ junit: 'reports/none-*.xml' })).reason ?? '', /No JUnit file matches/);
  assert.match((await check({ junit: 'reports/missing.xml' })).reason ?? '', /not found/);

  junit({ 'a#one': 'P' }, 'reports/old.xml');
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(repo, 'reports/old.xml'), past, past);
  const stale = await check({ junit: 'reports/old.xml' });
  assert.equal(stale.status, 'errored');
  assert.match(stale.reason ?? '', /older than the latest commit/);

  write('reports/dtd.xml', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "x">]><testsuites><testsuite><testcase name="t"/></testsuite></testsuites>');
  assert.match((await check({ junit: 'reports/dtd.xml' })).reason ?? '', /DTD\/entity/);
  write('reports/empty.xml', '<testsuites><testsuite name="none"/></testsuites>');
  assert.match((await check({ junit: 'reports/empty.xml' })).reason ?? '', /no test cases/);

  assert.match((await check({ store: '../outside.json' })).reason ?? '', /relative \.json path/);
  assert.match((await check({ store: '.veriq/history.jsonl' })).reason ?? '', /relative \.json path/);
});

test('A damaged, linked or future-dated history errors instead of being overwritten', async () => {
  junit({ 'a#t': 'P' });
  const file = path.join(repo, '.veriq/test-history.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(file, '{not json');
  assert.match((await check()).reason ?? '', /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json', 'a damaged history is left for a person to inspect');

  fs.writeFileSync(file, JSON.stringify({ version: 1, tests: ['a', 'b'], runs: [{ at: new Date().toISOString(), dirty: false, hash: 'a'.repeat(64), outcomes: 'P' }] }));
  assert.match((await check()).reason ?? '', /history is invalid/);

  fs.writeFileSync(file, JSON.stringify({ version: 1, tests: ['a'], runs: [{ at: new Date(Date.now() + 86_400_000).toISOString(), dirty: false, hash: 'a'.repeat(64), outcomes: 'P' }] }));
  assert.match((await check()).reason ?? '', /in the future/);

  fs.rmSync(file);
  fs.writeFileSync(path.join(repo, 'elsewhere.json'), JSON.stringify({ version: 1, tests: [], runs: [] }));
  fs.symlinkSync(path.join(repo, 'elsewhere.json'), file);
  assert.match((await check()).reason ?? '', /regular file/);
});

test('Without git, runs are still recorded but no run counts as the same commit', async () => {
  fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
  junit({ 'a#t': 'F' }); await check();
  junit({ 'a#t': 'P' });
  const r = await check();
  assert.equal(r.status, 'skipped');
  const store = JSON.parse(fs.readFileSync(path.join(repo, '.veriq/test-history.json'), 'utf8'));
  assert.ok(store.runs.every((x: { commit?: string }) => x.commit === undefined));
});

test('JUnit names decode XML entities, so one test keeps one identity across reporters', async () => {
  const { parseJUnit } = await import('../src/core/junit.js');
  const names = parseJUnit('<testsuites><testsuite><testcase classname="cart" name="doesn&apos;t crash &amp; &lt;b&gt;"/><testcase classname="cart" name="doesn&#39;t crash &#x26; &lt;b&gt;"/><testcase name="bad &#0; &#xD800; &bogus;"/></testsuite></testsuites>').map((c) => c.name);
  assert.equal(names[0], "cart doesn't crash & <b>");
  assert.equal(names[1], names[0], 'named and numeric references give the same name');
  assert.equal(names[2], 'bad &#0; &#xD800; &bogus;', 'invalid references and unknown entities stay as written');
});

test('History pruning, analysis rules and settings validation', () => {
  let h: History = { version: 1, tests: [], runs: [] };
  for (let i = 0; i < 12; i++) {
    const codes = new Map<string, 'P' | 'F'>([['always', 'P'], [`only-${i}`, 'P']]);
    h = addRun(h, { at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), dirty: false, hash: String(i).padStart(64, '0') }, codes, 10);
  }
  assert.equal(h.runs.length, 10, 'only the newest maxRuns are kept');
  assert.equal(h.tests.length, 11, 'tests only seen in dropped runs are removed');
  assert.ok(!h.tests.includes('only-0') && !h.tests.includes('only-1'));
  assert.ok(h.runs.every((r) => r.outcomes.length === h.tests.length));
  assert.equal(h.runs[0].outcomes[h.tests.indexOf('only-2')], 'P');
  assert.equal(h.runs[1].outcomes[h.tests.indexOf('only-2')], '.');

  // Skipped and absent runs do not count as changes.
  const s: History = { version: 1, tests: ['t'], runs: ['P', 'S', '.', 'P', 'F', 'S', 'F'].map((o, i) => ({ at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), dirty: false, hash: String(i).padStart(64, '0'), outcomes: o })) };
  const a = analyse(s, { window: 30, minRuns: 2, minFlips: 2 });
  assert.equal(a.flaky.length, 0, 'P P F F is one change');

  const bad = (x: unknown) => assert.equal(flakyTestsSchema.safeParse(x).success, false, JSON.stringify(x));
  bad({});
  bad({ junit: '/abs/junit.xml' });
  bad({ junit: '../junit.xml' });
  bad({ junit: 'j.xml', minRuns: 40, window: 30 });
  bad({ junit: 'j.xml', window: 300, maxRuns: 200 });
  bad({ junit: 'j.xml', unknown: 1 });
  assert.equal(flakyTestsSchema.safeParse({ record: false }).success, true, 'analysis-only needs no report');
  assert.equal(flakyTestsSchema.safeParse({ junit: ['a.xml', 'shards/**/*.xml'] }).success, true);
});
