import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { HttpClient } from '../src/core/http.js';
import { AuthProvider } from '../src/core/auth.js';
import { runPlugins } from '../src/core/runner.js';
import { webhookSecurity } from '../src/plugins/expanded/api-checks.js';
import { apiContract } from '../src/plugins/expanded/static-checks.js';
import { inputRestrictions, typesIncluded } from '../src/plugins/expanded/contract-schema.js';

let base: RunContext, url = '', mode = '', state = 0, posts = 0, dir = '';
const signature = 'private-valid-webhook-signature';
const previousSignature = process.env.VERIQ_TEST_SIGNATURE;
const server = http.createServer(async (req, res) => {
  for await (const _ of req) { /* consume payload */ }
  const reply = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== 'Bearer private-account-token') return reply(401, {});
  if (req.method === 'GET') return reply(mode === 'read-error' ? 500 : 200, mode === 'missing-path' ? {} : { state });
  posts++;
  if (mode === 'rate-limit') return reply(429, {});
  const valid = req.headers['x-signature'] === signature;
  if (mode === 'mutates-rejected') state = 1;
  if (valid && mode !== 'inert') state = 1;
  if (mode === 'delayed') setTimeout(() => { state = 1; }, 20);
  reply(valid || mode === 'ack-ignore' ? 200 : 403, {});
});
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'veriq-contract-'));
  const { config } = await loadConfig('test/fixture.config.ts', {});
  config.target.baseUrl = url; config.target.requestsPerMinute = 60000;
  config.allowMutations = true; config.disposable = true;
  config.accounts = { qa: { accessToken: 'private-account-token', role: 'USER', device: 'web' } };
  base = { config, configDir: dir, outDir: 'qa-out', suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
  process.env.VERIQ_TEST_SIGNATURE = signature;
});
after(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
  if (previousSignature === undefined) delete process.env.VERIQ_TEST_SIGNATURE; else process.env.VERIQ_TEST_SIGNATURE = previousSignature;
});
const webhookCase = () => ({ method: 'POST', path: '/hook', account: 'qa', json: { event: 'test' }, signatureHeader: 'x-signature',
  state: { verify: { path: '/state', account: 'qa' }, valuePath: 'state', validSignatureEnv: 'VERIQ_TEST_SIGNATURE', expectedValue: 1, observeMs: 60, pollIntervalMs: 25 } });
async function webhook(nextMode: string, cases: unknown[] = [webhookCase()]) {
  mode = nextMode; state = nextMode === 'already-done' ? 1 : 0; posts = 0;
  const config = structuredClone(base.config); config.pluginSettings = { 'webhook-security': { cases } };
  const client = new HttpClient(url, 60000, 2000);
  return (await runPlugins([webhookSecurity], { ...base, config, http: client, auth: new AuthProvider(config, client) }))[0];
}
test('Webhook state controls accept rejection and acknowledge-ignore while retaining authentication', async () => {
  for (const mode of ['healthy', 'ack-ignore']) {
    const result = await webhook(mode); assert.equal(result.status, 'passed', result.reason); assert.equal(posts, 3); assert.equal(state, 1);
  }
});
test('Webhook detects immediate and delayed unauthorized state effects even after HTTP rejection', async () => {
  for (const mode of ['mutates-rejected', 'delayed']) {
    const result = await webhook(mode); assert.equal(result.findings.length, 1); assert.match(result.findings[0].title, /processed missing/); assert.equal(posts, 1);
    assert.ok(!JSON.stringify(result).includes(signature)); assert.ok(!JSON.stringify(result).includes('private-account-token'));
  }
});
test('Webhook errors on inert positive controls, unavailable state, stale initial state and rate limiting', async () => {
  for (const mode of ['inert', 'read-error', 'missing-path', 'already-done', 'rate-limit']) {
    const result = await webhook(mode); assert.equal(result.status, 'errored', `${mode}: ${JSON.stringify(result)}`);
    if (['read-error', 'missing-path', 'already-done'].includes(mode)) assert.equal(posts, 0);
    if (mode === 'rate-limit') assert.equal(posts, 1);
  }
});
test('Webhook preflights all cases before any writes', async () => {
  for (const change of [{ method: 'GET' }, { signatureHeader: 'Host' }, { signatureHeader: 'Authorization' }, { staleSignatureEnv: 'VERIQ_NONEXISTENT_TEST_SIGNATURE' }, { state: { ...webhookCase().state, validSignatureEnv: 'VERIQ_NONEXISTENT_TEST_SIGNATURE' } }]) {
    const result = await webhook('healthy', [webhookCase(), { ...webhookCase(), ...change }]);
    assert.equal(result.status, 'errored'); assert.equal(posts, 0);
  }
});

function document(input: unknown, output: unknown): any {
  return { openapi: '3.1.0', info: { title: 'Fixture', version: '1' }, paths: { '/items': { post: {
    requestBody: { content: { 'application/json': { schema: input } } }, responses: { '200': { description: 'OK', content: { 'application/json': { schema: output } } } },
  } } } };
}
async function contract(before: any, after: any) {
  await fs.writeFile(path.join(dir, 'before.json'), JSON.stringify(before)); await fs.writeFile(path.join(dir, 'after.json'), JSON.stringify(after));
  const config = structuredClone(base.config); config.pluginSettings = { 'api-contract': { baseline: 'before.json', current: 'after.json' } };
  return (await runPlugins([apiContract], { ...base, config }))[0];
}
test('Contract permits input widening and response narrowing including semantic union order', async () => {
  assert.ok(typesIncluded({ type: ['null', 'string'] }, { type: ['string', 'null'] }));
  const result = await contract(document({ type: 'integer', minimum: 2, enum: [2] }, { type: 'number', enum: [2, 3] }), document({ type: 'number', minimum: 1, enum: [2, 3] }, { type: 'integer', enum: [2] }));
  assert.equal(result.status, 'passed', result.reason);
  assert.deepEqual(inputRestrictions({}, {}, { type: 'object', additionalProperties: false }, { type: 'object', additionalProperties: false, properties: { optional: { type: 'string' } } }, 'body'), []);
});
test('Contract reports nested request tightening and response guarantee removal', async () => {
  const prior = { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } } };
  const next = { ...prior, required: ['id', 'tags'], additionalProperties: false, properties: { ...prior.properties, tags: { type: 'array', minItems: 1, items: { type: 'string', enum: ['a'] } } } };
  const result = await contract(document(prior, prior), document(next, { ...prior, required: [], nullable: true }));
  const details = result.findings.map(f => f.detail).join(' ');
  for (const expected of ['new required property', 'minItems increased', 'input enum narrowed', 'additional properties disallowed', 'response no longer guaranteed', 'response may now be null']) assert.ok(details.includes(expected), details);
});
test('Contract merges operation parameter overrides and detects media removal without schemas', async () => {
  const prior = document({}, {}), next = structuredClone(prior);
  prior.paths['/items'].parameters = [{ in: 'query', name: 'q', required: true, schema: { type: 'string' } }];
  prior.paths['/items'].post.parameters = [{ in: 'query', name: 'q', required: false, schema: { type: 'string' } }];
  next.paths['/items'].post.parameters = prior.paths['/items'].post.parameters;
  assert.equal((await contract(prior, next)).status, 'passed');
  prior.paths['/items'].post.responses['200'].content['text/plain'] = {};
  assert.ok((await contract(prior, next)).findings.some(f => f.title === 'Response media type removed'));
});
test('Contract fails closed on unsupported boolean and composed schemas', async () => {
  for (const schema of [false, true, { oneOf: [{ type: 'string' }] }]) {
    const result = await contract(document({}, {}), document(schema, {})); assert.equal(result.status, 'errored');
  }
});
