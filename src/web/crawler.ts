/**
 * Shared, read-only dashboard crawler. One crawl per app per run; the web
 * plugins (web-crawl, web-a11y, web-visual) read the same results.
 *
 * It logs in through the real login form, then visits pages by following
 * same-origin links (plus seed routes and routes found in the dashboard
 * source). It never clicks buttons or submits forms after login, and skips
 * logout/delete links, so it cannot change data.
 */
import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { chromium, type Browser, type Page } from "playwright";
import type { RunContext } from "../core/context.js";
import type { WebAppConfig } from "../core/config.js";
import { discoverSpaRoutes } from "../discovery/spa-routes.js";

export interface NetworkIssue { method: string; url: string; status?: number; failure?: string; kind: "api" | "asset" | "document" }
export interface AxeViolation { id: string; impact: string | null; help: string; helpUrl: string; nodes: string[] }

export interface PageResult {
  app: string;
  path: string;
  /** Path with ids replaced by :id, used to group findings */
  template: string;
  url: string;
  status?: number;
  loadMs: number;
  consoleErrors: string[];
  pageErrors: string[];
  network: NetworkIssue[];
  blank: boolean;
  bounced: boolean;
  screenshot?: string; // relative to outDir
  axe?: AxeViolation[];
  navError?: string;
}

export interface CrawlResult {
  app: WebAppConfig;
  loggedIn: boolean;
  loginError?: string;
  loginScreenshot?: string;
  pages: PageResult[];
  discoveredFromSource: number;
}

const cache = new Map<string, Promise<CrawlResult>>();

export const templateOf = (p: string) =>
  p.split("/").map((seg) => (/^[0-9a-f]{24}$/i.test(seg) || /^\d+$/.test(seg) || /^[0-9a-f-]{36}$/i.test(seg) ? ":id" : seg)).join("/") || "/";

export const slugOf = (p: string) => (p === "/" ? "home" : p.replace(/^\//, "").replace(/[^A-Za-z0-9_-]+/g, "_")).slice(0, 120);

const ASSET_RE = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)(\?|$)/i;
const DOWNLOAD_RE = /\.(pdf|xlsx?|csv|zip|docx?)(\?|$)/i;

export function getCrawl(ctx: RunContext, app: WebAppConfig): Promise<CrawlResult> {
  if (!cache.has(app.name)) cache.set(app.name, crawl(ctx, app));
  return cache.get(app.name)!;
}

export async function login(page: Page, app: WebAppConfig, ctx: RunContext): Promise<string | undefined> {
  const acc = ctx.config.accounts[app.account];
  if (!acc) return `account "${app.account}" is not configured`;
  await page.goto(app.baseUrl + app.loginPath, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  const sel = app.selectors ?? {};
  const idField = page.locator(sel.identifier ?? 'input[type="email"], input[name*="email" i], input[name*="identifier" i], input[name*="phone" i], input[name*="user" i], input[type="text"]').first();
  const pwField = page.locator(sel.password ?? 'input[type="password"]').first();
  try {
    await idField.fill(acc.identifier!, { timeout: 10000 });
    await pwField.fill(acc.password!, { timeout: 10000 });
  } catch {
    return "login form fields not found (set web.apps[].selectors in qa.config.ts)";
  }
  const submit = page.locator(sel.submit ?? 'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in")').first();
  await submit.click({ timeout: 10000 }).catch(() => pwField.press("Enter"));
  const loginUrl = app.baseUrl + app.loginPath;
  try {
    await page.waitForURL((u) => !u.toString().startsWith(loginUrl), { timeout: 20000 });
  } catch {
    const msg = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    return `still on the login page after submitting${msg ? ` (page says: "${msg}")` : ""}`;
  }
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  return undefined;
}

async function crawl(ctx: RunContext, app: WebAppConfig): Promise<CrawlResult> {
  const wantAxe = ctx.selectedPlugins.includes("web-a11y");
  // Screenshots are evidence for every web finding; full-page only when visual diffs need them
  const fullPage = ctx.selectedPlugins.includes("web-visual");
  const shotDir = path.join(ctx.outDir, "web", app.name);
  fs.mkdirSync(shotDir, { recursive: true });
  const excluded = picomatch(app.excludePaths, { dot: true, nocase: true });
  const ignoreConsole = ctx.config.web.ignoreConsole.map((r) => new RegExp(r, "i"));
  const origin = new URL(app.baseUrl!).origin;
  const basePath = new URL(app.baseUrl!).pathname.replace(/\/$/, "");
  const result: CrawlResult = { app, loggedIn: false, pages: [], discoveredFromSource: 0 };

  let browser: Browser | undefined;
  try {
    // QA_CHROMIUM_PATH lets you use an installed Chrome/Chromium instead of Playwright's download
    // (e.g. locked-down networks); QA_CHROMIUM_ARGS adds launch flags such as --no-sandbox.
    browser = await chromium.launch({
      executablePath: process.env.QA_CHROMIUM_PATH || undefined,
      args: process.env.QA_CHROMIUM_ARGS ? process.env.QA_CHROMIUM_ARGS.split(/\s+/).filter(Boolean) : undefined,
    });
    const context = await browser.newContext({ viewport: ctx.config.web.viewport, reducedMotion: "reduce", locale: "en-US", timezoneId: "Asia/Karachi" });
    const page = await context.newPage();

    // Per-navigation collectors
    let cur: PageResult | undefined;
    page.on("console", (m) => {
      if (cur && m.type() === "error" && !ignoreConsole.some((r) => r.test(m.text()))) cur.consoleErrors.push(m.text().slice(0, 400));
    });
    page.on("pageerror", (e) => { if (cur) cur.pageErrors.push(`${e.name}: ${e.message}`.slice(0, 400)); });
    page.on("response", (r) => {
      if (!cur || r.status() < 400) return;
      const req = r.request();
      const type = req.resourceType();
      const kind = type === "fetch" || type === "xhr" ? "api" : type === "document" ? "document" : "asset";
      if (kind === "document") return; // the page status is recorded separately
      cur.network.push({ method: req.method(), url: r.url(), status: r.status(), kind });
    });
    page.on("requestfailed", (req) => {
      const failure = req.failure()?.errorText ?? "failed";
      if (!cur || /ERR_ABORTED|NS_BINDING_ABORTED/.test(failure)) return; // cancelled by navigation
      const type = req.resourceType();
      cur.network.push({ method: req.method(), url: req.url(), failure, kind: type === "fetch" || type === "xhr" ? "api" : "asset" });
    });

    const loginError = await login(page, app, ctx);
    if (loginError) {
      result.loginError = loginError;
      const shot = path.join(shotDir, "login-failed.png");
      await page.screenshot({ path: shot }).catch(() => {});
      result.loginScreenshot = path.relative(ctx.outDir, shot);
      return result;
    }
    result.loggedIn = true;

    // Queue: seeds + routes from source + where login landed
    const queue: string[] = [];
    const seen = new Set<string>();
    const enqueue = (p: string) => {
      const clean = (p.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
      const key = templateOf(clean);
      if (seen.has(key) || excluded(clean) || clean === app.loginPath) return;
      seen.add(key);
      queue.push(clean);
    };
    enqueue(new URL(page.url()).pathname.slice(basePath.length) || "/");
    app.seedRoutes.forEach(enqueue);
    if (app.sourceDir) {
      const fromSource = discoverSpaRoutes(app.sourceDir);
      result.discoveredFromSource = fromSource.length;
      fromSource.forEach(enqueue);
    }

    while (queue.length && result.pages.length < app.maxPages) {
      const p = queue.shift()!;
      cur = { app: app.name, path: p, template: templateOf(p), url: app.baseUrl + p, loadMs: 0, consoleErrors: [], pageErrors: [], network: [], blank: false, bounced: false };
      const t0 = Date.now();
      try {
        const resp = await page.goto(app.baseUrl + p, { waitUntil: "domcontentloaded", timeout: 30000 });
        cur.status = resp?.status();
        await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
        cur.loadMs = Date.now() - t0;
      } catch (e: any) {
        cur.navError = String(e?.message ?? e).split("\n")[0];
        cur.loadMs = Date.now() - t0;
        result.pages.push(cur);
        continue;
      }
      const landed = new URL(page.url());
      cur.bounced = landed.pathname.startsWith(basePath + app.loginPath);
      const text = (await page.locator("body").innerText().catch(() => "")).trim();
      const visibleEls = await page.evaluate(() => document.body ? document.body.querySelectorAll("*").length : 0).catch(() => 0);
      cur.blank = text.length < 15 && visibleEls < 8;

      if (!cur.bounced) {
        const links = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href)).catch(() => [] as string[]);
        for (const href of links) {
          try {
            const u = new URL(href);
            if (u.origin !== origin || !u.pathname.startsWith(basePath) || DOWNLOAD_RE.test(u.pathname)) continue;
            enqueue(u.pathname.slice(basePath.length) || "/");
          } catch { /* mailto:, javascript: */ }
        }
        if (wantAxe) {
          try {
            const { default: AxeBuilder } = await import("@axe-core/playwright");
            const r = await new AxeBuilder({ page: page as any }).withTags(["wcag2a", "wcag2aa"]).analyze();
            cur.axe = r.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
          } catch (e: any) {
            ctx.log.debug(`axe failed on ${p}: ${e?.message}`);
          }
        }
        {
          const file = path.join(shotDir, `${slugOf(cur.template)}.png`);
          await page.screenshot({
            path: file, fullPage, animations: "disabled", caret: "hide",
            mask: ctx.config.web.visual.mask.map((m) => page.locator(m)),
          }).catch(() => {});
          if (fs.existsSync(file)) cur.screenshot = path.relative(ctx.outDir, file);
        }
      }
      result.pages.push(cur);
      cur = undefined;
    }
    ctx.log.info(`  crawled ${app.name}: ${result.pages.length} page(s)${queue.length ? `, ${queue.length} more not visited (maxPages ${app.maxPages})` : ""}`);
    return result;
  } finally {
    await browser?.close();
  }
}
