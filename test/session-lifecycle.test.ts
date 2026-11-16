import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { HttpClient } from '../src/core/http.js';
import { AuthProvider } from '../src/core/auth.js';
import { runPlugins } from '../src/core/runner.js';
import { authSession } from '../src/plugins/expanded/api-checks.js';

interface Family { refreshRevoked: boolean; accessRevoked: boolean; currentAccess: string }
const access = new Map<string, Family>();
const refresh = new Map<string, { family: Family; consumed: boolean }>();
let mode = 'healthy', policy = 'revoke-family', url = '', base: RunContext;
let calls: string[] = [], values: string[] = [];
function mint(family?: Family) {
  family ??= { refreshRevoked: false, accessRevoked: false, currentAccess: '' };
  const accessToken = `access-${randomUUID()}`, refreshToken = `refresh-${randomUUID()}`;
  family.currentAccess = accessToken; access.set(accessToken, family); refresh.set(refreshToken, { family, consumed: false });
  values.push(accessToken, refreshToken); return { accessToken, refreshToken };
}
const server = http.createServer(async (req, res) => {
  calls.push(`${req.method} ${req.url}`);
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const reply = (status: number, data: unknown = {}) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url === '/login') {
    if (body.email !== 'qa@example.test' || body.password !== 'private-test-password' || mode === 'bad-login') return reply(401);
    return reply(200, { tokens: mint() });
  }
  if (req.url === '/protected') {
    if (mode === 'public-control') return reply(200);
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const family = access.get(token);
    return reply(family && !family.accessRevoked && family.currentAccess === token ? 200 : 401);
  }
  if (req.url === '/refresh') {
    if (mode === 'server-error') return reply(500, { error: 'private-test-password' });
    if (mode === 'rate-limit') return reply(429);
    const record = refresh.get(body.refreshToken);
    if (!record) return mode === 'accept-invalid' ? reply(200, { tokens: mint() }) : reply(401);
    if (record.family.refreshRevoked) return reply(401);
    if (record.consumed) {
      if (mode === 'accept-reuse') return reply(200, { tokens: mint(record.family) });
      if (policy === 'revoke-family' && mode !== 'family-survives') {
        record.family.refreshRevoked = true;
        record.family.accessRevoked = mode !== 'access-survives';
      }
      return reply(401);
    }
    if (mode === 'no-rotation') return reply(200, { tokens: { accessToken: record.family.currentAccess, refreshToken: body.refreshToken } });
    if (mode === 'malformed-pair') return reply(200, { secret: 'private-test-password' });
    record.consumed = true;
    return reply(200, { tokens: mint(record.family) });
  }
  if (req.url === '/logout') {
    const record = refresh.get(body.refreshToken);
    if (!record || req.headers.authorization !== `Bearer ${record.family.currentAccess}`) return reply(401);
    if (mode !== 'logout-survives') { record.family.refreshRevoked = true; record.family.accessRevoked = true; }
    return reply(204);
  }
  reply(404);
});
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { config } = await loadConfig('test/fixture.config.ts', {});
  config.target.baseUrl = url; config.target.requestsPerMinute = 60000;
  config.allowMutations = true; config.disposable = true;
  config.login = { path: '/login', tokenPath: 'tokens.accessToken', bodyTemplate: { email: '{{identifier}}', password: '{{password}}' } };
  config.accounts = { qa: { identifier: 'qa@example.test', password: 'private-test-password', role: 'USER', device: 'web' } };
  base = { config, configDir: process.cwd(), outDir: 'qa-out', suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
});
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
async function run(nextMode: string, reusePolicy: 'revoke-family' | 'reject-only' = 'revoke-family', overrides: Record<string, unknown> = {}) {
  mode = nextMode; policy = reusePolicy; calls = []; values = []; access.clear(); refresh.clear();
  const config = structuredClone(base.config);
  config.pluginSettings = { 'auth-session': { account: 'qa', protectedPath: '/protected', jwtProbes: false,
    refresh: { path: '/refresh', refreshTokenPath: 'tokens.refreshToken', reusePolicy, revokeAccessOnReuse: reusePolicy === 'revoke-family', logoutPath: '/logout', revokeAccessOnLogout: true }, ...overrides } };
  const client = new HttpClient(url, 60000, 2000);
  return (await runPlugins([authSession], { ...base, config, http: client, auth: new AuthProvider(config, client) }))[0];
}
test('Refresh lifecycle accepts healthy revoke-family and reject-only policies with fresh logout controls', async () => {
  for (const reusePolicy of ['revoke-family', 'reject-only'] as const) {
    const result = await run('healthy', reusePolicy); assert.equal(result.status, 'passed', result.reason);
    assert.equal(calls.filter(c => c === 'POST /login').length, 2);
    assert.equal(calls.filter(c => c === 'POST /logout').length, 1);
  }
});
test('Refresh lifecycle detects planted rotation, reuse, family/access and logout defects', async () => {
  for (const [fault, title] of [
    ['accept-invalid', 'Invalid refresh token accepted'], ['no-rotation', 'Refresh token was not rotated'],
    ['accept-reuse', 'Previously consumed refresh token accepted'], ['family-survives', 'Refresh token family remains usable'],
    ['access-survives', 'Access token remains usable after reuse'], ['logout-survives', 'Refresh token remains usable after logout'],
  ]) {
    const result = await run(fault); assert.equal(result.status, 'failed', fault);
    assert.ok(result.findings.some(f => f.title.includes(title)), fault);
    if (fault === 'family-survives') assert.ok(result.findings.some(f => f.title.includes('Access token remains usable after reuse')));
    if (fault === 'logout-survives') assert.ok(result.findings.some(f => f.title.includes('Access token remains usable after logout')));
    const output = JSON.stringify(result);
    for (const secret of ['private-test-password', ...values]) assert.ok(!output.includes(secret));
  }
});
test('Inconclusive refresh responses error without retry or credential-bearing evidence', async () => {
  for (const fault of ['server-error', 'rate-limit', 'bad-login', 'malformed-pair']) {
    const result = await run(fault); assert.equal(result.status, 'errored', fault);
    assert.ok(!JSON.stringify(result).includes('private-test-password'));
    if (fault === 'server-error' || fault === 'rate-limit') assert.equal(calls.filter(c => c === 'POST /refresh').length, 1);
  }
});
test('Refresh configuration preflight refuses unsupported policy before sending requests', async () => {
  const result = await run('healthy', 'revoke-family', { refresh: { path: '/refresh', refreshTokenPath: 'tokens.refreshToken', reusePolicy: 'reject-only', revokeAccessOnReuse: true } });
  assert.equal(result.status, 'errored'); assert.equal(calls.length, 0);
  const previous = base.config.disposable; base.config.disposable = false;
  try { assert.equal((await run('healthy')).status, 'skipped'); assert.equal(calls.length, 0); }
  finally { base.config.disposable = previous; }
});
test('Refresh checks reject a public positive-control endpoint and redact malformed JWT payloads', async () => {
  const exposed = await run('public-control');
  assert.equal(exposed.status, 'failed');
  assert.ok(exposed.findings.some(f => f.title.includes('accepts anonymous requests')));
  assert.equal(calls.filter(c => c === 'POST /login').length, 0);
  const old = base.config.accounts.qa.accessToken;
  base.config.accounts.qa.accessToken = `e30.${Buffer.from('private-malformed-jwt-claim').toString('base64url')}.signature`;
  try {
    const result = await run('healthy', 'revoke-family', { jwtProbes: true, refresh: undefined });
    assert.equal(result.status, 'errored');
    assert.ok(!JSON.stringify(result).includes('private-malformed-jwt-claim'));
  } finally { base.config.accounts.qa.accessToken = old; }
});
