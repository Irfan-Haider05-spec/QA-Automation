import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJunit } from '../src/plugins/fuzz.js';

test('Fuzz reports reject empty, skipped-only, malformed and entity-bearing reports', () => {
  for (const report of ['<testsuites tests="0"><testsuite tests="0"/></testsuites>', '<testsuite><testcase name="omitted"><skipped/></testcase></testsuite>', '<testsuite>', '<!DOCTYPE x [<!ENTITY y "secret">]><testsuite/>']) assert.throws(() => parseJunit(report));
});
test('Fuzz reports preserve actual failures and accept executed passing cases', () => {
  assert.deepEqual(parseJunit('<testsuite><testcase name="GET /healthy"/></testsuite>'), []);
  assert.deepEqual(parseJunit('<testsuites><testsuite><testcase name="GET /bad"><failure message="Server error">- Server error\nDetails &lt;safe&gt;</failure></testcase></testsuite></testsuites>'),
    [{ name: 'GET /bad', message: 'Server error', body: '- Server error\nDetails <safe>' }]);
});
