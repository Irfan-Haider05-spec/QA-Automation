import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, firefox, webkit, type Page, type BrowserContext } from "playwright";
import { z } from "zod";
import type { RunContext } from "../../core/context.js";
import { type Finding } from "../../core/types.js";
import { login } from "../../web/crawler.js";
import { checkedPlugin, disposable, issue, localPath, readJson } from "./support.js";
import { chromiumLaunchOptions } from "../../web/browser-options.js";
import { checkRedirects, redirectCaseSchema } from './redirect-check.js';
import { checkCsrf, csrfCaseSchema } from './csrf-check.js';
import { checkClientRedirects, clientRedirectCaseSchema } from './client-redirect-check.js';
import { XSS_CONTEXTS, XSS_TITLES, xssObserved, xssPayloads } from './xss-payloads.js';
import { checkStoredXss, storedXssCaseSchema } from './stored-xss-check.js';
import { checkJsonCsrf, jsonCsrfCaseSchema } from './json-csrf-check.js';

const pageSpec = z.object({ app: z.string(), path: localPath, public: z.boolean().default(false) });
const pagesSchema = z.object({ pages: z.array(pageSpec).min(1).max(30) }).strict();
type PageSpec = z.output<typeof pageSpec>;
async function visit<T>(ctx: RunContext, spec: PageSpec, run: (p: Page, context: BrowserContext) => Promise<T>,
  options: { engine?: "chromium" | "firefox" | "webkit"; width?: number; height?: number; before?: (p: Page) => unknown; locale?: string } = {}) {
  const app = ctx.config.web.apps.find((a) => a.name === spec.app);
  if (!app?.baseUrl) throw new Error(`Web app ${spec.app} has no URL`);
  const base = new URL(app.baseUrl);
  const url = new URL(spec.path, base);
  if (url.origin !== base.origin) throw new Error("Page must stay on the app origin");
  const engine = options.engine ?? "chromium";
  const browser = await ({ chromium, firefox, webkit })[engine].launch({
    ...(engine === "chromium" ? chromiumLaunchOptions() : {}),
  });
  try {
    const context = await browser.newContext({ viewport: { width: options.width ?? 1366, height: options.height ?? 900 }, locale: options.locale ?? "en-US", reducedMotion: "reduce", serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    if (!spec.public) { const error = await login(page, app, ctx); if (error) throw new Error(`Browser login failed for ${spec.app}`); }
    await options.before?.(page);
    const response = await page.goto(url.href, { waitUntil: "load", timeout: 30000 });
    if (!response || response.status() >= 400) throw new Error(`Page navigation failed (${response?.status() ?? "no response"})`);
    if (new URL(page.url()).origin !== base.origin) throw new Error("Page redirected outside the configured app");
    if (!spec.public && new URL(page.url()).pathname === app.loginPath) throw new Error("Authenticated page bounced back to login");
    return await run(page, context);
  } finally { await browser.close(); }
}

const clientSecuritySchema = z.object({
  pages: z.array(pageSpec).max(30).default([]),
  xssCases: z.array(pageSpec.extend({
    queryParam: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    readySelector: z.string().min(1).max(500),
    observeMs: z.number().int().min(100).max(5000).default(500),
    contexts: z.array(z.enum(XSS_CONTEXTS)).min(1).max(4).default(['html'])
      .refine(v => new Set(v).size === v.length, 'contexts must not repeat'),
  }).strict()).max(20).default([]),
  redirectCases: z.array(redirectCaseSchema).max(20).default([]),
  clientRedirectCases: z.array(clientRedirectCaseSchema).max(20).default([]),
  csrfCases: z.array(csrfCaseSchema).max(10).default([]),
  storedXssCases: z.array(storedXssCaseSchema).max(10).default([]),
  jsonCsrfCases: z.array(jsonCsrfCaseSchema).max(10).default([]),
}).strict().refine(c => c.jsonCsrfCases.length + c.storedXssCases.length + c.pages.length + c.xssCases.length + c.redirectCases.length + c.clientRedirectCases.length + c.csrfCases.length > 0, 'Configure at least one browser check');

export const webClientSecurity = checkedPlugin("web-client-security", "web", "Browser storage/resources and explicit reflected/stored XSS, HTTP and client-side redirect, and state-verified form and JSON CSRF probes", clientSecuritySchema,
  async (ctx, c) => {
    if (c.xssCases.length || c.storedXssCases.length || c.jsonCsrfCases.length || c.redirectCases.length || c.clientRedirectCases.length || c.csrfCases.length) disposable(ctx);
    // Validate the entire active configuration before starting browser traffic.
    for (const spec of [...c.xssCases, ...c.storedXssCases, ...c.jsonCsrfCases, ...c.redirectCases, ...c.clientRedirectCases, ...c.csrfCases]) {
      const app = ctx.config.web.apps.find(a => a.name === spec.app);
      if (!app?.baseUrl || !['http:', 'https:'].includes(new URL(app.baseUrl).protocol)) throw new Error('Active browser probe requires a configured HTTP(S) app');
    }
    const findings: Finding[] = [];
    for (const spec of c.pages) {
      const state = await visit(ctx, spec, async (page) => page.evaluate(() => ({
        tokenKeys: Object.keys(localStorage).filter((k) => /token|jwt|secret/i.test(k) && !!localStorage.getItem(k)),
        scripts: Array.from(document.scripts).filter((s) => s.src).map((s) => ({ src: s.src, integrity: s.integrity })),
        mixed: location.protocol === "https:" && Array.from(document.querySelectorAll("[src]")).some((el) => el.getAttribute("src")?.startsWith("http:")),
        origin: location.origin,
      })));
      const target = `${spec.app} ${spec.path}`;
      if (state.tokenKeys.length) findings.push(issue("web-client-security", "Credential-like keys in localStorage", target, `${state.tokenKeys.length} matching keys. Values and names omitted. Verify whether these contain credentials.`, "medium", "security", "CWE-922"));
      if (state.mixed) findings.push(issue("web-client-security", "Mixed-content resource declared", target, "HTTPS document references an HTTP resource.", "medium", "security", "CWE-319"));
      if (state.scripts.some((s) => new URL(s.src).origin !== state.origin && !s.integrity)) findings.push(issue("web-client-security", "Third-party script lacks integrity metadata", target, "Review external script trust and add SRI where the resource is stable.", "medium", "security", "CWE-353"));
    }
    for (const spec of c.xssCases) {
      const app = ctx.config.web.apps.find(a => a.name === spec.app)!;
      const origin = new URL(app.baseUrl!).origin;
      const marker = `veriq_${randomUUID().replaceAll('-', '')}`;
      for (const context of spec.contexts) {
        // Each context's payloads run until one executes; one finding per context.
        for (const payload of xssPayloads(context, marker)) {
          const url = new URL(spec.path, origin);
          let externalBlocked = false;
          // Inert local canary: no cookies, storage, network destination or user data.
          url.searchParams.set(spec.queryParam, payload);
          const executed = await visit(ctx, { ...spec, path: url.pathname + url.search }, async page => {
            const ready = page.locator(spec.readySelector);
            if (await ready.count() !== 1) throw new Error('XSS readySelector must identify exactly one element');
            await ready.waitFor({ state: 'visible' });
            await page.waitForTimeout(spec.observeMs);
            const triggered = await xssObserved(page, marker);
            if (!triggered && externalBlocked) throw new Error('External resources were blocked; probe coverage is inconclusive');
            return triggered;
          }, { before: async page => {
            await page.context().route('**/*', route => {
              const target = new URL(route.request().url());
              if (target.origin === origin) return route.continue();
              externalBlocked = true;
              return route.abort();
            });
            await page.context().addInitScript(key => {
              Object.defineProperty(window, key, { value: false, writable: true, configurable: false });
            }, marker);
          } }).catch(() => { throw new Error(`XSS probe incomplete (${context} context): check page readiness, login, navigation and blocked external dependencies`); });
          if (executed) {
            findings.push(issue('web-client-security', XSS_TITLES[context], `${spec.app} ${url.pathname}`,
              context === 'url'
                ? 'The query-input canary was placed as a javascript: URL in a navigable attribute; following it runs script. Payload, query values and page content are omitted.'
                : 'The configured query-input canary executed in the application page. Payload, query values and page content are omitted.', 'high', 'security', 'CWE-79'));
            break;
          }
        }
      }
    }
    for (const spec of c.storedXssCases) findings.push(...await checkStoredXss(ctx, spec));
    for (const spec of c.jsonCsrfCases) findings.push(...await checkJsonCsrf(ctx, spec));
    for (const spec of c.redirectCases) {
      const app = ctx.config.web.apps.find(a => a.name === spec.app)!;
      const origin = new URL(app.baseUrl!).origin;
      const browser = await chromium.launch(chromiumLaunchOptions());
      try {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        if (!spec.public) {
          const page = await context.newPage();
          if (await login(page, app, ctx)) throw new Error('Login failed');
        }
        if (await checkRedirects(context, origin, spec)) findings.push(issue('web-client-security', 'Query input permits an external HTTP redirect', `${spec.app} ${new URL(spec.path, origin).pathname}`,
          'After a successful same-origin control, an external-input probe produced a cross-origin Location. The destination was not contacted; query values and response content are omitted.', 'high', 'security', 'CWE-601'));
      } catch { throw new Error('HTTP redirect probe incomplete: check login, positive control, rejection policy and redirect chain'); }
      finally { await browser.close(); }
    }
    for (const spec of c.clientRedirectCases) findings.push(...await checkClientRedirects(ctx, spec));
    for (const spec of c.csrfCases) findings.push(...await checkCsrf(ctx, spec));
    return findings;
  }, ["webApps"]);

export const webForms = checkedPlugin("web-forms", "web", "Submit explicitly selected invalid form cases on disposable data",
  z.object({ cases: z.array(pageSpec.extend({ form: z.string().min(1), fields: z.record(z.string(), z.string()), submit: z.string().min(1), errorSelector: z.string().min(1) })).min(1).max(30) }).strict(),
  async (ctx, c) => {
    disposable(ctx); const findings: Finding[] = [];
    for (const [i, spec] of c.cases.entries()) {
      const result = await visit(ctx, spec, async (page) => {
        const errors: string[] = []; const serverErrors: number[] = [];
        page.on("pageerror", (e) => errors.push(e.name));
        page.on("response", (r) => { if (r.status() >= 500) serverErrors.push(r.status()); });
        const form = page.locator(spec.form);
        if (await form.count() !== 1) throw new Error("Form selector must identify exactly one form");
        for (const [selector, value] of Object.entries(spec.fields)) await form.locator(selector).fill(value);
        await form.locator(spec.submit).click();
        await page.waitForTimeout(500);
        const invalid = await form.evaluate((el) => el instanceof HTMLFormElement && !el.checkValidity()).catch(() => false);
        const errorShown = await page.locator(spec.errorSelector).first().isVisible();
        return { invalid, errorShown, crashed: !!(errors.length || serverErrors.length) };
      });
      if (result.crashed || (!result.invalid && !result.errorShown)) findings.push(issue("web-forms", result.crashed ? "Invalid form input caused an error" : "Invalid form input has no visible rejection", `${spec.app} ${spec.path} case ${i + 1}`, "The configured invalid input must produce a native or application validation message without a crash.", "high", "quality", "CWE-20"));
    }
    return findings;
  }, ["webApps"]);

export const crossBrowser = checkedPlugin("cross-browser", "web", "Check configured pages in Chromium, Firefox and WebKit at explicit viewport sizes",
  pagesSchema.extend({ browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).min(1).default(["chromium", "firefox", "webkit"]),
    viewports: z.array(z.object({ width: z.number().int().min(320).max(3000), height: z.number().int().min(400).max(2000) })).min(1).max(6).default([{ width: 1366, height: 900 }, { width: 390, height: 844 }]) }),
  async (ctx, c) => {
    const findings: Finding[] = []; let checks = 0;
    for (const spec of c.pages) for (const engine of c.browsers) for (const viewport of c.viewports) {
      const errors: string[] = [];
      const result = await visit(ctx, spec, async (page) => page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 2,
        blank: !document.body.innerText.trim() && !document.querySelector("canvas,svg,img,video"),
      })), { engine, ...viewport, before: (page) => page.on("pageerror", (e) => errors.push(e.name)) });
      checks++;
      if (result.blank || errors.length || result.overflow) findings.push(issue("cross-browser", result.blank ? "Blank page" : errors.length ? "Uncaught browser error" : "Horizontal viewport overflow", `${spec.app} ${spec.path} ${engine} ${viewport.width}`, "Inspect this browser/viewport combination.", "medium", "quality"));
    }
    return { findings, stats: { checks } };
  }, ["webApps"]);

export const linksSeo = checkedPlugin("links-seo", "web", "Public-page metadata, broken images and bounded same-origin link checks",
  pagesSchema.extend({ maxLinks: z.number().int().min(1).max(100).default(20), checkDiscoveryFiles: z.boolean().default(false) }),
  async (ctx, c) => {
    const findings: Finding[] = [];
    for (const spec of c.pages) {
      if (!spec.public) throw new Error("links-seo requires public pages; authenticated links may change state");
      await visit(ctx, spec, async (page, context) => {
        const data = await page.evaluate(() => ({ title: document.title.trim(), description: document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim(),
          broken: Array.from(document.images).filter((img) => img.complete && img.naturalWidth === 0).length,
          links: Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((a) => a.href), origin: location.origin }));
        const target = `${spec.app} ${spec.path}`;
        if (!data.title || !data.description) findings.push(issue("links-seo", "Missing page title or description", target, "Public pages should declare useful title and description metadata.", "low", "quality"));
        if (data.broken) findings.push(issue("links-seo", "Broken images", target, `${data.broken} images failed to decode.`, "medium", "quality"));
        const links = [...new Set(data.links)].filter((v) => { const u = new URL(v); return u.origin === data.origin && !u.search && !/logout|delete|remove|unsubscribe/i.test(u.pathname); }).slice(0, c.maxLinks);
        if (c.checkDiscoveryFiles) links.push(`${data.origin}/robots.txt`, `${data.origin}/sitemap.xml`);
        for (const url of links) {
          const res = await context.request.head(url, { maxRedirects: 0, timeout: 10000 });
          // 405 means HEAD is unsupported, not that the resource is broken.
          if ([404, 410].includes(res.status()) || res.status() >= 500) findings.push(issue("links-seo", `Broken resource (${res.status()})`, new URL(url).pathname, `Linked from ${target}.`, "medium", "quality"));
          await res.dispose();
        }
      });
    }
    return findings;
  }, ["webApps"]);

function flatten(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > 30) throw new Error("Translation nesting exceeds limit");
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1));
  return [prefix];
}
export const i18nRtl = checkedPlugin("i18n-rtl", "web", "Translation key parity and explicit RTL-page layout checks",
  z.object({ baseFile: z.string(), translations: z.array(z.string()).min(1), rtlPages: z.array(pageSpec).max(30).default([]) }).strict(),
  async (ctx, c) => {
    const base = flatten(readJson(ctx, c.baseFile)); const findings: Finding[] = [];
    for (const file of c.translations) {
      const keys = new Set(flatten(readJson(ctx, file)));
      const missing = base.filter((k) => !keys.has(k));
      if (missing.length) findings.push(issue("i18n-rtl", "Missing translation keys", file, missing.slice(0, 50).join(", "), "medium", "quality"));
    }
    for (const spec of c.rtlPages) {
      const result = await visit(ctx, spec, (p) => p.evaluate(() => ({ direction: getComputedStyle(document.documentElement).direction, overflow: document.documentElement.scrollWidth > innerWidth + 2 })), { locale: "ar" });
      if (result.direction !== "rtl" || result.overflow) findings.push(issue("i18n-rtl", "RTL page layout mismatch", `${spec.app} ${spec.path}`, `Computed direction ${result.direction}; horizontal overflow ${result.overflow}.`, "medium", "quality"));
    }
    return findings;
  });

export const privacyConsent = checkedPlugin("privacy-consent", "web", "Observe configured tracker domains before consent in a fresh browser context",
  pagesSchema.extend({ trackerHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/i)).min(1), privacyPath: localPath, observeMs: z.number().int().min(100).max(5000).default(1000) }),
  async (ctx, c) => {
    const findings: Finding[] = [];
    for (const spec of c.pages) {
      if (!spec.public) throw new Error("Consent checks must start without an authenticated session");
      const trackers = new Set<string>(); let pii = false;
      await visit(ctx, spec, async (page) => {
        await page.waitForTimeout(c.observeMs);
        const links = await page.locator("a[href]").evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).pathname));
        if (!links.includes(c.privacyPath)) findings.push(issue("privacy-consent", "Privacy link not found on observed page", `${spec.app} ${spec.path}`, "No link to the configured privacy path was visible in the document.", "low", "quality"));
      }, { before: (page) => page.on("request", (r) => {
        const u = new URL(r.url());
        if (c.trackerHosts.some((h) => u.hostname === h.toLowerCase() || u.hostname.endsWith(`.${h.toLowerCase()}`))) trackers.add(u.hostname);
        if ([...u.searchParams.keys()].some((k) => /^(email|phone|password|token|access_token)$/i.test(k))) pii = true;
      }) });
      if (trackers.size) findings.push(issue("privacy-consent", "Configured tracker contacted before consent", `${spec.app} ${spec.path}`, [...trackers].join(", "), "medium", "quality"));
      if (pii) findings.push(issue("privacy-consent", "Sensitive parameter name in a request URL", `${spec.app} ${spec.path}`, "Query values omitted. Review whether personal data or credentials are sent in URLs.", "medium", "security", "CWE-598"));
    }
    return findings;
  }, ["webApps"]);
