import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { convertRecording } from "../src/core/record-flow.js";
import { startRecorderSession } from "../src/core/recorder-session.js";
const options = { app: "business", name: "Recorded", baseUrl: "https://example.test" };
const wrap = (body: string) => `import { test, expect } from '@playwright/test'; test('test', async ({ page }) => { ${body} });`;
test("assertions preserve negation and keep asserted input values out of generated source", () => {
  const r = convertRecording(wrap(`await expect(page.getByText('Ready')).not.toBeHidden(); await expect(page.getByLabel('Password')).toHaveValue('sensitive-value');`), options);
  assert.ok(r.source.includes('.not.toBeHidden()'));
  assert.ok(r.source.includes('toHaveValue(input("QA_FLOW_INPUT_1"))'));
  assert.ok(!r.source.includes('sensitive-value'));
  assert.ok(r.source.includes('page, step, expect'));
});
test("interactive handoff enforces origin/token, retries invalid source, saves once and cancels cleanly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-session-'));
  const output = path.join(dir, 'flow.mjs');
  const session = await startRecorderSession({ ...options, output, timeoutMs: 10_000 });
  const u = new URL(session.url);
  const headers = { origin: u.origin, authorization: `Bearer ${u.pathname.slice(1)}` };
  try {
    assert.equal((await fetch(session.url)).status, 200);
    assert.equal((await fetch(u.origin + '/save', { method: 'POST', body: wrap("await page.goto('https://example.test/');") })).status, 403);
    assert.equal((await fetch(u.origin + '/save', { method: 'POST', headers: { ...headers, origin: 'https://evil.invalid' }, body: '' })).status, 403);
    assert.equal((await fetch(u.origin + '/save', { method: 'POST', headers, body: wrap('await page.evaluate(() => {});') })).status, 422);
    assert.equal(fs.existsSync(output), false);
    const saved = await fetch(u.origin + '/save', { method: 'POST', headers, body: wrap("await page.getByLabel('Password').fill('private-recorded-value');") });
    assert.equal(saved.status, 200);
    assert.equal((await session.done).saved, true);
    assert.ok(!fs.readFileSync(output, 'utf8').includes('private-recorded-value'));
    const abortedOutput = path.join(dir, 'cancelled.mjs');
    const controller = new AbortController();
    const aborted = await startRecorderSession({ ...options, output: abortedOutput, signal: controller.signal });
    controller.abort();
    assert.equal((await aborted.done).saved, false);
    assert.equal(fs.existsSync(abortedOutput), false);
    const expired = await startRecorderSession({ ...options, output: abortedOutput, timeoutMs: 20 });
    assert.equal((await expired.done).saved, false);
    assert.equal(fs.existsSync(abortedOutput), false);
  } finally { session.cancel(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("codegen conversion preserves nested locators and order; fill literals never reach output", () => {
  const r = convertRecording(wrap(`await page.goto('https://example.test/login'); await page.getByRole('dialog').getByLabel('Password', { exact: true }).fill('secret-never-persist'); await page.getByRole('button', {name:'Submit', exact:true}).click();`), options);
  assert.ok(r.source.includes('page.getByRole("dialog").getByLabel("Password",{exact:true}).fill(input("QA_FLOW_INPUT_1"))'));
  assert.ok(!r.source.includes('secret-never-persist'));
  assert.ok(r.source.indexOf('.goto(') < r.source.indexOf('.fill('));
  assert.deepEqual(r.variables, ['QA_FLOW_INPUT_1']);
});
test("unsupported assertions, setup, popups and dynamic code fail closed", () => {
  for (const code of [
    `await expect(page).toHaveScreenshot();`,
    `const popup = await page.waitForEvent('popup');`,
    `await page.evaluate(() => process.exit());`,
    `await page.getByLabel('Name').fill(process.env.SECRET);`,
    `await page.goto('https://other.test/');`,
    `await page.goto('https://example.test/?token=secret');`,
    `await page.goto('https://example.test'); if (true) {}`,
  ]) assert.throws(() => convertRecording(wrap(code), options));
  assert.throws(() => convertRecording(wrap('await page.goto('), options));
  assert.throws(() => convertRecording(wrap('') + wrap(''), options));
});
test("CLI refuses to overwrite an existing flow and rejects invalid input without writing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-convert-'));
  const file = path.join(dir, 'flow.mjs');
  const args = ['--import', 'tsx', 'src/cli.ts', 'flow-import', '--app', 'fixture', '--name', 'Fixture', '--url', options.baseUrl, '--out', file];
  try {
    const invalid = spawnSync(process.execPath, args, { input: wrap('await page.evaluate(() => {});'), encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, 'preserve-existing-flow');
    const duplicate = spawnSync(process.execPath, args, { input: wrap("await page.goto('https://example.test/');"), encoding: 'utf8' });
    assert.equal(duplicate.status, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), 'preserve-existing-flow');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
