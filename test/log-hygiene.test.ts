import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { HttpClient } from '../src/core/http.js';
import { runPlugins } from '../src/core/runner.js';
import { injectCanary, logHygienePlugin, logHygieneSchema, scanLogText, scanSource } from '../src/plugins/expanded/log-hygiene.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriq-logs-'));
const backend = path.join(root, 'backend');
let base: RunContext;
const write = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };

before(async () => {
  write(backend, 'src/app/modules/auth/auth.controller.ts', `import { logger, errorLogger } from '../../../shared/logger';
export const login = async (req: any, res: any, user: any, token: string, password: string) => {
  logger.info(\`Login attempt \${req.body.email}\`);
  console.log(req.body);
  errorLogger.error('Login failed', { headers: req.headers });
  logger.info({ password });
  logger.debug('token: ' + user.accessToken);
  console.log(JSON.stringify(req.cookies));
  console.log(req);
  this.logger.warn('refresh', { refreshToken: user.refreshToken });
  // Safe calls below must not be reported.
  logger.info('Password reset email sent', { userId: user.id });
  logger.info(\`token length \${token.length}\`);
  logger.info({ password: '***' });
  console.log(mask(token));
  audit.log(password);
  logger.info('user', user.email, req.params.id);
};
`);
  write(backend, 'src/app.ts', `import morgan from 'morgan';\napp.use(morgan(':method :url :status :req[authorization]'));\napp.use(morgan('combined'));\n`);
  write(backend, 'src/app/modules/auth/auth.test.ts', `console.log(req.body);\n`);
  write(backend, 'web/src/Login.tsx', `export function Login({ token }: { token: string }) {
  console.log('session', token);
  return <div className="login">{token ? <span>ok</span> : null}</div>;
}
export const Reset = ({ password }: { password: string }) => <form onSubmit={() => console.log('reset', password)}><input /></form>;
`);
  write(backend, 'scripts/ci.ts', `for (const a of accounts) console.log(\`::add-mask::\${a.secret}\`);\nconsole.log('::add-mask::' + token);\n`);
  const { config } = await loadConfig('test/fixture.config.ts', {});
  config.backend.dir = backend;
  base = { config, configDir: root, outDir: path.join(root, 'out'), suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function check(settings: Record<string, unknown>, extra: Partial<RunContext> = {}, flags: { allowMutations?: boolean; disposable?: boolean; backendNone?: boolean } = {}) {
  const config = { ...structuredClone(base.config), pluginSettings: { 'log-hygiene': settings } };
  config.allowMutations = flags.allowMutations ?? false;
  config.disposable = flags.disposable ?? false;
  config.backend.none = flags.backendNone ?? false;
  return (await runPlugins([logHygienePlugin], { ...base, ...extra, config }))[0];
}

test('Source: logging calls that write bodies, headers, whole requests or password/token values are found; safe calls are not', async () => {
  const s = scanSource(backend);
  const got = s.hits.map((h) => `${h.kind} ${h.name} @${h.source.split(':')[1]}`).sort();
  assert.deepEqual(got, [
    'body req.body @4',
    'body req.body.email @3',
    'headers morgan :req[authorization] @2',
    'headers req.cookies @8',
    'headers req.headers @5',
    'request req @9',
    'sensitive password @5',
    'sensitive password @6',
    'sensitive refreshToken @10',
    'sensitive token @2',
    'sensitive user.accessToken @7',
  ]);
  assert.ok(s.hits.some((h) => h.source === 'web/src/Login.tsx:2'), 'TSX files are parsed as TSX and scanned');
  assert.ok(s.hits.some((h) => h.source === 'web/src/Login.tsx:5' && h.name === 'password'), 'code after JSX is read correctly');
  assert.ok(!s.hits.some((h) => h.source.startsWith('scripts/ci.ts')), 'GitHub ::add-mask:: commands mask values and are not logs');
  assert.ok(!s.hits.some((h) => h.source.includes('.test.')), 'test files are not scanned');

  const r = await check({ source: true });
  assert.equal(r.status, 'failed', r.reason);
  assert.deepEqual(r.findings.map((f) => [f.title, f.severity, f.confidence]), [
    ['Request bodies written to logs', 'high', 'medium'],
    ['Request headers or cookies written to logs', 'high', 'medium'],
    ['Whole request objects written to logs', 'high', 'medium'],
    ['Passwords or tokens passed to the logger', 'high', 'medium'],
  ]);
  assert.match(r.findings[0].detail ?? '', /src\/app\/modules\/auth\/auth\.controller\.ts:3 req\.body\.email/);
  assert.deepEqual(r.findings[0].cwe, ['CWE-532']);
  assert.equal((await check({ source: true }, {}, { backendNone: true })).status, 'skipped');
});

const LOG = [
  '{"level":"info","message":"login","body":{"email":"ali@mlitech.pk","password":"Hunter2024!"}}',      // 1 password, email
  '{"level":"error","message":"{\\"password\\":\\"S3cret-escaped\\"}"}',                                    // 2 escaped JSON
  'POST /api/v1/auth/login?password=QueryPass99&x=1 200',                                                 // 3 query string
  "{ email: 'qa@example.com', password: 'InspectPass1' }",                                                 // 4 util.inspect; example.com ignored
  'Invalid password: user not found',                                                                     // 5 message, not a value
  '{"password":"***","token":"[REDACTED]","otp":null}',                                                   // 6 masked
  'headers: {"authorization":"Bearer abcdefghijklmnopqrstuvwxyz0123456789"}',                             // 7 auth header
  'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', // 8 JWT
  '{"otp": 482913, "refresh_token":"rt_9f8e7d6c5b4a"}',                                                   // 9 numeric otp + token
  'connect mongodb://app:Pa55word@db.internal:27017/mlitech AKIAABCDEFGHIJKLMNOP',                       // 10 mongo creds + aws key
  'paid with 4111 1111 1111 1111 order 4111111111111112 at 1700000000000',                                // 11 one valid card
  'customer +92 300 1234567 cnic 35202-1234567-1 mail sara@gmail.com test@shop.test',                    // 12 phone, id, email (.test ignored)
].join('\n');

test('Log output: credentials, keys, cards and personal data are found by line, values are never reported', async () => {
  write(root, 'logs/app.log', LOG + '\n');
  const r = await check({ source: false, logs: 'logs/*.log' });
  assert.equal(r.status, 'failed', r.reason);
  const byTitle = Object.fromEntries(r.findings.map((f) => [f.title, f]));
  const lines = (title: string) => [...(byTitle[title]?.detail ?? '').matchAll(/app\.log:(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(lines('Passwords in log output'), [1, 2, 3, 4]);
  assert.deepEqual(lines('Tokens or secrets in log output'), [9, 9]);
  assert.deepEqual(lines('Authorization or cookie headers in log output'), [7]);
  assert.deepEqual(lines('JSON Web Tokens in log output'), [8]);
  assert.deepEqual(lines('MongoDB connection string with credentials in log output'), [10]);
  assert.deepEqual(lines('AWS access key id in log output'), [10]);
  assert.deepEqual(lines('Payment card numbers in log output'), [11]);
  assert.deepEqual(lines('Email addresses in log output'), [1, 12]);
  assert.deepEqual(lines('Phone numbers in log output'), [12]);
  assert.deepEqual(lines('National ID numbers in log output'), [12]);
  assert.equal(byTitle['Passwords in log output'].severity, 'critical');
  assert.equal(byTitle['Email addresses in log output'].severity, 'medium');
  assert.match(byTitle['Passwords in log output'].detail ?? '', /app\.log:1 \(11-character value\)/);
  assert.equal(r.findings[0].severity, 'critical', 'most severe first');
  const all = JSON.stringify(r.findings);
  for (const secret of ['Hunter2024', 'S3cret-escaped', 'QueryPass99', 'InspectPass1', 'abcdefghijklmnop', 'dozjgNry', '482913', 'rt_9f8e', 'Pa55word', 'AKIAABCD', '4111', '1234567', 'sara@', 'ali@']) {
    assert.ok(!all.includes(secret), `value ${secret} must not appear in findings`);
  }

  const quiet = await check({ source: false, logs: 'logs/app.log', pii: { emails: false, phones: false, idNumbers: false, cards: false } });
  assert.ok(!quiet.findings.some((f) => /Email|Phone|National ID|card/.test(f.title)));
  const domains = await check({ source: false, logs: 'logs/app.log', ignoreEmailDomains: ['mlitech.pk', 'gmail.com'] });
  assert.ok(!domains.findings.some((f) => f.title === 'Email addresses in log output'));

  write(root, 'logs/clean.log', '{"level":"info","message":"GET /health 200 3ms"}\n{"level":"info","userId":"65f0c1","route":"/api/v1/promotions","status":200}\n');
  assert.equal((await check({ source: false, logs: 'logs/clean.log' })).status, 'passed');
  assert.match((await check({ source: false, logs: 'logs/none-*.log' })).reason ?? '', /No log file matches logs\/none-\*\.log/);
});

test('scanLogText line numbers continue from an offset (used for lines written after the canary)', () => {
  const hits = scanLogText('ok\n{"password":"abcdef"}', '/x.log', logHygieneSchema.parse({ logs: 'x.log' }), 41);
  assert.deepEqual(hits.map((h) => [h.rule, h.line, h.length]), [['password-field', 42, 6]]);
});

// A tiny API that logs to a file in one of three ways.
async function api(mode: 'leaky' | 'safe' | 'silent' | 'rotate', logFile: string) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (mode === 'rotate') fs.writeFileSync(logFile, JSON.stringify({ body: JSON.parse(body || '{}') }) + '\n'); // log rotated: a new, shorter file
      if (mode === 'leaky') fs.appendFileSync(logFile, JSON.stringify({ level: 'info', msg: 'request', url: req.url, body: JSON.parse(body || '{}') }) + '\n');
      if (mode === 'safe') fs.appendFileSync(logFile, JSON.stringify({ level: 'info', msg: 'request', method: req.method, url: req.url }) + '\n');
      res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"success":false}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('Canary: a value sent to the API is searched for only in log lines written afterwards; silence is an error, not a pass', async () => {
  const canary = (log: string) => ({ source: false, canary: { path: '/api/v1/auth/login', json: { email: 'veriq-canary@example.invalid', password: '{{canary}}' }, logs: log, settleMs: 200 } });
  for (const [mode, expectStatus] of [['leaky', 'failed'], ['safe', 'passed'], ['silent', 'errored']] as const) {
    const log = `logs/${mode}.log`;
    write(root, log, mode === 'leaky' ? '{"old":"line with VeriqCanaryOld"}\n' : '');
    const { server, url } = await api(mode, path.join(root, log));
    try {
      const r = await check(canary(log), { http: new HttpClient(url, 600, 5000) }, { allowMutations: true, disposable: true });
      assert.equal(r.status, expectStatus, `${mode}: ${r.reason}`);
      if (mode === 'leaky') {
        assert.equal(r.findings[0].title, 'Value sent to the API was written to the logs');
        assert.equal(r.findings[0].severity, 'critical');
        assert.match(r.findings[0].detail ?? '', /sent in password \(response HTTP 401\) appeared in 1 new log line\(s\):\nlogs\/leaky\.log:2/);
        assert.doesNotMatch(JSON.stringify(r.findings), /VeriqCanary[0-9a-f]{24}/, 'the canary value itself is not reported');
      }
      if (mode === 'safe') assert.equal(r.stats?.canary, 'not found in new log lines');
      if (mode === 'silent') assert.match(r.reason ?? '', /No new log lines were written within 200 ms of the canary request \(HTTP 401\)/);
    } finally { server.close(); }
  }

  // The log was rotated during the request (the new file is shorter): it is read from the start.
  write(root, 'logs/rotate.log', 'old line '.repeat(200) + '\n');
  const rot = await api('rotate', path.join(root, 'logs/rotate.log'));
  try {
    const r = await check(canary('logs/rotate.log'), { http: new HttpClient(rot.url, 600, 5000) }, { allowMutations: true, disposable: true });
    assert.equal(r.status, 'failed', r.reason);
    assert.match(r.findings[0].detail ?? '', /logs\/rotate\.log:1$/);
  } finally { rot.server.close(); }

  // Not a disposable environment: the canary is not sent.
  write(root, 'logs/x.log', '');
  const notAllowed = await check(canary('logs/x.log'));
  assert.equal(notAllowed.status, 'skipped');
  assert.match(notAllowed.reason ?? '', /allowMutations AND disposable/);
  const withSource = await check({ ...canary('logs/x.log'), source: true });
  assert.equal(withSource.status, 'failed', 'the other parts still run');
  assert.match(String(withSource.stats?.canary), /^skipped: Requires allowMutations/);
});

test('Canary injection and settings validation', () => {
  const { json, fields } = injectCanary({ user: { password: '{{canary}}', note: 'x{{canary}}y' }, list: ['{{canary}}'], n: 1 }, 'C');
  assert.deepEqual(json, { user: { password: 'C', note: 'xCy' }, list: ['C'], n: 1 });
  assert.deepEqual(fields, ['user.password', 'user.note', 'list[0]']);
  const bad = (x: unknown) => assert.equal(logHygieneSchema.safeParse(x).success, false, JSON.stringify(x));
  bad({ source: false });
  bad({ logs: '/var/log/app.log' });
  bad({ logs: '../app.log' });
  bad({ canary: { path: '/login', json: { password: 'fixed' }, logs: 'a.log' } });
  bad({ canary: { method: 'GET', path: '/login', json: { password: '{{canary}}' }, logs: 'a.log' } });
  bad({ ignoreEmailDomains: ['bad domain'] });
  assert.equal(logHygieneSchema.safeParse({}).success, true);
});
