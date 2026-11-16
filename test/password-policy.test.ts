import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { HttpClient } from '../src/core/http.js';
import { AuthProvider } from '../src/core/auth.js';
import { runPlugins } from '../src/core/runner.js';
import { passwordPolicy, DEFAULT_COMMON_PASSWORDS, strongPassword } from '../src/plugins/expanded/password-policy.js';

const ADMIN_TOKEN = 'admin-fixture-token';
let url = '', base: RunContext;
let calls: string[] = [], submitted: string[] = [], users = new Set<string>();

/** Server-side policies planted per route. */
function verdict(route: string, email: string, password: string, n: number): number {
  const local = email.split('@')[0];
  const composed = /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password);
  const strong = password.length >= 12 && password.length <= 128 && composed && !DEFAULT_COMMON_PASSWORDS.includes(password) && !password.toLowerCase().includes(local.toLowerCase());
  switch (route) {
    case '/register-strong': case '/admin/users': return strong ? 201 : 422;
    case '/register-weak': return 201;
    case '/register-length-only': return password.length >= 12 ? 201 : 400;
    case '/register-max20': return strong && password.length <= 20 ? 201 : 422;
    case '/register-broken-control': return 400;
    case '/register-500': return n === 1 ? 201 : 500;
    case '/register-429': return n === 1 ? 201 : 429;
    case '/register-409': return n === 1 ? 201 : 409;
    case '/register-302': return n === 1 ? 201 : 302;
    default: return 404;
  }
}
const server = http.createServer(async (req, res) => {
  const route = req.url ?? '';
  calls.push(`${req.method} ${route}`);
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const reply = (status: number, data: unknown = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (status === 302) headers.location = '/elsewhere';
    res.writeHead(status, headers); res.end(status === 204 ? undefined : JSON.stringify(data));
  };
  if (route === '/login') return body.email === 'admin@example.test' && body.password === 'admin-test-password' ? reply(200, { token: ADMIN_TOKEN }) : reply(401);
  if (route === '/admin/users' && req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return reply(401);
  submitted.push(body.password, body.email);
  if (body.password !== body.confirm) return reply(400, { error: 'confirmation mismatch' });
  const n = calls.filter(c => c === `${req.method} ${route}`).length;
  const status = verdict(route, body.email, body.password, n);
  if (status >= 200 && status < 300) users.add(body.email);
  // Echo the submitted values back, as some real APIs do, to prove the plugin never repeats them.
  reply(status, { email: body.email, rejected: status >= 400 ? body.password : undefined });
});
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { config } = await loadConfig('test/fixture.config.ts', {});
  config.target.baseUrl = url; config.target.requestsPerMinute = 60000;
  config.allowMutations = true; config.disposable = true;
  config.login = { path: '/login', tokenPath: 'token', bodyTemplate: { email: '{{identifier}}', password: '{{password}}' } };
  config.accounts = { admin: { identifier: 'admin@example.test', password: 'admin-test-password', role: 'ADMIN', device: 'web' } };
  base = { config, configDir: process.cwd(), outDir: 'qa-out', suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
});
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

const body = { email: '{{unique}}@example.test', password: '{{password}}', confirm: '{{password}}' };
const spec = (path: string, extra: Record<string, unknown> = {}) => ({ path, body, ...extra });
async function run(settings: unknown, flags: Record<string, unknown> = {}) {
  calls = []; submitted = []; users = new Set();
  const config = { ...structuredClone(base.config), ...flags, pluginSettings: { 'password-policy': settings } };
  const client = new HttpClient(url, 60000, 2000);
  return (await runPlugins([passwordPolicy], { ...base, config, http: client, auth: new AuthProvider(config, client) }))[0];
}
function assertNoSecrets(result: unknown, label: string) {
  const text = JSON.stringify(result);
  for (const value of submitted) assert.ok(!text.includes(value), `${label}: submitted value leaked`);
  assert.ok(!text.includes('admin-test-password') && !text.includes(ADMIN_TOKEN), `${label}: credential leaked`);
}
const titles = (r: { findings: Array<{ title: string }> }) => r.findings.map(f => f.title);

test('Password policy passes a healthy registration and authenticated user-create endpoint with every check', async () => {
  for (const extra of [{}, { path: '/admin/users', account: 'admin' }]) {
    const result = await run({ cases: [spec('/register-strong', { checks: ['length', 'common', 'identifier', 'long'], ...extra })] });
    assert.equal(result.status, 'passed', result.reason);
    assert.equal(result.findings.length, 0);
    // control + length + 4 common + identifier + long; every submission is a distinct new user.
    const posts = calls.filter(c => c.startsWith('POST /register') || c === 'POST /admin/users');
    assert.equal(posts.length, 8);
    assert.equal(new Set(submitted.filter((_, i) => i % 2 === 1)).size, 8, 'identifiers must be unique per submission');
    assertNoSecrets(result, 'healthy');
  }
});

test('Password policy detects accepted short, common and identifier passwords and refused long passphrases', async () => {
  const weak = await run({ cases: [spec('/register-weak', { checks: ['length', 'common', 'identifier', 'long'] })] });
  assert.equal(weak.status, 'failed');
  assert.deepEqual(titles(weak).sort(), [
    'Password equal to the account identifier accepted',
    'Password shorter than the required minimum accepted',
    'Well-known common password accepted',
  ]);
  assert.ok(weak.findings.every(f => f.cwe?.includes('CWE-521')));
  assertNoSecrets(weak, 'weak');

  const lengthOnly = await run({ cases: [spec('/register-length-only', { checks: ['length', 'common'] })] });
  assert.equal(lengthOnly.status, 'failed');
  assert.deepEqual(titles(lengthOnly), ['Well-known common password accepted']);

  const max20 = await run({ cases: [spec('/register-max20', { checks: ['length', 'long'] })] });
  assert.equal(max20.status, 'failed', max20.reason);
  assert.deepEqual(titles(max20), ['Long passphrase (64 characters) rejected']);
  assertNoSecrets(max20, 'max20');

  const custom = await run({ cases: [spec('/register-strong', { checks: ['common'], commonPasswords: ['Correct-Horse-9'] })] });
  assert.equal(custom.status, 'failed', 'a custom candidate not on the server blocklist must be reported');
});

test('Password policy fails closed on a failed control and on inconclusive answers, without retries', async () => {
  for (const route of ['/register-broken-control', '/register-500', '/register-429', '/register-409', '/register-302']) {
    const result = await run({ cases: [spec(route)] });
    assert.equal(result.status, 'errored', route);
    assert.equal(calls.filter(c => c === `POST ${route}`).length, route === '/register-broken-control' ? 1 : 2, `${route}: stops at the first inconclusive answer`);
    assertNoSecrets(result, route);
  }
  // The control is accepted only for configured statuses.
  const strict = await run({ cases: [spec('/register-strong', { acceptedStatuses: [200] })] });
  assert.equal(strict.status, 'errored');
  // An unauthenticated account-create route cannot be mistaken for a policy rejection.
  const unauth = await run({ cases: [spec('/admin/users')] });
  assert.equal(unauth.status, 'errored');
});

test('Password policy requires disposable authorization and preflights every case before creating users', async () => {
  for (const flags of [{ allowMutations: false }, { disposable: false }]) {
    assert.equal((await run({ cases: [spec('/register-strong')] }, flags)).status, 'skipped');
    assert.equal(calls.length, 0);
  }
  const invalid: unknown[] = [
    { cases: [spec('/register-strong'), spec('/admin/users', { account: 'missing' })] },
    { cases: [spec('/register-strong', { minLength: 16, checks: ['common'] })] },
    { cases: [spec('/register-strong', { minLength: 22, checks: ['identifier'] })] },
    { cases: [spec('/register-strong', { commonPasswords: ['Abcdefgh12345'], checks: ['length'] })] },
    { cases: [{ path: '/register-strong', body: { email: '{{unique}}@example.test' } }] },
    { cases: [{ path: '/register-strong', body: { email: 'fixed@example.test', password: '{{password}}' } }] },
    { cases: [{ path: '/register-strong', body: { email: '{{unique}}@example.test', password: 'x{{password}}' } }] },
    { cases: [{ path: '/register-strong', body: { email: '{{unique}}', password: '{{password}}', token: '{{account.password}}' } }] },
    { cases: [spec('/register-strong', { rejectionStatuses: [409] })] },
    { cases: [spec('/register-strong', { checks: ['length', 'length'] })] },
    { cases: [spec('//elsewhere.test/register')] },
    { cases: [spec('/register-strong', { method: 'GET' })] },
  ];
  for (const settings of invalid) {
    const result = await run(settings);
    assert.equal(result.status, 'errored', JSON.stringify(settings));
    assert.equal(calls.length, 0, `no request before preflight completes: ${JSON.stringify(settings)}`);
  }
});

test('Generated strong passwords have the requested length and all character classes', () => {
  for (const length of [11, 24, 64]) {
    const p = strongPassword(length);
    assert.equal(p.length, length);
    assert.ok(/[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p));
    assert.notEqual(p, strongPassword(length));
  }
});
