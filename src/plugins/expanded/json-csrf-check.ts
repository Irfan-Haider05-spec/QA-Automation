import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { z } from 'zod';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { RunContext } from '../../core/context.js';
import type { Finding } from '../../core/types.js';
import { login } from '../../web/crawler.js';
import { bounded, chromiumLaunchOptions } from '../../web/browser-options.js';
import { issue, localPath } from './support.js';
import { assertStateRequiresAuth, readState } from './csrf-check.js';

/**
 * State-verified CSRF for JSON/SPA endpoints, which have no HTML form.
 *
 * The legitimate positive control is an in-page same-origin fetch with
 * `application/json`, plus the app's CSRF header when it uses one (read inside the page
 * from a cookie or meta tag; the value never leaves the browser). Attacks come from a
 * synthetic cross-site page fulfilled locally:
 * - text-plain: a cross-site text/plain form whose body is a JSON document (no preflight).
 * - form: a URL-encoded cross-site form POST with the same fields.
 * - cors-json: the server's CORS preflight answer for the attacker origin is checked
 *   first (interception suppresses browser preflights); only if it allows credentialed
 *   JSON does the browser send the cross-site request.
 *
 * If the browser withholds SameSite=None cookies from an attack (third-party cookies
 * blocked in the test browser), the attack proves nothing and the check errors.
 */
const fieldName = z.string().regex(/^[A-Za-z_][\w-]{0,63}$/);
const primitive = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);
export const jsonCsrfCaseSchema = z.object({
  app: z.string(), appPath: localPath, actionPath: localPath,
  method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
  json: z.record(fieldName, primitive).refine(v => Object.keys(v).length >= 1 && Object.keys(v).length <= 20, '1–20 JSON fields'),
  csrfHeader: z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/), from: z.enum(['cookie', 'meta']), key: z.string().regex(/^[\w.-]{1,128}$/) }).strict().optional(),
  verifyPath: localPath, valuePath: z.string().regex(/^[A-Za-z]\w*(?:\.\w+){0,10}$/),
  expectedValue: primitive,
  observeMs: z.number().int().min(100).max(5000).default(500),
  variants: z.array(z.enum(['text-plain', 'form', 'cors-json'])).min(1).max(3).default(['text-plain', 'cors-json'])
    .refine(v => new Set(v).size === v.length, 'variants must not repeat'),
}).strict().superRefine((c, ctx) => {
  if (c.method !== 'POST' && c.variants.some(v => v !== 'cors-json')) ctx.addIssue({ code: 'custom', message: 'Only cors-json can send a cross-site ' + c.method + '; use variants: ["cors-json"]' });
  if (c.csrfHeader && /^(cookie|host|origin|referer|content-type|content-length)$/i.test(c.csrfHeader.name)) ctx.addIssue({ code: 'custom', message: 'Unsafe CSRF header name' });
});
type Case = z.output<typeof jsonCsrfCaseSchema>;
type Variant = Case['variants'][number];

const TITLES: Record<Variant, string> = {
  'text-plain': 'Cross-site text/plain JSON request changed protected state',
  form: 'Cross-site form POST to a JSON endpoint changed protected state',
  'cors-json': 'Credentialed cross-site JSON request allowed by CORS changed protected state',
};
const ATTACKER = 'https://veriq-csrf.invalid/';
class Inconclusive extends Error {}

/**
 * Ask the server for its CORS preflight answer, as a browser would, without cookies.
 * TLS verification stays on; QA_PROBE_CA_FILE may add one trust anchor (for example a
 * disposable staging CA) to the system roots.
 */
export function corsPreflight(url: URL, origin: string, method: string): Promise<Record<string, string>> {
  let ca: Array<string | Buffer> | undefined;
  if (process.env.QA_PROBE_CA_FILE) {
    const file = process.env.QA_PROBE_CA_FILE;
    if (fs.statSync(file).size > 256 * 1024) throw new Inconclusive('QA_PROBE_CA_FILE is too large');
    ca = [...tls.rootCertificates, fs.readFileSync(file)];
  }
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(url, { method: 'OPTIONS', timeout: 10000, ...(ca ? { ca } : {}),
      headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': 'content-type' } }, res => {
      res.resume();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
      resolve(headers);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new Inconclusive('CORS preflight probe failed')));
    req.end();
  });
}

/** Cookie block reasons that come from the application's own SameSite choice (a defense). */
const APP_COOKIE_REASONS = /SameSite|SecureOnly|NotOnPath|DomainMismatch|SchemeNotSupported/;

async function watchDelivery(context: BrowserContext, page: Page, action: string) {
  const cdp = await context.newCDPSession(page);
  const ids = new Set<string>();
  let status: number | undefined, failure: string | undefined;
  const environmentBlocked: string[] = [];
  cdp.on('Network.requestWillBeSent', (e: { requestId: string; request: { url: string; method: string } }) => {
    if (e.request.url.split('?')[0] === action && e.request.method !== 'OPTIONS') ids.add(e.requestId);
  });
  cdp.on('Network.requestWillBeSentExtraInfo', (e: { requestId: string; associatedCookies?: Array<{ blockedReasons?: string[] }> }) => {
    if (!ids.has(e.requestId)) return;
    for (const cookie of e.associatedCookies ?? []) {
      const reasons = cookie.blockedReasons ?? [];
      if (reasons.length && !reasons.some(r => APP_COOKIE_REASONS.test(r))) environmentBlocked.push(...reasons);
    }
  });
  cdp.on('Network.responseReceivedExtraInfo', (e: { requestId: string; statusCode: number }) => { if (ids.has(e.requestId)) status = e.statusCode; });
  cdp.on('Network.loadingFailed', (e: { requestId: string; corsErrorStatus?: { corsError?: string }; blockedReason?: string }) => {
    if (!ids.has(e.requestId) || status) return;
    const reason = e.corsErrorStatus?.corsError ?? e.blockedReason;
    if (reason && /^\w{1,80}$/.test(reason)) failure = reason;
  });
  await cdp.send('Network.enable');
  return {
    result: () => ({ status, failure, environmentBlocked }),
    stop: () => cdp.detach().catch(() => {}),
  };
}

export async function checkJsonCsrf(ctx: RunContext, c: Case): Promise<Finding[]> {
  const app = ctx.config.web.apps.find(a => a.name === c.app)!;
  const origin = new URL(app.baseUrl!).origin;
  const action = new URL(c.actionPath, origin).href;
  const browser = await chromium.launch(chromiumLaunchOptions());
  let phase = 'anonymous state control';
  try {
    await assertStateRequiresAuth(browser, origin, c.verifyPath);
    phase = 'browser login';
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    if (await login(page, app, ctx)) throw new Inconclusive('Login failed');
    phase = 'app page';
    const appResponse = await page.goto(new URL(c.appPath, origin).href);
    if (!appResponse?.ok() || new URL(page.url()).origin !== origin || new URL(page.url()).pathname === app.loginPath) throw new Inconclusive('App page unavailable');
    const read = () => readState(page, origin, c.verifyPath, c.valuePath);
    phase = 'authenticated initial state';
    const initial = await read();
    if (initial === c.expectedValue) throw new Inconclusive('Fresh state required');

    let blocked = false;
    await context.route('**/*', route => {
      const request = route.request();
      if (request.url() === ATTACKER) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Local CSRF probe</title><body></body>' });
      let sameOrigin = false;
      try { sameOrigin = new URL(request.url()).origin === origin; } catch { /* block */ }
      if (!sameOrigin) { blocked = true; return route.abort('blockedbyclient'); }
      return route.continue();
    });

    for (const variant of c.variants) {
      if (variant === 'cors-json') {
        // Request interception stops Chromium from sending CORS preflights, so the server's
        // preflight answer is checked directly; a refusal is a defense and nothing is sent.
        phase = 'CORS preflight probe';
        const h = await corsPreflight(new URL(action), new URL(ATTACKER).origin, c.method);
        const allowsMethod = c.method === 'POST' || (h['access-control-allow-methods'] ?? '').split(',').map(v => v.trim().toUpperCase()).includes(c.method);
        const allowsHeader = (h['access-control-allow-headers'] ?? '').split(',').map(v => v.trim().toLowerCase()).includes('content-type');
        if (!(h['access-control-allow-origin'] === new URL(ATTACKER).origin && h['access-control-allow-credentials'] === 'true' && allowsMethod && allowsHeader)) continue;
      }
      phase = `cross-site ${variant} request`;
      const attackPage = await context.newPage();
      // Chromium's network log is the ground truth: whether the request was sent and got a
      // response (even one CORS will not let the page read), and why each cookie was held back.
      const delivery = await watchDelivery(context, attackPage, action);
      await attackPage.goto(ATTACKER);
      await attackPage.evaluate(async ({ action, method, json, variant }) => {
        if (variant === 'cors-json') {
          try { await fetch(action, { method, mode: 'cors', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json), signal: AbortSignal.timeout(10000) }); }
          catch { /* the response may still be unreadable cross-origin */ }
          return;
        }
        const form = document.createElement('form'); form.method = 'POST'; form.action = action;
        if (variant === 'text-plain') {
          // The classic JSON CSRF form: name + "=" + value forms one JSON document.
          form.enctype = 'text/plain';
          const input = document.createElement('input');
          input.name = JSON.stringify(json).slice(0, -1) + ',"veriq_pad":"';
          input.value = '"}';
          form.append(input);
        } else {
          for (const [name, value] of Object.entries(json)) { const input = document.createElement('input'); input.name = name; input.value = String(value ?? ''); form.append(input); }
        }
        document.body.append(form); form.submit();
      }, { action, method: c.method, json: c.json, variant });
      phase = `cross-site ${variant} state observation`;
      const deadline = Date.now() + c.observeMs;
      do {
        if (await read() !== initial) return [issue('web-client-security', TITLES[variant], `${c.app} ${c.method} ${new URL(action).pathname}`,
          'A cross-site request without the application\'s CSRF token changed authenticated state. Field values, tokens and response content are omitted.', 'high', 'security', 'CWE-352')];
        await page.waitForTimeout(25);
      } while (Date.now() < deadline);
      const outcome = delivery.result();
      await delivery.stop();
      if (!outcome.status) throw new Inconclusive(`The attack request was not delivered${outcome.failure ? ` (${outcome.failure})` : ''}`);
      if (outcome.environmentBlocked.length) throw new Inconclusive('The browser withheld cookies for reasons outside the application (for example blocked third-party cookies)');
      await bounded(attackPage.close(), 5000);
    }
    if (blocked) throw new Inconclusive('External dependencies were blocked');

    phase = 'legitimate JSON positive control';
    const status = await page.evaluate(async ({ action, method, json, header }) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (header) {
        let token: string | undefined;
        if (header.from === 'cookie') token = document.cookie.split('; ').find(p => p.startsWith(header.key + '='))?.slice(header.key.length + 1);
        else token = document.querySelector<HTMLMetaElement>(`meta[name="${CSS.escape(header.key)}"]`)?.content;
        if (!token) return -1;
        headers[header.name] = decodeURIComponent(token);
      }
      const res = await fetch(action, { method, credentials: 'same-origin', redirect: 'error', headers, body: JSON.stringify(json), signal: AbortSignal.timeout(10000) });
      await res.body?.cancel();
      return res.status;
    }, { action, method: c.method, json: c.json, header: c.csrfHeader });
    if (status === -1) throw new Inconclusive('The configured CSRF token was not found in the page');
    if (status < 200 || status >= 300) throw new Inconclusive(`Positive control returned HTTP ${status}`);
    const positiveDeadline = Date.now() + c.observeMs;
    do {
      const value = await read();
      if (value === c.expectedValue) return [];
      if (value !== initial) throw new Inconclusive('Unexpected positive-control state');
      await page.waitForTimeout(25);
    } while (Date.now() < positiveDeadline);
    throw new Inconclusive('Positive control had no expected effect');
  } catch (error) {
    const why = error instanceof Inconclusive ? error.message : 'browser or page error';
    throw new Error(`JSON CSRF probe incomplete during ${phase} (${why}); check isolated state, cookie login, app page, CSRF header and dependencies`);
  } finally { await bounded(browser.close(), 15000); }
}
