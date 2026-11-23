import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from 'node:https';
import { X509Certificate, createHash } from 'node:crypto';
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/core/config.js";
import type { RunContext } from "../src/core/context.js";
import { runPlugins } from "../src/core/runner.js";
import { EXPANDED_PLUGINS } from "../src/plugins/expanded/index.js";
import { flowsPlugin } from "../src/plugins/flows.js";
import { convertRecording } from "../src/core/record-flow.js";
import { startRecorderSession } from "../src/core/recorder-session.js";
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "../src/web/browser-options.js";
import { CLIENT_REDIRECT_PROBE_HOST } from "../src/plugins/expanded/client-redirect-check.js";
import { xssPayloads } from "../src/plugins/expanded/xss-payloads.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veriq-browser-"));
let url = "", base: RunContext, redirectCalls = 0, externalHits = 0, clientCalls = 0;
let storedMode = '', storedItems: string[] = [], storedSaves = 0;
let csrfMode = '', csrfState = 'initial', csrfAttacks = 0, csrfCookies = 0, csrfSubmittedTokens: string[] = [];
const csrfCert = fs.readFileSync('test/fixtures/csrf/cert.pem');
const csrfSpki = createHash('sha256').update(new X509Certificate(csrfCert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
const server = http.createServer((req, res) => {
  const target = new URL(req.url!, 'http://fixture.test');
  if (target.pathname.startsWith('/csrf-')) {
    const authenticated = req.headers.cookie?.includes('csrfSession=fixture');
    res.setHeader('content-type', 'text/html');
    if (target.pathname === '/csrf-login') { res.end('<form method="post" action="/csrf-session"><input type="email"><input type="password"><button type="submit">Login</button></form>'); return; }
    if (target.pathname === '/csrf-session') { res.setHeader('set-cookie', `csrfSession=fixture; Path=/; HttpOnly; Secure; SameSite=${csrfMode === 'lax' ? 'Lax' : 'None'}`); res.writeHead(303, { location: '/csrf-form' }); res.end(); return; }
    if (target.pathname === '/csrf-state') {
      res.setHeader('content-type', 'application/json');
      if (!authenticated && csrfMode !== 'public-state') { res.writeHead(401); res.end('{}'); return; }
      res.end(JSON.stringify({ value: csrfState })); return;
    }
    // CORS preflights never carry cookies, so they are answered before authentication.
    const corsMode = csrfMode === 'cors-open' || csrfMode === 'cors-auth-first';
    if (target.pathname === '/csrf-api' && req.method === 'OPTIONS') {
      if (!corsMode || req.headers.origin !== 'https://veriq-csrf.invalid') { res.writeHead(404); res.end(); return; }
      res.writeHead(204, { 'access-control-allow-origin': req.headers.origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'POST, PUT', 'access-control-allow-headers': 'content-type' }); res.end(); return;
    }
    // cors-open runs its CORS middleware before authentication; cors-auth-first does not.
    if (!authenticated) {
      if (target.pathname === '/csrf-api' && csrfMode === 'cors-open' && req.headers.origin) res.writeHead(401, { 'access-control-allow-origin': req.headers.origin, 'access-control-allow-credentials': 'true' });
      else res.writeHead(401);
      res.end(); return;
    }
    if (target.pathname === '/csrf-app') {
      res.setHeader('set-cookie', 'XSRF-TOKEN=fixture-token; Path=/; Secure; SameSite=None');
      res.end('<!doctype html><meta name="csrf-token" content="fixture-token"><h1>App</h1>'); return;
    }
    if (target.pathname === '/csrf-api') {
      const crossSite = req.headers.origin === 'https://veriq-csrf.invalid';
      const cors = (csrfMode === 'cors-open' || csrfMode === 'cors-auth-first') && crossSite ? { 'access-control-allow-origin': req.headers.origin!, 'access-control-allow-credentials': 'true' } : {};
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
        if (crossSite) { csrfAttacks++; if (req.headers.cookie?.includes('csrfSession=')) csrfCookies++; }
        const type = req.headers['content-type'] ?? '';
        let value: unknown;
        if (type.startsWith('application/x-www-form-urlencoded')) value = new URLSearchParams(body).get('value');
        else { try { value = JSON.parse(body).value; } catch { value = undefined; } }
        const tokenOk = req.headers['x-csrf-token'] === 'fixture-token' && type.startsWith('application/json');
        // Planted defects: JSON accepted regardless of content type, form bodies accepted, CORS-trusted JSON.
        const accepted = tokenOk
          || (['json-no-token', 'lax', 'third-party'].includes(csrfMode) && !type.startsWith('application/x-www-form-urlencoded') && value !== undefined)
          || (csrfMode === 'json-form' && type.startsWith('application/x-www-form-urlencoded'))
          || ((csrfMode === 'cors-open' || csrfMode === 'cors-auth-first') && type.startsWith('application/json'));
        if (!accepted) { res.writeHead(403, cors); res.end(); return; }
        if (csrfMode !== 'inert') csrfState = String(value);
        res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end('{}');
      }); return;
    }
    if (target.pathname === '/csrf-form') { res.end('<form id="change" method="post" action="/csrf-write"><input name="value"><input type="hidden" name="csrf" value="fixture-token"><button type="submit">Save</button></form>'); return; }
    if (target.pathname === '/csrf-write') {
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
        // Top-level GET navigations carry no Origin header; Fetch Metadata identifies them.
        const crossSite = req.headers.origin === 'https://veriq-csrf.invalid' || req.headers['sec-fetch-site'] === 'cross-site';
        if (crossSite) { csrfAttacks++; csrfCookies++; }
        if (req.method === 'GET') {
          if (csrfMode === 'get-mutation') { csrfState = target.searchParams.get('value') ?? ''; res.end('saved'); return; }
          res.writeHead(405); res.end(); return;
        }
        if (req.headers['content-type']?.startsWith('multipart/form-data')) {
          // Planted bug: the token check only runs for URL-encoded bodies.
          if (csrfMode === 'multipart-unchecked') { csrfState = /name="value"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? ''; res.end('saved'); return; }
          res.writeHead(403); res.end(); return;
        }
        const fields = new URLSearchParams(body);
        if (crossSite && fields.has('csrf')) csrfSubmittedTokens.push(fields.get('csrf')!);
        if (crossSite && csrfMode === 'server-error') { res.writeHead(500); res.end(); return; }
        if (crossSite && csrfMode === 'vulnerable') { csrfState = 'done'; res.writeHead(403); res.end(); return; }
        // Planted bug for presence-only: any non-empty token is accepted.
        if (csrfMode === 'presence-only' ? !fields.get('csrf') : fields.get('csrf') !== 'fixture-token') { res.writeHead(403); res.end(); return; }
        if (csrfMode !== 'inert') csrfState = fields.get('value')!;
        res.end('saved');
      }); return;
    }
  }
  if (target.pathname.startsWith('/stored-')) {
    res.setHeader('content-type', 'text/html');
    const html = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    if (target.pathname === '/stored-form') { res.end('<!doctype html><form id="post" method="post" action="/stored-save"><input name="author"><textarea name="body"></textarea><button type="submit">Post</button></form>'); return; }
    if (target.pathname === '/stored-save' && req.method === 'POST') {
      let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
        storedSaves++;
        const value = new URLSearchParams(raw).get('body') ?? '';
        if (storedMode === 'error') { res.writeHead(500); res.end(); return; }
        if (storedMode === 'reject-markup' && /[<>"'`$]/.test(value)) { res.writeHead(422); res.end('<p>Invalid characters</p>'); return; }
        if (storedMode !== 'inert') storedItems.push(value);
        res.writeHead(303, { location: '/stored-view' }); res.end();
      }); return;
    }
    if (target.pathname === '/stored-view') {
      const items = storedItems.map(v => {
        const text = `<span>${html(v)}</span>`;
        if (storedMode === 'vulnerable') return `<p>${v}</p>`;
        // Angle brackets escaped but quotes not, inside an attribute.
        if (storedMode === 'attr') return `${text}<input value="${v.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}">`;
        if (storedMode === 'script') return `${text}<script>var last='${v.replaceAll('<', '\\x3c')}';</script>`;
        if (storedMode === 'href') return `${text}<a href="${html(v)}">Profile link</a>`;
        return text;
      }).join('');
      const dependency = storedMode === 'external' ? '<script src="https://veriq-probe.invalid/comments.js"></script>' : '';
      res.end(`<!doctype html><h1 id="ready">Comments</h1>${dependency}${items}`); return;
    }
    res.writeHead(404); res.end(); return;
  }
  if (target.pathname === '/external-sentinel') { externalHits++; res.end('unexpected'); return; }
  if (target.pathname.startsWith('/client-')) {
    clientCalls++;
    res.setHeader('content-type', 'text/html');
    const value = target.searchParams.get('next') ?? '';
    const attr = value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const read = 'const n = new URLSearchParams(location.search).get("next") || "";';
    const sameOrigin = 'const u = new URL(n, location.origin); const ok = u.origin === location.origin && /^https?:$/.test(u.protocol);';
    const sentinel = url.replace('127.0.0.1', 'localhost') + '/external-sentinel';
    const scripts: Record<string, string> = {
      '/client-js-vulnerable': `${read} if (n) setTimeout(() => { location.href = n; }, 30);`,
      '/client-js-naive': `${read} if (n.startsWith("/") && !n.startsWith("//")) location.assign(n);`,
      '/client-js-safe': `${read} ${sameOrigin} if (ok) location.assign(u.pathname + u.search);`,
      '/client-js-fallback': `${read} ${sameOrigin} location.assign(ok ? u.pathname + u.search : "/client-done");`,
      '/client-js-sink': `${read} if (!/^(https?:)?\\/\\//i.test(n) && !n.startsWith("/\\\\")) location.assign(n);`,
      '/client-js-popup': `${read} if (n === "/client-done") location.assign(n); else window.open(n);`,
      '/client-js-sentinel': `${read} location.assign(n === "/client-done" ? n : ${JSON.stringify(sentinel)});`,
      '/client-js-dependency': `${read} ${sameOrigin} if (ok) location.assign(u.pathname + u.search);`,
      '/client-js-control-external': `location.assign("https://${CLIENT_REDIRECT_PROBE_HOST}/control");`,
      '/client-js-inert': '',
    };
    if (target.pathname === '/client-done') { res.end('<!doctype html><title>Done</title><h1>Safe destination</h1>'); return; }
    if (target.pathname === '/client-js-error') { res.writeHead(500); res.end(); return; }
    if (target.pathname === '/client-js-http') { res.writeHead(302, { location: '/client-done' }); res.end(); return; }
    if (target.pathname === '/client-meta-vulnerable') { res.end(`<!doctype html><head>${value ? `<meta http-equiv="refresh" content="0;url=${attr}">` : ''}</head><h1>Moving</h1>`); return; }
    if (target.pathname in scripts) {
      const dependency = target.pathname === '/client-js-dependency' ? '<script src="https://veriq-probe.invalid/lib.js"></script>' : '';
      res.end(`<!doctype html><title>Client redirect</title>${dependency}<h1>Continue</h1><script>${scripts[target.pathname]}</script>`); return;
    }
    res.writeHead(404); res.end(); return;
  }
  if (target.pathname.startsWith('/redirect-')) {
    redirectCalls++;
    if (target.pathname === '/redirect-done') { res.end('Safe destination'); return; }
    const value = target.searchParams.get('next') ?? '';
    if (target.pathname === '/redirect-inert') { res.end('No redirect'); return; }
    if (target.pathname === '/redirect-loop') { res.writeHead(302, { location: req.url! }); res.end(); return; }
    if (value === '/redirect-done') { res.writeHead(302, { location: value }); res.end(); return; }
    if (target.pathname === '/redirect-error') { res.writeHead(500); res.end(); return; }
    if (target.pathname === '/redirect-safe') { res.writeHead(400); res.end(); return; }
    if (target.pathname === '/redirect-relative' && !value.startsWith('//')) { res.writeHead(400); res.end(); return; }
    if (target.pathname === '/redirect-chain') { res.writeHead(302, { location: '/redirect-vulnerable?next=' + encodeURIComponent(value) }); res.end(); return; }
    const destination = target.pathname === '/redirect-sentinel' ? url.replace('127.0.0.1', 'localhost') + '/external-sentinel'
      : target.pathname === '/redirect-fallback' ? '/redirect-done' : value;
    res.writeHead(302, { location: destination }); res.end(); return;
  }
  if (target.pathname.startsWith('/xss-')) {
    res.setHeader('content-type', 'text/html');
    if (target.pathname === '/xss-csp') res.setHeader('content-security-policy', "script-src 'none'");
    const input = target.searchParams.get('input') ?? '';
    const escaped = input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const attrSafe = escaped.replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    const contexts: Record<string, string> = {
      // Angle brackets escaped but quotes not: only an event-attribute breakout works.
      '/xss-attr': `<input id="q" value="${escaped}">`,
      '/xss-attr-safe': `<input id="q" value="${attrSafe}">`,
      // Quotes not escaped inside a single-quoted script string; "<" is hex-escaped.
      '/xss-script': `<script>var q='${input.replaceAll('<', '\\x3c')}';</script>`,
      // Backtick and backslash escaped, but template interpolation is not.
      '/xss-template': `<script>var q=\`${input.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('<', '\\x3c')}\`;</script>`,
      '/xss-script-safe': `<script>var q=${JSON.stringify(input).replaceAll('<', '\\u003c')};</script>`,
      // Fully entity-encoded but unquoted: whitespace still ends the attribute value.
      '/xss-unquoted': `<input id="q" value=${attrSafe}>`,
      // Encoded correctly for the attribute, but any scheme is allowed in the URL.
      '/xss-href': `<a id="next" href="${attrSafe}">Continue</a>`,
      '/xss-iframe': `<iframe title="preview" src="${attrSafe}"></iframe>`,
      '/xss-href-safe': `<a id="next" href="${/^(https?:|\/(?!\/))/i.test(input) ? attrSafe : '#'}">Continue</a>`,
    };
    if (target.pathname in contexts) { res.end(`<html><body><h1 id="ready">Probe fixture</h1>${contexts[target.pathname]}</body></html>`); return; }
    res.end(`<html><body><h1 id="ready">Probe fixture</h1>${target.pathname === '/xss-external' ? '<script src="https://veriq-probe.invalid/sink.js"></script>' : target.pathname === '/xss-escaped' ? escaped : target.pathname === '/xss-dom' ? '<div id="sink"></div><script>document.querySelector("#sink").innerHTML=new URLSearchParams(location.search).get("input")</script>' : input}</body></html>`);
    return;
  }
  if (req.url === "/missing") { res.writeHead(404); res.end(); return; }
  if (req.url === "/tracker.js") { res.setHeader("content-type", "application/javascript"); res.end("/* inert fixture tracker */"); return; }
  const content = req.url === "/unsafe" ? `<script>localStorage.setItem('accessToken','fixture-only');throw new Error('fixture browser error')</script><div style="width:2400px">Overflow</div><img src="/missing" alt="fixture"><a href="/missing">Broken</a>`
    : req.url === "/form" ? '<form><label>Name<input name="name" required></label><button type="submit">Submit</button><p class="error" hidden>Invalid</p></form>'
    : req.url === "/privacy-probe" ? `<script src="${url.replace("127.0.0.1", "localhost")}/tracker.js"></script>` : "";
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><html lang="${req.url === "/rtl" ? "ar" : "en"}" dir="${req.url === "/rtl" ? "rtl" : "ltr"}"><head>${req.url !== "/unsafe" ? '<title>Fixture</title><meta name="description" content="Healthy fixture">' : ""}</head><body><h1>Fixture page</h1><a href="/privacy">Privacy</a>${content}</body></html>`);
});
const secureServer = https.createServer({ key: fs.readFileSync('test/fixtures/csrf/key.pem'), cert: csrfCert }, server.listeners('request')[0] as http.RequestListener);
before(async () => {
  await new Promise<void>(resolve => secureServer.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { config } = await loadConfig("test/fixture.config.ts", {});
  config.web.apps = [{ name: "fixture", baseUrl: url, loginPath: "/login", account: "none", seedRoutes: ["/"], excludePaths: [], maxPages: 5 }];
  config.allowMutations = true; config.disposable = true;
  base = { config, configDir: dir, outDir: dir, suite: "local", routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false,
    log: { info() {}, warn() {}, debug() {} } };
});
after(async () => { secureServer.closeAllConnections(); await new Promise<void>(resolve => secureServer.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); });
const page = (p: string) => ({ app: "fixture", path: p, public: true });
test("Recorder review page validates and saves through its actual browser UI", async () => {
  const output = path.join(dir, 'ui-recorded.mjs');
  const session = await startRecorderSession({ app: 'fixture', name: 'UI recording', baseUrl: url, output });
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const tab = await browser.newPage();
    await tab.goto(session.url);
    await tab.getByLabel('Recording source').fill(`import { test, expect } from '@playwright/test'; test('test', async ({ page }) => { await page.goto('${url}/'); await expect(page.getByRole('heading')).toHaveText('Fixture page'); });`);
    await tab.getByRole('button', { name: 'Validate and save' }).click();
    assert.equal((await session.done).saved, true);
    await tab.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
    assert.equal(await tab.getByLabel('Recording source').inputValue(), '');
    const flowDir = path.join(dir, 'ui-replay'); fs.mkdirSync(flowDir); fs.copyFileSync(output, path.join(flowDir, 'flow.mjs'));
    const ctx = { ...base, config: { ...base.config, flows: { ...base.config.flows, dir: flowDir } } };
    assert.equal((await runPlugins([flowsPlugin], ctx))[0].status, 'passed');
    const broken = convertRecording(`import { test, expect } from '@playwright/test'; test('test', async ({ page }) => { await page.goto('${url}/'); await expect(page.getByRole('heading')).toHaveText('Planted wrong heading'); });`, { app: 'fixture', name: 'Broken assertion', baseUrl: url });
    fs.writeFileSync(path.join(flowDir, 'broken.mjs'), broken.source);
    const result = (await runPlugins([flowsPlugin], ctx))[0];
    assert.equal(result.status, 'failed');
    assert.ok(result.findings.some(f => f.title.includes('Broken assertion') && f.title.includes('Recorded action 2')));
  } finally { session.cancel(); await browser.close(); }
});
test("Converted Playwright recording replays against a real browser fixture", async () => {
  const flowDir = path.join(dir, "converted"); fs.mkdirSync(flowDir);
  const recording = `import { test, expect } from '@playwright/test'; test('test', async ({ page }) => { await page.goto('${url}/form'); await page.locator('form').getByRole('textbox', { name: 'Name', exact: true }).fill('recorded-value'); await expect(page.getByRole('heading')).toHaveText('Fixture page'); await expect(page.getByRole('textbox')).not.toBeEmpty(); });`;
  const generated = convertRecording(recording, { app: 'fixture', name: 'Converted', baseUrl: url });
  fs.writeFileSync(path.join(flowDir, 'converted.mjs'), generated.source);
  const previous = process.env.QA_FLOW_INPUT_1;
  process.env.QA_FLOW_INPUT_1 = 'fixture-runtime-value';
  try {
    const ctx = { ...base, config: { ...base.config, flows: { ...base.config.flows, dir: flowDir } } };
    const result = (await runPlugins([flowsPlugin], ctx))[0];
    assert.equal(result.status, 'passed', result.reason);
    assert.equal(result.stats?.passed, 1);
    delete process.env.QA_FLOW_INPUT_1;
    const missing = (await runPlugins([flowsPlugin], ctx))[0];
    assert.equal(missing.status, 'failed');
    assert.ok(missing.findings.some(f => f.detail?.includes('Missing flow input')));
  } finally {
    if (previous === undefined) delete process.env.QA_FLOW_INPUT_1; else process.env.QA_FLOW_INPUT_1 = previous;
  }
});
test("Scripted flows replay in three engines with distinct evidence and preserve failures", async () => {
  const flowDir = path.join(dir, "replay");
  fs.mkdirSync(flowDir);
  fs.writeFileSync(path.join(flowDir, "healthy.mjs"), `export default { name: 'Healthy', app: 'fixture', writes: false, login: false, async run({page, see}) { await page.goto('/'); await see('Fixture page'); } };`);
  fs.writeFileSync(path.join(flowDir, "broken.mjs"), `export default { name: 'Broken', app: 'fixture', writes: false, login: false, async run({page, step}) { await page.goto('/'); await step('Verify business rule', () => { throw new Error('planted business defect'); }); } };`);
  const config = { ...base.config, flows: { ...base.config.flows, dir: flowDir, browsers: ["chromium", "firefox", "webkit"] as const } };
  const ctx = { ...base, config: { ...config, flows: { ...config.flows, browsers: [...config.flows.browsers] } } };
  const result = (await runPlugins([flowsPlugin], ctx))[0];
  assert.equal(result.status, "failed");
  assert.equal(result.stats?.passed, 3);
  assert.equal(result.stats?.failed, 3);
  assert.equal(result.findings.length, 3);
  assert.equal(new Set(result.findings.map((f) => f.evidence?.image)).size, 3);
  for (const engine of config.flows.browsers) assert.ok(result.findings.some((f) => f.target.includes(engine) && f.title.includes('Verify business rule')));
  const invalid = { ...ctx, config: { ...ctx.config, flows: { ...ctx.config.flows, browsers: [] } } };
  assert.equal((await runPlugins([flowsPlugin], invalid))[0].status, "errored");
});
async function run(name: string, value: unknown) {
  const ctx = { ...base, config: { ...base.config, pluginSettings: { [name]: value } } };
  const r = (await runPlugins([EXPANDED_PLUGINS.find((p) => p.name === name)!], ctx))[0];
  assert.notEqual(r.status, "errored", r.reason); return r;
}
test("Client security finds storage risk and leaves a fresh clean context alone", async () => {
  assert.equal((await run("web-client-security", { pages: [page("/")] })).findings.length, 0);
  assert.ok((await run("web-client-security", { pages: [page("/unsafe")] })).findings.some((f) => /localStorage/.test(f.title)));
});

test('Explicit XSS canary detects reflected and DOM execution while escaping and CSP prevent execution', async () => {
  for (const [route, vulnerable] of [['/xss-reflected', true], ['/xss-dom', true], ['/xss-escaped', false], ['/xss-csp', false]] as const) {
    const result = await run('web-client-security', { xssCases: [{ ...page(route), queryParam: 'input', readySelector: '#ready', observeMs: 100 }] });
    assert.equal(result.findings.some(f => f.cwe?.includes('CWE-79')), vulnerable, route);
    assert.ok(!JSON.stringify(result).includes('onerror='));
  }
});

test('XSS contexts detect attribute, script-string and template breakouts and accept safe encoding', async () => {
  const all = ['html', 'attribute', 'script', 'url'];
  const cases = [
    ['/xss-unquoted', { html: false, attribute: true, script: false, url: false }],
    ['/xss-href', { html: false, attribute: false, script: false, url: true }],
    ['/xss-iframe', { url: true }],
    ['/xss-href-safe', { html: false, attribute: false, script: false, url: false }],
    ['/xss-attr', { html: false, attribute: true, script: false }],
    ['/xss-attr-safe', { html: false, attribute: false, script: false }],
    ['/xss-script', { html: false, attribute: false, script: true }],
    ['/xss-template', { html: false, attribute: false, script: true }],
    ['/xss-script-safe', { html: false, attribute: false, script: false }],
    ['/xss-escaped', { html: false, attribute: false, script: false }],
    ['/xss-csp', { html: false, attribute: false, script: false }],
    ['/xss-reflected', { html: true }],
  ] as const;
  const titles = { html: 'Query input executed browser script', attribute: 'broke out of an HTML attribute', script: 'broke out of a script string', url: 'became a javascript: URL' };
  for (const [route, expected] of cases) {
    const result = await run('web-client-security', { xssCases: [{ ...page(route), queryParam: 'input', readySelector: '#ready', observeMs: 100, contexts: all }] });
    for (const [context, present] of Object.entries(expected)) {
      assert.equal(result.findings.some(f => f.title.includes(titles[context as keyof typeof titles])), present, `${route} ${context}`);
    }
    const text = JSON.stringify(result);
    assert.ok(!text.includes('onerror=') && !text.includes('onfocus=') && !text.includes('veriq_') && !text.includes('top.'), `${route}: payload omitted`);
  }
  // Default context remains HTML only, so existing configurations keep their meaning.
  const defaults = await run('web-client-security', { xssCases: [{ ...page('/xss-attr'), queryParam: 'input', readySelector: '#ready', observeMs: 100 }] });
  assert.equal(defaults.findings.length, 0);
});

test('Explicit XSS checks fail on missing readiness and require disposable authorization', async () => {
  const settings = { xssCases: [{ ...page('/xss-reflected'), queryParam: 'input', readySelector: '#missing', observeMs: 100 }] };
  const plugin = EXPANDED_PLUGINS.find(p => p.name === 'web-client-security')!;
  const configured = { ...base.config, pluginSettings: { 'web-client-security': settings } };
  assert.equal((await runPlugins([plugin], { ...base, config: configured }))[0].status, 'errored');
  const blocked = { ...base.config, pluginSettings: { 'web-client-security': { xssCases: [{ ...page('/xss-external'), queryParam: 'input', readySelector: '#ready', observeMs: 100 }] } } };
  const blockedResult = (await runPlugins([plugin], { ...base, config: blocked }))[0];
  assert.equal(blockedResult.status, 'errored');
  assert.ok(!JSON.stringify(blockedResult).includes('onerror='));
  for (const flags of [{ allowMutations: false }, { disposable: false }]) {
    assert.equal((await runPlugins([plugin], { ...base, config: { ...configured, ...flags } }))[0].status, 'skipped');
  }
});

test('HTTP redirect probes detect external targets and accept explicit rejection or safe fallback', async () => {
  for (const [route, vulnerable] of [['/redirect-vulnerable', true], ['/redirect-relative', true], ['/redirect-chain', true], ['/redirect-safe', false], ['/redirect-fallback', false], ['/redirect-sentinel', true]] as const) {
    const result = await run('web-client-security', { redirectCases: [{ ...page(route), queryParam: 'next', safePath: '/redirect-done' }] });
    assert.equal(result.findings.some(f => f.cwe?.includes('CWE-601')), vulnerable, route);
    assert.ok(!JSON.stringify(result).includes('veriq-redirect.invalid'));
  }
  assert.equal(externalHits, 0, 'External Location must never be followed, even to a reachable local sentinel');
});

test('HTTP redirect probes fail closed on inert controls, loops and server errors', async () => {
  const plugin = EXPANDED_PLUGINS.find(p => p.name === 'web-client-security')!;
  for (const route of ['/redirect-inert', '/redirect-loop', '/redirect-error']) {
    const config = { ...base.config, pluginSettings: { 'web-client-security': { redirectCases: [{ ...page(route), queryParam: 'next', safePath: '/redirect-done' }] } } };
    assert.equal((await runPlugins([plugin], { ...base, config }))[0].status, 'errored', route);
  }
});

test('HTTP redirect probes preflight all apps and require disposable authorization before requests', async () => {
  const plugin = EXPANDED_PLUGINS.find(p => p.name === 'web-client-security')!;
  const spec = { ...page('/redirect-safe'), queryParam: 'next', safePath: '/redirect-done' };
  const config = { ...base.config, pluginSettings: { 'web-client-security': { redirectCases: [spec] } } };
  redirectCalls = 0;
  for (const flags of [{ allowMutations: false }, { disposable: false }]) assert.equal((await runPlugins([plugin], { ...base, config: { ...config, ...flags } }))[0].status, 'skipped');
  const invalid = { ...config, pluginSettings: { 'web-client-security': { redirectCases: [spec, { ...spec, app: 'missing' }] } } };
  assert.equal((await runPlugins([plugin], { ...base, config: invalid }))[0].status, 'errored');
  assert.equal(redirectCalls, 0);
});

test('Client-side redirect probes detect script, meta-refresh, popup and javascript: navigation sinks', async () => {
  externalHits = 0;
  const cases = [
    ['/client-js-vulnerable', { 'CWE-601': true, 'CWE-79': true }],
    ['/client-meta-vulnerable', { 'CWE-601': true }],
    ['/client-js-naive', { 'CWE-601': true, 'CWE-79': false }],
    ['/client-js-sink', { 'CWE-601': false, 'CWE-79': true }],
    ['/client-js-popup', { 'CWE-601': true }],
    ['/client-js-sentinel', { 'CWE-601': true }],
    ['/client-js-safe', { 'CWE-601': false, 'CWE-79': false }],
    ['/client-js-fallback', { 'CWE-601': false, 'CWE-79': false }],
  ] as const;
  for (const [route, expected] of cases) {
    const result = await run('web-client-security', { clientRedirectCases: [{ ...page(route), queryParam: 'next', safePath: '/client-done', observeMs: 400 }] });
    for (const [cwe, present] of Object.entries(expected)) assert.equal(result.findings.some(f => f.cwe?.includes(cwe)), present, `${route} ${cwe}`);
    const text = JSON.stringify(result);
    // The titles name the sink ("javascript: navigation"); the payload itself must never appear
    assert.ok(!text.includes(CLIENT_REDIRECT_PROBE_HOST) && !text.includes('veriq_nav_') && !text.includes('void(window'), `${route}: payloads must not appear in results`);
  }
  assert.equal(externalHits, 0, 'An external navigation target must never be contacted, even a reachable local sentinel');
});

test('Client-side redirect probes fail closed on inert controls, errors, HTTP redirects, blocked dependencies and failed login', async () => {
  const plugin = EXPANDED_PLUGINS.find(p => p.name === 'web-client-security')!;
  for (const [route, extra] of [['/client-js-inert', {}], ['/client-js-error', {}], ['/client-js-http', {}], ['/client-js-dependency', {}], ['/client-js-control-external', {}], ['/client-js-safe', { public: false }]] as const) {
    const config = { ...base.config, pluginSettings: { 'web-client-security': { clientRedirectCases: [{ ...page(route), queryParam: 'next', safePath: '/client-done', observeMs: 300, ...extra }] } } };
    const started = Date.now();
    const result = (await runPlugins([plugin], { ...base, config }))[0];
    assert.equal(result.status, 'errored', route);
    // It must fail closed for its own reason, promptly: a hang that ends in the plugin timeout is a defect.
    assert.match(result.reason ?? '', /Client-side redirect probe incomplete/, route);
    assert.ok(Date.now() - started < 30000, `${route} took ${Date.now() - started} ms`);
    const text = JSON.stringify(result);
    assert.ok(!text.includes(CLIENT_REDIRECT_PROBE_HOST) && !text.includes('veriq_nav_') && !text.includes('void(window'), `${route}: no payload in the error`);
  }
});

test('Client-side redirect probes preflight all apps and require disposable authorization before any page load', async () => {
  const plugin = EXPANDED_PLUGINS.find(p => p.name === 'web-client-security')!;
  const spec = { ...page('/client-js-safe'), queryParam: 'next', safePath: '/client-done' };
  const config = { ...base.config, pluginSettings: { 'web-client-security': { clientRedirectCases: [spec] } } };
  clientCalls = 0;
  for (const flags of [{ allowMutations: false }, { disposable: false }]) assert.equal((await runPlugins([plugin], { ...base, config: { ...config, ...flags } }))[0].status, 'skipped');
  const invalid = { ...config, pluginSettings: { 'web-client-security': { clientRedirectCases: [spec, { ...spec, app: 'missing' }] } } };
  assert.equal((await runPlugins([plugin], { ...base, config: invalid }))[0].status, 'errored');
  for (const bad of [{ observeMs: 20000 }, { safePath: '/client-done?x=1' }, { queryParam: '1bad' }, { path: '//elsewhere.test/x' }]) {
    const wrong = { ...config, pluginSettings: { 'web-client-security': { clientRedirectCases: [{ ...spec, ...bad }] } } };
    assert.equal((await runPlugins([plugin], { ...base, config: wrong }))[0].status, 'errored', JSON.stringify(bad));
  }
  assert.equal(clientCalls, 0);
});

const storedCase = (extra: Record<string, unknown> = {}) => ({ app: 'fixture', public: true, formPath: '/stored-form', formSelector: '#post', submitSelector: 'button',
  payloadField: 'body', fields: { author: 'QA' }, viewPath: '/stored-view', readySelector: '#ready', observeMs: 300, ...extra });
async function stored(mode: string, extra: Record<string, unknown> = {}, flags: Record<string, unknown> = {}) {
  storedMode = mode; storedItems = []; storedSaves = 0;
  const config = { ...base.config, ...flags, pluginSettings: { 'web-client-security': { storedXssCases: [storedCase(extra)] } } };
  return (await runPlugins([EXPANDED_PLUGINS.find(p => p.name === 'web-client-security')!], { ...base, config }))[0];
}
function assertStoredQuiet(result: unknown, label: string) {
  const text = JSON.stringify(result);
  assert.ok(!['onerror=', 'onfocus=', 'veriq_', 'veriq-control'].some(v => text.includes(v)), `${label}: payload or control text leaked`);
}

test('Stored XSS workflow detects execution on the view page in each context after a displayed control', async () => {
  const html = await stored('vulnerable');
  assert.equal(html.status, 'failed', html.reason);
  assert.deepEqual(html.findings.map(f => f.title), ['Stored input executed browser script on the view page']);
  assert.equal(storedSaves, 2, 'control then the first HTML payload');
  assertStoredQuiet(html, 'vulnerable');
  for (const [mode, contexts, title] of [['attr', ['html', 'attribute'], 'HTML attribute'], ['script', ['html', 'script'], 'script string'], ['href', ['html', 'url'], 'javascript: URL']] as const) {
    const result = await stored(mode, { contexts });
    assert.equal(result.status, 'failed', `${mode}: ${result.reason}`);
    assert.equal(result.findings.length, 1);
    assert.ok(result.findings[0].title.includes(title) && result.findings[0].cwe?.includes('CWE-79'), mode);
    assertStoredQuiet(result, mode);
  }
});

test('Stored XSS workflow accepts escaping and input rejection after trying every payload', async () => {
  const contexts = ['html', 'attribute', 'script', 'url'] as const;
  const payloadCount = contexts.reduce((n, c) => n + xssPayloads(c, 'm').length, 0);
  for (const mode of ['escaped', 'reject-markup']) {
    const result = await stored(mode, { contexts });
    assert.equal(result.status, 'passed', `${mode}: ${result.reason}`);
    assert.equal(storedSaves, 1 + payloadCount, `${mode}: control plus every payload submitted`);
    assertStoredQuiet(result, mode);
  }
});

test('Stored XSS workflow fails closed on undisplayed controls, server errors, blocked dependencies, bad selectors and login', async () => {
  for (const [mode, extra] of [['inert', {}], ['error', {}], ['external', {}], ['escaped', { formSelector: '#missing' }], ['escaped', { readySelector: '#absent' }], ['escaped', { public: false }]] as const) {
    const result = await stored(mode, extra);
    assert.equal(result.status, 'errored', `${mode} ${JSON.stringify(extra)}`);
    assertStoredQuiet(result, mode);
  }
  // A control that is never displayed stops the case before any payload is stored.
  await stored('inert'); assert.equal(storedSaves, 1);
});

test('Stored XSS workflow requires disposable authorization and validates settings before submitting', async () => {
  for (const flags of [{ allowMutations: false }, { disposable: false }]) {
    assert.equal((await stored('vulnerable', {}, flags)).status, 'skipped');
    assert.equal(storedSaves, 0);
  }
  for (const extra of [{ app: 'missing' }, { fields: { body: 'x' } }, { contexts: ['html', 'html'] }, { viewPath: '//elsewhere.test/view' }, { observeMs: 50 }]) {
    assert.equal((await stored('vulnerable', extra)).status, 'errored', JSON.stringify(extra));
    assert.equal(storedSaves, 0, JSON.stringify(extra));
  }
});

async function jsonCsrf(mode: string, extra: Record<string, unknown> = {}, flags: Record<string, unknown> = {}, chromiumArgs = '') {
  csrfMode = mode; csrfState = 'initial'; csrfAttacks = 0; csrfCookies = 0;
  const config = structuredClone(base.config);
  config.accounts = { csrf: { identifier: 'qa@example.test', password: 'fixture-password', role: 'USER', device: 'web' } };
  config.web.apps[0].loginPath = '/csrf-login'; config.web.apps[0].account = 'csrf';
  config.web.apps[0].baseUrl = `https://127.0.0.1:${(secureServer.address() as AddressInfo).port}`;
  config.pluginSettings = { 'web-client-security': { jsonCsrfCases: [{ app: 'fixture', appPath: '/csrf-app', actionPath: '/csrf-api', json: { value: 'done' },
    csrfHeader: { name: 'x-csrf-token', from: 'meta', key: 'csrf-token' }, verifyPath: '/csrf-state', valuePath: 'value', expectedValue: 'done', observeMs: 150, ...extra }] } };
  Object.assign(config, flags);
  const priorArgs = process.env.QA_CHROMIUM_ARGS, priorCa = process.env.QA_PROBE_CA_FILE;
  process.env.QA_CHROMIUM_ARGS = `${priorArgs ?? ''} --ignore-certificate-errors-spki-list=${csrfSpki} ${chromiumArgs}`.trim();
  // The Node-side CORS preflight probe trusts this disposable fixture certificate in addition to system roots.
  process.env.QA_PROBE_CA_FILE = 'test/fixtures/csrf/cert.pem';
  try { return (await runPlugins([EXPANDED_PLUGINS.find(p => p.name === 'web-client-security')!], { ...base, config }))[0]; }
  finally {
    if (priorArgs === undefined) delete process.env.QA_CHROMIUM_ARGS; else process.env.QA_CHROMIUM_ARGS = priorArgs;
    if (priorCa === undefined) delete process.env.QA_PROBE_CA_FILE; else process.env.QA_PROBE_CA_FILE = priorCa;
  }
}
/**
 * The fixture is on loopback while the synthetic attacker page counts as public, so
 * Chromium's Private Network Access blocks cross-site fetches to it. These test-only
 * flags emulate a publicly reachable target; a test below proves the check reports the
 * blocked case as inconclusive instead of passing.
 */
const PUBLIC_TARGET = '--disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests,LocalNetworkAccessChecks';
test('JSON CSRF accepts a token-protected endpoint and detects text/plain, form and CORS bypasses', async () => {
  const allVariants = { variants: ['text-plain', 'form', 'cors-json'] };
  for (const header of [{ name: 'x-csrf-token', from: 'meta', key: 'csrf-token' }, { name: 'x-csrf-token', from: 'cookie', key: 'XSRF-TOKEN' }]) {
    const healthy = await jsonCsrf('healthy', { ...allVariants, csrfHeader: header }, {}, PUBLIC_TARGET);
    assert.equal(healthy.status, 'passed', healthy.reason);
    assert.equal(csrfAttacks, 2, 'text-plain and form reached the endpoint; CORS refused the JSON preflight');
    assert.equal(csrfCookies, 2, 'the attacks carried the SameSite=None session cookie');
    assert.equal(csrfState, 'done', 'the legitimate JSON request with the CSRF header ran');
  }
  for (const [mode, extra, title] of [
    ['json-no-token', allVariants, 'text/plain JSON'],
    ['json-form', allVariants, 'form POST to a JSON endpoint'],
    ['cors-open', allVariants, 'allowed by CORS'],
    ['cors-open', { method: 'PUT', variants: ['cors-json'] }, 'allowed by CORS'],
  ] as const) {
    const result = await jsonCsrf(mode, extra, {}, PUBLIC_TARGET);
    assert.equal(result.status, 'failed', `${mode}: ${result.reason}`);
    assert.equal(result.findings.length, 1);
    assert.ok(result.findings[0].title.includes(title) && result.findings[0].cwe?.includes('CWE-352'), mode);
    assert.ok(!JSON.stringify(result).includes('fixture-token'), `${mode}: token omitted`);
  }
  // SameSite=Lax withholds the session cookie from cross-site fetches: a real defense, not a gap.
  const lax = await jsonCsrf('lax', { ...allVariants }, {}, PUBLIC_TARGET);
  assert.equal(lax.status, 'passed', lax.reason); assert.equal(csrfCookies, 0);
});

test('JSON CSRF fails closed on missing tokens, inert controls, public state, rejected controls and withheld cookies', async () => {
  for (const [mode, extra] of [
    ['healthy', { csrfHeader: { name: 'x-csrf-token', from: 'meta', key: 'missing-token' } }],
    ['healthy', { csrfHeader: undefined }],
    ['inert', {}],
    ['public-state', {}],
    ['healthy', { appPath: '/csrf-missing' }],
  ] as const) {
    const result = await jsonCsrf(mode, extra);
    assert.equal(result.status, 'errored', `${mode} ${JSON.stringify(extra)}`);
    assert.ok(!JSON.stringify(result).includes('fixture-token'));
  }
  // A test browser that blocks third-party cookies cannot show the defect: inconclusive, not passed.
  const withheld = await jsonCsrf('cors-open', { variants: ['cors-json'] }, {}, `${PUBLIC_TARGET} --test-third-party-cookie-phaseout`);
  assert.equal(withheld.status, 'errored', `withheld SameSite=None cookies must not pass (cookies sent: ${csrfCookies})`);
  assert.match(withheld.reason ?? '', /withheld cookies for reasons outside the application/);
  assert.equal(csrfCookies, 0);
  // The same holds when the 401 carries no CORS headers and the page cannot read it.
  const unreadable = await jsonCsrf('cors-auth-first', { variants: ['cors-json'] }, {}, `${PUBLIC_TARGET} --test-third-party-cookie-phaseout`);
  assert.equal(unreadable.status, 'errored', 'an unreadable attack response must not pass');
  assert.match(unreadable.reason ?? '', /withheld cookies for reasons outside the application/);
  // With Private Network Access active, the CORS-allowed request never reaches the loopback target.
  const pna = await jsonCsrf('cors-open', { variants: ['cors-json'] });
  assert.equal(pna.status, 'errored', 'a blocked attack must not pass');
  assert.match(pna.reason ?? '', /not delivered \(LocalNetworkAccessPermissionDenied\)/);
  assert.equal(csrfAttacks, 0, 'the request was blocked before reaching the fixture');
  // A CORS-only defense: the preflight refuses the attacker origin, so no request is sent and no gap is reported.
  const corsOnly = await jsonCsrf('json-no-token', { variants: ['cors-json'] }, {}, PUBLIC_TARGET);
  assert.equal(corsOnly.status, 'passed', corsOnly.reason); assert.equal(csrfAttacks, 0);
});

test('JSON CSRF settings are preflighted and require disposable authorization', async () => {
  for (const flags of [{ disposable: false }, { allowMutations: false }]) assert.equal((await jsonCsrf('healthy', {}, flags)).status, 'skipped');
  for (const extra of [{ method: 'PUT' }, { csrfHeader: { name: 'cookie', from: 'meta', key: 'k' } }, { variants: ['form', 'form'] }, { json: {} }, { app: 'missing' }, { actionPath: '//evil.test/api' }]) {
    const result = await jsonCsrf('healthy', extra);
    assert.equal(result.status, 'errored', JSON.stringify(extra));
    assert.equal(csrfAttacks, 0, JSON.stringify(extra));
  }
});

async function csrf(mode: string, flags = {}, extra: Record<string, unknown> = {}) {
  csrfMode = mode; csrfState = 'initial'; csrfAttacks = 0; csrfCookies = 0; csrfSubmittedTokens = [];
  const config = structuredClone(base.config);
  config.accounts = { csrf: { identifier: 'qa@example.test', password: 'fixture-password', role: 'USER', device: 'web' } };
  config.web.apps[0].loginPath = '/csrf-login'; config.web.apps[0].account = 'csrf';
  config.web.apps[0].baseUrl = `https://127.0.0.1:${(secureServer.address() as AddressInfo).port}`;
  config.pluginSettings = { 'web-client-security': { csrfCases: [{ app: 'fixture', formPath: '/csrf-form', actionPath: '/csrf-write',
    formSelector: '#change', submitSelector: 'button', fields: { value: 'done' }, verifyPath: '/csrf-state', valuePath: 'value', expectedValue: 'done', observeMs: 100, ...extra }] } };
  Object.assign(config, flags);
  const priorArgs = process.env.QA_CHROMIUM_ARGS;
  // Trust only this disposable fixture's public key, never all TLS certificates.
  process.env.QA_CHROMIUM_ARGS = `${priorArgs ?? ''} --ignore-certificate-errors-spki-list=${csrfSpki}`.trim();
  try { return (await runPlugins([EXPANDED_PLUGINS.find(p => p.name === 'web-client-security')!], { ...base, config }))[0]; }
  finally { if (priorArgs === undefined) delete process.env.QA_CHROMIUM_ARGS; else process.env.QA_CHROMIUM_ARGS = priorArgs; }
}
test('CSRF browser workflow verifies token defense and detects mutation even with a rejection status', async () => {
  const healthy = await csrf('healthy'); assert.equal(healthy.status, 'passed', healthy.reason);
  assert.equal(csrfAttacks, 1); assert.equal(csrfCookies, 1); assert.equal(csrfState, 'done');
  const bad = await csrf('vulnerable'); assert.equal(bad.status, 'failed', bad.reason);
  assert.ok(bad.findings.some(f => f.cwe?.includes('CWE-352')));
  assert.ok(!JSON.stringify(bad).includes('fixture-token'));
});
test('CSRF browser workflow respects SameSite and requires effective positive controls', async () => {
  const lax = await csrf('lax'); assert.equal(lax.status, 'passed', lax.reason); assert.equal(csrfCookies, 0); assert.equal(csrfState, 'done');
  for (const mode of ['inert', 'server-error', 'public-state']) assert.equal((await csrf(mode)).status, 'errored', mode);
});
test('CSRF variants detect presence-only token checks, multipart bypasses and GET mutations', async () => {
  const all = { variants: ['missing-token', 'forged-token', 'multipart', 'get'], tokenField: 'csrf' };
  const healthy = await csrf('healthy', {}, all);
  assert.equal(healthy.status, 'passed', healthy.reason);
  assert.equal(csrfAttacks, 4, 'every variant reached the server with the session cookie');
  assert.equal(csrfState, 'done', 'positive control still ran after all variants');
  assert.equal(csrfSubmittedTokens.length, 1);
  assert.equal(csrfSubmittedTokens[0].length, 'fixture-token'.length);
  assert.notEqual(csrfSubmittedTokens[0], 'fixture-token', 'the real token is never copied');

  // The missing-token variant alone cannot see a presence-only check; the forged token can.
  assert.equal((await csrf('presence-only')).status, 'passed');
  for (const [mode, variants, title] of [
    ['presence-only', ['missing-token', 'forged-token'], 'forged CSRF token'],
    ['multipart-unchecked', ['missing-token', 'multipart'], 'multipart form'],
    ['get-mutation', ['missing-token', 'get'], 'GET navigation'],
  ] as const) {
    const result = await csrf(mode, {}, { variants, ...(variants.includes('forged-token' as never) ? { tokenField: 'csrf' } : {}) });
    assert.equal(result.status, 'failed', `${mode}: ${result.reason}`);
    assert.equal(result.findings.length, 1);
    assert.ok(result.findings[0].title.includes(title) && result.findings[0].cwe?.includes('CWE-352'), mode);
    const text = JSON.stringify(result);
    assert.ok(!text.includes('fixture-token') && csrfSubmittedTokens.every(t => !text.includes(t)), `${mode}: no token in results`);
  }
  // SameSite=Lax blocks cross-site POSTs but not top-level GET navigations.
  const lax = await csrf('lax', {}, { variants: ['missing-token', 'get'] });
  assert.equal(lax.status, 'passed', lax.reason);
});

test('CSRF variant settings are preflighted and token fields are never copied', async () => {
  for (const extra of [{ variants: ['forged-token'] }, { tokenField: 'csrf' }, { variants: ['forged-token'], tokenField: 'value' },
    { variants: ['get', 'get'] }, { variants: ['forged-token'], tokenField: 'missing' }]) {
    const result = await csrf('healthy', {}, extra);
    assert.equal(result.status, 'errored', JSON.stringify(extra));
    assert.equal(csrfAttacks, 0, `no attack before preflight: ${JSON.stringify(extra)}`);
  }
});

test('CSRF browser workflow requires both disposable flags', async () => {
  for (const flags of [{ disposable: false }, { allowMutations: false }]) assert.equal((await csrf('healthy', flags)).status, 'skipped');
});
test("Forms recognize native invalid-input feedback without a false failure", async () => {
  assert.equal((await run("web-forms", { cases: [{ ...page("/form"), form: "form", fields: { "input[name=name]": "" }, submit: "button", errorSelector: ".error" }] })).findings.length, 0);
});
test("Cross-browser detects a blank/overflow/error regression and accepts healthy mobile layout", async () => {
  const options = { browsers: ["chromium", "firefox", "webkit"], viewports: [{ width: 390, height: 844 }] };
  assert.equal((await run("cross-browser", { ...options, pages: [page("/")] })).findings.length, 0);
  assert.equal((await run("cross-browser", { ...options, pages: [page("/unsafe")] })).findings.length, 3);
});
test("Links/SEO detects broken resources and missing metadata", async () => {
  assert.equal((await run("links-seo", { pages: [page("/")] })).findings.length, 0);
  assert.equal((await run("links-seo", { pages: [page("/unsafe")] })).findings.length, 3);
});
test("RTL check verifies actual document direction", async () => {
  fs.writeFileSync(path.join(dir, "en.json"), '{"title":"Hello"}'); fs.writeFileSync(path.join(dir, "ar.json"), '{"title":"مرحبا"}');
  const config = { baseFile: "en.json", translations: ["ar.json"] };
  assert.equal((await run("i18n-rtl", { ...config, rtlPages: [page("/rtl")] })).findings.length, 0);
  assert.equal((await run("i18n-rtl", { ...config, rtlPages: [page("/")] })).findings.length, 1);
});
test("Consent check observes trackers before consent and clean pages remain clean", async () => {
  const config = { trackerHosts: ["localhost"], privacyPath: "/privacy", observeMs: 100 };
  assert.equal((await run("privacy-consent", { ...config, pages: [page("/")] })).findings.length, 0);
  assert.equal((await run("privacy-consent", { ...config, pages: [page("/privacy-probe")] })).findings.length, 1);
});
