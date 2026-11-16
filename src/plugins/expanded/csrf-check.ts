import { z } from 'zod';
import crypto from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import type { RunContext } from '../../core/context.js';
import { getPath } from '../../core/http.js';
import { login } from '../../web/crawler.js';
import { chromiumLaunchOptions } from '../../web/browser-options.js';
import { issue, localPath } from './support.js';

export const csrfCaseSchema = z.object({
  app: z.string(), formPath: localPath, actionPath: localPath,
  formSelector: z.string().min(1).max(500), submitSelector: z.string().min(1).max(500),
  fields: z.record(z.string().regex(/^[A-Za-z][\w-]{0,63}$/), z.string().max(4096)).refine(v => Object.keys(v).length <= 20),
  verifyPath: localPath, valuePath: z.string().regex(/^[A-Za-z]\w*(?:\.\w+){0,10}$/),
  expectedValue: z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]),
  observeMs: z.number().int().min(100).max(5000).default(500),
  /**
   * Attack variants, run in order until one changes state. missing-token: URL-encoded POST
   * with only `fields`. forged-token: adds `tokenField` with a random value of the real
   * token's length. multipart: multipart/form-data POST. get: top-level cross-site GET with
   * the fields as query parameters (SameSite=Lax cookies are sent on such navigations).
   */
  variants: z.array(z.enum(['missing-token', 'forged-token', 'multipart', 'get'])).min(1).max(4).default(['missing-token'])
    .refine(v => new Set(v).size === v.length, 'variants must not repeat'),
  tokenField: z.string().regex(/^[A-Za-z_][\w-]{0,63}$/).optional(),
}).strict().superRefine((c, issueCtx) => {
  if (c.variants.includes('forged-token') !== !!c.tokenField) issueCtx.addIssue({ code: 'custom', message: 'forged-token and tokenField must be configured together' });
  if (c.tokenField && Object.hasOwn(c.fields, c.tokenField)) issueCtx.addIssue({ code: 'custom', message: 'Do not put the CSRF token in fields; tokens are never copied into an attack' });
});
type CsrfVariant = z.output<typeof csrfCaseSchema>['variants'][number];
const VARIANT_TITLES: Record<CsrfVariant, string> = {
  'missing-token': 'Cross-site form changed protected state',
  'forged-token': 'Cross-site form with a forged CSRF token changed protected state',
  multipart: 'Cross-site multipart form changed protected state',
  get: 'Cross-site GET navigation changed protected state',
};
/** Random token-shaped value of the same length, guaranteed different from the real one. */
function forge(length: number, real: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    const value = Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
    if (value !== real) return value;
  }
}

/** The protected state endpoint must refuse an anonymous browser (401/403). */
export async function assertStateRequiresAuth(browser: Browser, origin: string, verifyPath: string) {
  const anonymous = await browser.newContext();
  try {
    const denied = await (await anonymous.newPage()).goto(new URL(verifyPath, origin).href, { timeout: 10000 });
    const status = denied?.status();
    if (!status || ![401, 403].includes(status)) throw new Error('State must require authentication');
  } finally { await anonymous.close(); }
}

/** Read a JSON primitive from the state endpoint with the page's own cookies; bounded. */
export async function readState(page: Page, origin: string, verifyPath: string, valuePath: string) {
  if (new URL(page.url()).origin !== origin) throw new Error('State reader left app origin');
  // Use the browser cookie implementation for both controls and the attack.
  const data = await page.evaluate(async url => {
    const res = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!res.ok || !res.body) throw new Error('State read failed');
    const reader = res.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw new Error('State too large'); chunks.push(value); }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  }, new URL(verifyPath, origin).href);
  const value = getPath(data, valuePath);
  if (value === undefined || (value !== null && !['string', 'number', 'boolean'].includes(typeof value))) throw new Error('Invalid state path');
  return value as string | number | boolean | null;
}

export async function checkCsrf(ctx: RunContext, c: z.output<typeof csrfCaseSchema>) {
  const app = ctx.config.web.apps.find(a => a.name === c.app)!;
  const origin = new URL(app.baseUrl!).origin;
  const action = new URL(c.actionPath, origin).href;
  const attacker = 'https://veriq-csrf.invalid/';
  const browser = await chromium.launch(chromiumLaunchOptions());
  let phase = 'anonymous state control';
  try {
    await assertStateRequiresAuth(browser, origin, c.verifyPath);
    const context = await browser.newContext({ serviceWorkers: 'block' });
    phase = 'browser login';
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    if (await login(page, app, ctx)) throw new Error('Login failed');
    const read = () => readState(page, origin, c.verifyPath, c.valuePath);
    phase = 'authenticated initial state';
    const initial = await read();
    if (initial === c.expectedValue) throw new Error('Fresh state required');
    phase = 'form preflight';
    const formResponse = await page.goto(new URL(c.formPath, origin).href);
    if (!formResponse?.ok() || new URL(page.url()).origin !== origin) throw new Error('Form unavailable');
    const form = page.locator(c.formSelector);
    if (await form.count() !== 1) throw new Error('Unique form required');
    const formInfo = await form.evaluate(el => el instanceof HTMLFormElement ? { action: el.action, method: el.method, encoding: el.enctype } : null);
    if (!formInfo || formInfo.action !== action || formInfo.method !== 'post' || formInfo.encoding !== 'application/x-www-form-urlencoded') throw new Error('Explicit URL-encoded POST form required');
    for (const [name, value] of Object.entries(c.fields)) {
      const field = form.locator(`[name="${name}"]`);
      if (await field.count() !== 1) throw new Error('Unique field required');
      await field.fill(value);
    }
    let forgedField: { name: string; value: string } | undefined;
    if (c.tokenField) {
      // Only the token's length is read; the real value never leaves the page.
      const token = form.locator(`[name="${c.tokenField}"]`);
      if (await token.count() !== 1) throw new Error('Unique token field required');
      const real = await token.inputValue();
      if (real.length < 8 || real.length > 512) throw new Error('Token field must hold a token');
      forgedField = { name: c.tokenField, value: forge(real.length, real) };
    }
    let blocked = false;
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url === attacker) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Local CSRF probe</title><body></body>' });
      if (new URL(url).origin === origin) return route.continue();
      blocked = true; return route.abort();
    });
    for (const variant of c.variants) {
      phase = `cross-site ${variant} submission`;
      const attackPage = await context.newPage();
      await attackPage.goto(attacker);
      const fields = variant === 'forged-token' ? { ...c.fields, [forgedField!.name]: forgedField!.value } : c.fields;
      const target = variant === 'get' ? `${action}${action.includes('?') ? '&' : '?'}${new URLSearchParams(fields)}` : action;
      const method = variant === 'get' ? 'GET' : 'POST';
      const [response] = await Promise.all([
        attackPage.waitForResponse(r => r.url() === target && r.request().method() === method, { timeout: 10000 }),
        attackPage.evaluate(({ target, fields, variant }) => {
          if (variant === 'get') { location.href = target; return; }
          const form = document.createElement('form'); form.method = 'POST'; form.action = target;
          if (variant === 'multipart') form.enctype = 'multipart/form-data';
          for (const [name, value] of Object.entries(fields)) { const input = document.createElement('input'); input.name = name; input.value = value; form.append(input); }
          document.body.append(form); form.submit();
        }, { target, fields, variant }),
      ]);
      const status = response.status();
      const rejected = [400, 401, 403, 422].includes(status) || (variant === 'get' && [404, 405].includes(status));
      if (!(rejected || status >= 200 && status < 400)) throw new Error('Attack response inconclusive');
      phase = `cross-site ${variant} state observation`;
      const deadline = Date.now() + c.observeMs;
      do {
        if (await read() !== initial) return [issue('web-client-security', VARIANT_TITLES[variant], `${c.app} ${new URL(action).pathname}`,
          'A browser-submitted cross-site request without copied CSRF tokens changed authenticated state. Field values, tokens and response content are omitted.', 'high', 'security', 'CWE-352')];
        await page.waitForTimeout(25);
      } while (Date.now() < deadline);
      await attackPage.close();
    }
    if (blocked) throw new Error('External dependency blocked');
    phase = 'legitimate form positive control';
    await form.locator(c.submitSelector).click();
    const positiveDeadline = Date.now() + c.observeMs;
    do {
      const value = await read();
      if (value === c.expectedValue) return [];
      if (value !== initial) throw new Error('Unexpected positive-control state');
      await page.waitForTimeout(25);
    } while (Date.now() < positiveDeadline);
    throw new Error('Positive control had no expected effect');
  } catch { throw new Error(`CSRF probe incomplete during ${phase}; check isolated state, cookie login, POST form and dependencies`); }
  finally { await browser.close(); }
}
