import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import type { QaPlugin, RouteInfo } from '../src/core/types.js';
import { HttpClient, binaryKind, redactPersonalData, responseEvidence, sanitizeEvidenceText } from '../src/core/http.js';
import { AuthProvider } from '../src/core/auth.js';
import { runPlugins, DEFAULT_REMEDIATION } from '../src/core/runner.js';
import { apiAuthPlugin, remediationFor } from '../src/plugins/api-auth.js';

/** A minimal .xlsx-like ZIP: local file header, then the parts an Excel file starts with. */
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]), Buffer.from('\u0000\u0000[Content_Types].xml\u0001\u0002\u0003xl/workbook.xmlÿþ', 'latin1'), Buffer.alloc(200, 7)]);
const CUSTOMERS_CSV = 'name,email,phone\nAyesha,ayesha@example.test,03001234567\nBilal,bilal@example.test,+92 321 7654321\n';
let url = '', base: RunContext;
const server = http.createServer((req, res) => {
  const path = new URL(req.url!, 'http://x').pathname;
  if (path === '/api/v1/report-analytics/customer/export') {
    res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }); res.end(XLSX); return;
  }
  if (path === '/api/v1/report-analytics/customer/export-octet') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(XLSX); return; }
  if (path === '/api/v1/report-analytics/customer/csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="customers 2026.csv"' }); res.end(CUSTOMERS_CSV); return;
  }
  if (path === '/api/v1/customers/list') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: '64b7f0c2a1b2c3d4e5f60718', email: 'ayesha@example.test', phone: '03001234567', cnic: '35202-1234567-1', createdAt: 1731744000000 }] })); return; }
  res.writeHead(404); res.end();
});
before(async () => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { config } = await loadConfig('test/fixture.config.ts', {});
  config.target.baseUrl = url; config.target.requestsPerMinute = 60000;
  config.accounts = {}; config.publicRoutes = [];
  base = { config, configDir: process.cwd(), outDir: 'qa-out', suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, log: { info() {}, warn() {}, debug() {} } };
});
after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });

const route = (apiPath: string, line: number): RouteInfo => ({ method: 'GET', path: `/api/v1${apiPath}`, apiPath, module: 'analytics', authRequired: false, roles: [], multipart: false, middlewares: [], source: { file: 'src/app/modules/analytics/analytics.route.ts', line }, order: 0, routerFile: 'src/app/modules/analytics/analytics.route.ts' });
async function runApiAuth(routes: RouteInfo[]) {
  const client = new HttpClient(url, 60000, 2000);
  return (await runPlugins([apiAuthPlugin as QaPlugin], { ...base, targetRoutes: routes, routes, http: client, auth: new AuthProvider(base.config, client) }))[0];
}

test('An unauthenticated Excel export is reported with a readable description, not raw bytes, and a concrete fix', async () => {
  const result = await runApiAuth([route('/report-analytics/customer/export', 49), route('/report-analytics/customer/export-octet', 50), route('/report-analytics/customer/csv', 55), route('/customers/list', 60)]);
  assert.equal(result.findings.length, 4);
  const byPath = Object.fromEntries(result.findings.map(f => [f.target, f]));
  const xlsx = byPath['GET /report-analytics/customer/export'];
  assert.equal(xlsx.severity, 'critical');
  assert.match(xlsx.evidence!.responseSnippet!, /^\[Binary response not shown: Excel workbook \(\.xlsx\), 2\d\d bytes, application\/vnd\.openxmlformats/);
  assert.match(xlsx.remediation!, /authentication middleware.*src\/app\/modules\/analytics\/analytics\.route\.ts:49/);
  assert.match(byPath['GET /report-analytics/customer/export-octet'].evidence!.responseSnippet!, /Excel workbook/, 'detected from the bytes even with a generic content type');
  const csv = byPath['GET /report-analytics/customer/csv'].evidence!.responseSnippet!;
  assert.match(csv, /^\[File download not shown: customers_2026\.csv, \d+ bytes, text\/csv\./);
  const json = byPath['GET /customers/list'].evidence!.responseSnippet!;
  assert.ok(json.includes('<email>') && json.includes('<phone>') && json.includes('<id-number>'), json);
  assert.ok(json.includes('64b7f0c2a1b2c3d4e5f60718') && json.includes('1731744000000'), 'ids and timestamps stay readable');
  const text = JSON.stringify(result);
  for (const leaked of ['PK\u0003\u0004', '[Content_Types]', 'ayesha@example.test', '03001234567', '7654321', '35202-1234567-1', 'Bilal']) assert.ok(!text.includes(leaked), `leaked: ${JSON.stringify(leaked)}`);
});

test('Binary detection recognises common file types and leaves text alone', () => {
  const gz = zlib.gzipSync('hello');
  const cases: Array<[Buffer, string | null, string | undefined]> = [
    [XLSX, null, 'Excel workbook (.xlsx)'],
    [Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml')]), null, 'Word document (.docx)'],
    [Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('other.txt')]), null, 'ZIP archive'],
    [Buffer.from('%PDF-1.7\n...'), null, 'PDF document'],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), null, 'PNG image'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), null, 'JPEG image'],
    [gz, null, 'gzip archive'],
    [Buffer.from('anything'), 'image/webp', 'image/webp'],
    [Buffer.from('anything'), 'application/octet-stream', 'application/octet-stream'],
    [Buffer.from(Array.from({ length: 300 }, (_, i) => i % 32)), null, 'binary data'],
    [Buffer.from('{"ok":true,"name":"Ayesha"}'), 'application/json', undefined],
    [Buffer.from('<html><body>Bienvenue — مرحبا</body></html>'), 'text/html; charset=utf-8', undefined],
    [Buffer.from('{"data":[]}'), 'application/vnd.api+json', undefined],
    [Buffer.alloc(0), null, undefined],
  ];
  for (const [body, ct, expected] of cases) assert.equal(binaryKind(body, ct), expected, `${ct} ${body.subarray(0, 8).toString('hex')}`);
});

test('Redaction removes emails, phones, ID and card numbers and tokens but keeps ids, dates and status codes', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const out = redactPersonalData(`email a.b+c@mail.example.pk phone 0300-1234567 / +923001234567 cnic 35202-1234567-1 card 4111111111111111 token Bearer ${jwt} id 64b7f0c2a1b2c3d4e5f60718 ts 1731744000000 status 200 date 2026-11-16 amount 1500.50`);
  assert.equal(out, 'email <email> phone <phone> / <phone> cnic <id-number> card <number> token <token> id 64b7f0c2a1b2c3d4e5f60718 ts 1731744000000 status 200 date 2026-11-16 amount 1500.50');
});

test('The runner sanitises evidence from any plugin and fills per-check remediation', async () => {
  const raw = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 1)]).toString('latin1');
  const plugin: QaPlugin = { name: 'tenant-isolation', layer: 'api', description: 'test', async run() {
    return [
      { plugin: 'tenant-isolation', severity: 'high', category: 'security', target: 'GET /a', title: 'raw binary', evidence: { responseSnippet: raw } },
      { plugin: 'tenant-isolation', severity: 'high', category: 'security', target: 'GET /b', title: 'pii', evidence: { responseSnippet: 'owner ayesha@example.test 03001234567' } },
      { plugin: 'tenant-isolation', severity: 'low', category: 'quality', target: 'GET /c', title: 'own fix', remediation: 'Specific fix from the plugin.' },
    ];
  } };
  const result = (await runPlugins([plugin], base))[0];
  assert.match(result.findings[0].evidence!.responseSnippet!, /^\[Binary response not shown/);
  assert.equal(result.findings[1].evidence!.responseSnippet, 'owner <email> <phone>');
  assert.equal(result.findings[0].remediation, DEFAULT_REMEDIATION['tenant-isolation']);
  assert.equal(result.findings[2].remediation, 'Specific fix from the plugin.');
  assert.equal(sanitizeEvidenceText('x'.repeat(5000)).length, 1001, 'evidence is capped');
  // A check without a default keeps the generic fallback.
  const other: QaPlugin = { ...plugin, name: 'custom-check', async run() { return [{ plugin: 'custom-check', severity: 'low', category: 'quality', target: 't', title: 'x' }]; } };
  assert.match((await runPlugins([other], base))[0].findings[0].remediation!, /^Review the evidence/);
});

test('Every api-auth finding type gets a specific remediation naming the source line', () => {
  const r = route('/report-analytics/customer/export', 49);
  for (const title of ['Confirmed live: route answers without any token', 'Auth bypass: protected route answered 2xx without a token', 'Auth bypass: route accepts a malformed JWT',
    'Role bypass: USER account got 2xx on a route limited to SUPER_ADMIN', 'Server error (500) on a malformed token', 'Expected 401 without a token, got 400']) {
    const fix = remediationFor(title, r);
    assert.ok(!fix.startsWith('Review the evidence') && fix.includes('analytics.route.ts:49'), `${title}: ${fix}`);
  }
  assert.match(remediationFor('Confirmed live: route answers without any token', r), /publicRoutes/);
  // Text responses still show a short, readable snippet.
  assert.equal(responseEvidence({ text: '{"ok":true}', headers: new Headers({ 'content-type': 'application/json' }) }), '{"ok":true}');
});

test('Bounded browser waits return the value, or undefined on timeout or error, without unhandled rejections', async () => {
  const { bounded } = await import('../src/web/browser-options.js');
  let unhandled = 0; const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.equal(await bounded(Promise.resolve(7), 1000), 7);
    const started = Date.now();
    assert.equal(await bounded(new Promise(() => {}), 50), undefined);
    assert.ok(Date.now() - started < 1000, 'a hanging operation is abandoned after the bound');
    assert.equal(await bounded(Promise.reject(new Error('boom')), 1000), undefined);
    assert.equal(await bounded(new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 80)), 20), undefined);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(unhandled, 0);
  } finally { process.off('unhandledRejection', onUnhandled); }
});
