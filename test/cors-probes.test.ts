/**
 * CORS origin-check bypass probes in health-cors, against real HTTP servers whose origin
 * checks are written the way real backends get them wrong (including the MLITech pattern
 * found during real-project acceptance) and the way they get them right.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { loadConfig } from '../src/core/config.js';
import type { RunContext } from '../src/core/context.js';
import { HttpClient } from '../src/core/http.js';
import type { Finding } from '../src/core/types.js';
import { bypassOrigins, healthCorsPlugin } from '../src/plugins/health-cors.js';

type Check = (origin: string) => boolean;
interface Server { url: string; close: () => Promise<void> }

function serve(accepts: Check, credentials = true, onBlocked: 'omit' | 'error' = 'omit'): Promise<Server> {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!accepts(origin)) {
        if (onBlocked === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"message":"Origin not allowed by CORS"}'); return; }
      } else {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'Origin');
        if (credentials) res.setHeader('access-control-allow-credentials', 'true');
        res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type,authorization');
      }
    }
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((r) => server.close(() => r())),
  })));
}

let base: RunContext;
before(async () => {
  const { config } = await loadConfig('test/fixture.config.ts', {});
  base = { config, configDir: path.resolve('test'), outDir: path.resolve('qa-out'), suite: 'local', routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false, openapiPath: '', log: { info() {}, warn() {}, debug() {} } } as RunContext;
});

const servers: Server[] = [];
after(async () => { await Promise.all(servers.map((s) => s.close())); });

async function run(accepts: Check, allowedOrigins: string[], opts: { credentials?: boolean; onBlocked?: 'omit' | 'error' } = {}) {
  const s = await serve(accepts, opts.credentials ?? true, opts.onBlocked);
  servers.push(s);
  const config = structuredClone(base.config);
  config.target.baseUrl = s.url;
  config.cors = { ...config.cors, allowedOrigins, probeOrigin: 'https://qa-evil-origin.example' };
  const out = await healthCorsPlugin.run({ ...base, config, http: new HttpClient(s.url, 60000, 5000) } as RunContext);
  const findings = (Array.isArray(out) ? out : out.findings) as Finding[];
  return findings.filter((f) => f.target.startsWith('CORS'));
}
const titles = (fs: Finding[]) => fs.map((f) => `${f.severity} ${f.title} @ ${f.target}`).sort();

test('Probe origins are ones an attacker could own', () => {
  const probes = bypassOrigins(['https://app.example.com', 'http://localhost:5173', 'http://10.0.0.5:3000', 'not a url', 'ftp://files.example.com']).map((p) => p.origin);
  assert.deepEqual(probes.sort(), [
    'http://app.example.com',                              // downgrade of the https origin
    'https://app.example.com.qa-evil-origin.example',      // startsWith bypass
    'https://qa-evilapp.example.com',                      // endsWith / includes bypass
  ].sort(), 'no port-in-host, single-label or IP look-alikes, nothing for invalid or non-web origins');
  assert.deepEqual(bypassOrigins(['https://app.example.com', 'http://app.example.com']).map((p) => p.origin).includes('http://app.example.com'), false,
    'an origin the project allows on purpose is not reported as a bypass');
});

test('An exact allow-list passes: no bypass is reported and the allowed origin works', async () => {
  const allowed = ['https://admin.example.com', 'http://localhost:5173'];
  const findings = await run((o) => allowed.includes(o), allowed);
  assert.deepEqual(titles(findings), []);
});

test('MLITech pattern: any *.vercel.app containing the project name is trusted with credentials', async () => {
  const allowed = ['https://rewaldo-admin.vercel.app'];
  // Copied from the real backend's CORS callback (src/app.ts).
  const accepts = (o: string) => allowed.includes(o) || (o.endsWith('.vercel.app') && (o.includes('rewaldo-admin') || o.includes('rewaldo-business')));
  const findings = await run(accepts, allowed);
  assert.deepEqual(titles(findings), [
    'high CORS origin check can be bypassed @ CORS https://qa-evilrewaldo-admin.vercel.app',
    'low CORS trusts the plain-HTTP version of an allowed origin @ CORS http://rewaldo-admin.vercel.app',
  ]);
  assert.match(findings.find((f) => f.severity === 'high')!.detail!, /with Access-Control-Allow-Credentials: true/);
});

test('startsWith, unanchored patterns and null are each detected; credentials decide the severity', async () => {
  const allowed = ['https://app.example.com'];
  const starts = await run((o) => o.startsWith('https://app.example.com'), allowed);
  assert.deepEqual(titles(starts), ['high CORS origin check can be bypassed @ CORS https://app.example.com.qa-evil-origin.example']);

  const unanchored = await run((o) => /https:\/\/app\.example\.com/.test(o), allowed, { credentials: false });
  assert.deepEqual(titles(unanchored), ['medium CORS origin check can be bypassed @ CORS https://app.example.com.qa-evil-origin.example'],
    'without credentials only non-cookie responses are exposed');

  const nullOrigin = await run((o) => allowed.includes(o) || o === 'null', allowed);
  assert.deepEqual(titles(nullOrigin), ['high CORS origin check can be bypassed @ CORS null']);
});

test('An API that trusts every origin is reported once, not once per probe', async () => {
  const findings = await run(() => true, ['https://app.example.com']);
  assert.deepEqual(titles(findings), ['high CORS allows an arbitrary origin @ CORS /api/v1/auth/login']);
});

test('A blocked origin answered with 500 keeps its own finding next to the bypass checks', async () => {
  const allowed = ['https://app.example.com'];
  const findings = await run((o) => allowed.includes(o), allowed, { onBlocked: 'error' });
  assert.deepEqual(titles(findings), ['low A disallowed origin gets HTTP 500 instead of a clean rejection @ CORS /api/v1/auth/login']);
});
