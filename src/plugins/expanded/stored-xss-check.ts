import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chromium, type Page } from 'playwright';
import type { RunContext } from '../../core/context.js';
import type { Finding } from '../../core/types.js';
import { login } from '../../web/crawler.js';
import { bounded, chromiumLaunchOptions } from '../../web/browser-options.js';
import { issue, localPath } from './support.js';
import { XSS_CONTEXTS, xssObserved, xssPayloads, type XssContext } from './xss-payloads.js';

/**
 * Explicit stored-XSS workflow: submit a value through a real same-origin form, then
 * load a separate view page and watch for a random page marker. A benign text control
 * must first appear on the view page, proving the value is stored and displayed.
 * Every submission persists data, so this only runs in disposable environments.
 */
const fieldName = z.string().regex(/^[A-Za-z][\w-]{0,63}$/);
export const storedXssCaseSchema = z.object({
  app: z.string(), public: z.boolean().default(false),
  formPath: localPath, formSelector: z.string().min(1).max(500), submitSelector: z.string().min(1).max(500),
  payloadField: fieldName,
  fields: z.record(fieldName, z.string().max(4096)).refine(v => Object.keys(v).length <= 20, 'At most 20 fields').default({}),
  viewPath: localPath, readySelector: z.string().min(1).max(500),
  observeMs: z.number().int().min(100).max(10000).default(1000),
  contexts: z.array(z.enum(XSS_CONTEXTS)).min(1).max(4).default(['html'])
    .refine(v => new Set(v).size === v.length, 'contexts must not repeat'),
}).strict().refine(c => !Object.hasOwn(c.fields, c.payloadField), 'payloadField must not also be in fields');
type Case = z.output<typeof storedXssCaseSchema>;

const STORED_TITLES: Record<XssContext, string> = {
  html: 'Stored input executed browser script on the view page',
  attribute: 'Stored input broke out of an HTML attribute on the view page',
  script: 'Stored input broke out of a script string on the view page',
  url: 'Stored input became a javascript: URL on the view page',
};
class Inconclusive extends Error {}

export async function checkStoredXss(ctx: RunContext, c: Case): Promise<Finding[]> {
  const app = ctx.config.web.apps.find(a => a.name === c.app)!;
  const origin = new URL(app.baseUrl!).origin;
  const marker = `veriq_${randomUUID().replaceAll('-', '')}`;
  const browser = await chromium.launch(chromiumLaunchOptions());
  let phase = 'login';
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    if (!c.public) {
      const loginPage = await context.newPage(); loginPage.setDefaultTimeout(5000);
      if (await login(loginPage, app, ctx)) throw new Inconclusive('Login failed');
      await bounded(loginPage.close(), 5000);
    }
    let blocked = false, serverError = false;
    await context.route('**/*', route => {
      let sameOrigin = false;
      try { sameOrigin = new URL(route.request().url()).origin === origin; } catch { /* unparsable: block */ }
      if (sameOrigin) return route.continue();
      blocked = true; return route.abort('blockedbyclient');
    });
    await context.addInitScript(key => {
      Object.defineProperty(window, key, { value: false, writable: true, configurable: false });
    }, marker);

    const submit = async (value: string) => {
      serverError = false;
      const page = await context.newPage(); page.setDefaultTimeout(5000);
      try {
        const response = await page.goto(new URL(c.formPath, origin).href, { waitUntil: 'load' });
        if (!response?.ok() || new URL(page.url()).origin !== origin) throw new Inconclusive('Form page unavailable');
        if (!c.public && new URL(page.url()).pathname === app.loginPath) throw new Inconclusive('Form page bounced to login');
        const form = page.locator(c.formSelector);
        if (await form.count() !== 1) throw new Inconclusive('Form selector must identify exactly one form');
        for (const [name, v] of Object.entries({ ...c.fields, [c.payloadField]: value })) {
          const field = form.locator(`[name="${name}"]`);
          if (await field.count() !== 1) throw new Inconclusive('Each configured field must be unique in the form');
          await field.fill(v);
        }
        page.on('response', r => {
          if (r.request().method() !== 'GET' && r.status() >= 500 && new URL(r.url()).origin === origin) serverError = true;
        });
        const button = form.locator(c.submitSelector);
        if (await button.count() !== 1) throw new Inconclusive('Submit selector must identify exactly one element');
        await button.click();
        await page.waitForLoadState('load');
        await page.waitForTimeout(100);
        if (serverError) throw new Inconclusive('Submission returned a server error');
      } finally { await bounded(page.close(), 5000); }
    };
    const view = async (until: (page: Page) => Promise<boolean>) => {
      const page = await context.newPage(); page.setDefaultTimeout(5000);
      try {
        const response = await page.goto(new URL(c.viewPath, origin).href, { waitUntil: 'load' });
        if (!response?.ok() || new URL(page.url()).origin !== origin) throw new Inconclusive('View page unavailable');
        const ready = page.locator(c.readySelector);
        if (await ready.count() !== 1) throw new Inconclusive('readySelector must identify exactly one element');
        await ready.waitFor({ state: 'visible' });
        const deadline = Date.now() + c.observeMs;
        do { if (await until(page)) return true; await page.waitForTimeout(25); } while (Date.now() < deadline);
        return false;
      } finally { await bounded(page.close(), 5000); }
    };
    const executed = (page: Page) => xssObserved(page, marker);

    phase = 'positive control';
    const control = `veriq-control-${randomUUID().slice(0, 8)}`;
    await submit(control);
    if (!await view(page => page.evaluate(text => document.body.innerText.includes(text), control))) {
      throw new Inconclusive('The stored control text was not displayed on the view page');
    }

    // Stored payloads stay on the view page, so later payloads cannot be attributed
    // reliably after one executes: the first execution ends the case.
    for (const context of c.contexts) {
      for (const payload of xssPayloads(context, marker)) {
        phase = `${context} payload`;
        await submit(payload);
        if (await view(executed)) {
          return [issue('web-client-security', STORED_TITLES[context], `${c.app} ${c.viewPath}`,
            context === 'url' ? 'A value submitted through the configured form became a javascript: URL on the view page. Payload and page content are omitted. Later contexts were not tested.' : 'A value submitted through the configured form executed script when the view page loaded. Payload and page content are omitted. Later contexts were not tested.', 'high', 'security', 'CWE-79')];
        }
      }
    }
    if (blocked) throw new Inconclusive('External dependencies were blocked');
    return [];
  } catch (error) {
    const why = error instanceof Inconclusive ? error.message : 'browser or page error';
    throw new Error(`Stored XSS probe incomplete during ${phase} (${why}); check login, form, view page and blocked external dependencies`);
  } finally { await bounded(browser.close(), 15000); }
}
