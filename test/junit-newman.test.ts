/**
 * Postman collections run with Newman (`newman run collection.json -r junit`) produce JUnit
 * with one suite per request and the same assertion names in every suite. These reports go
 * through the existing test-results and flaky-tests checks; this file shows they are read
 * as separate tests, and that reports from other tools keep their names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import type { Finding } from '../src/core/types.js';
import { parseJUnit } from '../src/core/junit.js';
import { runOutcomes } from '../src/plugins/expanded/flaky-tests.js';
import { EXPANDED_PLUGINS } from '../src/plugins/expanded/index.js';
import { triage } from '../src/core/triage.js';

// Shape of newman's JUnit reporter: a suite per request, assertions as test cases.
const NEWMAN = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="MLITech QA" tests="5" time="0.412">
  <testsuite name="Login merchant" id="a1" timestamp="2026-11-19T10:00:00.000Z" tests="2" failures="0" errors="0" time="0.120">
    <testcase name="Status code is 200" time="0.120" classname="MLITechQA"/>
    <testcase name="Returns a token" time="0.120" classname="MLITechQA"/>
  </testsuite>
  <testsuite name="Create promotion" id="a2" timestamp="2026-11-19T10:00:00.200Z" tests="2" failures="1" errors="0" time="0.180">
    <testcase name="Status code is 200" time="0.180" classname="MLITechQA"><failure type="AssertionFailure" message="expected response to have status code 200 but got 500"><![CDATA[Failed 1 times.]]></failure></testcase>
    <testcase name="Discount stored" time="0.180" classname="MLITechQA"><failure type="AssertionFailure" message="expected 150 to be below 101"><![CDATA[Failed 1 times.]]></failure></testcase>
  </testsuite>
  <testsuite name="Read promotion" id="a3" timestamp="2026-11-19T10:00:00.400Z" tests="1" failures="0" errors="0" time="0.112">
    <testcase name="Status code is 200" time="0.112" classname="MLITechQA"/>
  </testsuite>
</testsuites>`;

test('Newman assertions with the same name in different requests are separate tests', () => {
  const cases = parseJUnit(NEWMAN);
  assert.deepEqual(cases.map((c) => [c.name, c.outcome]), [
    ['Login merchant › MLITechQA Status code is 200', 'passed'],
    ['MLITechQA Returns a token', 'passed'],
    ['Create promotion › MLITechQA Status code is 200', 'failed'],
    ['MLITechQA Discount stored', 'failed'],
    ['Read promotion › MLITechQA Status code is 200', 'passed'],
  ], 'only repeated names get the suite; unique names keep their identity');
  const { codes, duplicateNames } = runOutcomes(cases);
  assert.equal(duplicateNames, 0);
  assert.equal([...codes.values()].includes('M'), false, 'a pass in one request and a failure in another is not a flaky test');
});

test('Names from other tools are unchanged, and repeats inside one suite keep their name', () => {
  const jest = `<testsuites><testsuite name="promotions.test.ts"><testcase classname="Promotions create" name="rejects a negative value"/><testcase classname="Promotions list" name="rejects a negative value"/></testsuite></testsuites>`;
  assert.deepEqual(parseJUnit(jest).map((c) => c.name), ['Promotions create rejects a negative value', 'Promotions list rejects a negative value']);
  const rerun = `<testsuite name="api"><testcase classname="Checkout" name="awards points"><failure/></testcase><testcase classname="Checkout" name="awards points"/></testsuite>`;
  const cases = parseJUnit(rerun);
  assert.deepEqual(cases.map((c) => c.name), ['Checkout awards points', 'Checkout awards points'], 'a reporter that lists a rerun in the same suite keeps one identity');
  assert.equal(runOutcomes(cases).codes.get('Checkout awards points'), 'M');
  const nested = `<testsuites><testsuite name="outer"><testsuite name="A"><testcase name="ok"/></testsuite><testsuite name=""><testcase name="ok"/></testsuite></testsuite></testsuites>`;
  assert.deepEqual(parseJUnit(nested).map((c) => c.name), ['A › ok', 'outer › ok'], 'a suite without a name uses its parent\'s');
});

test('test-results reports both failing Newman requests as their own findings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-newman-'));
  try {
    fs.writeFileSync(path.join(dir, 'newman.xml'), NEWMAN);
    const { config } = await loadConfig('test/fixture.config.ts', {});
    config.pluginSettings = { 'test-results': { junit: 'newman.xml' } };
    const ctx = { config, configDir: dir, outDir: dir, suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, openapiPath: '', log: { info() {}, warn() {}, debug() {} } } as unknown as RunContext;
    const out = await EXPANDED_PLUGINS.find((p) => p.name === 'test-results')!.run(ctx);
    const findings = (Array.isArray(out) ? out : out.findings) as Finding[];
    assert.deepEqual(findings.map((f) => f.target).sort(), ['Create promotion › MLITechQA Status code is 200', 'MLITechQA Discount stored']);
    assert.equal(triage([{ plugin: 'test-results', status: 'failed', durationMs: 1, findings }], [])[0].findings.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
