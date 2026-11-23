import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chromium, type BrowserContext, type Request } from 'playwright';
import type { RunContext } from '../../core/context.js';
import type { Finding } from '../../core/types.js';
import { login } from '../../web/crawler.js';
import { bounded, chromiumLaunchOptions } from '../../web/browser-options.js';
import { issue, localPath } from './support.js';

/**
 * Browser-side open redirects: script navigation (location.*, window.open) and
 * <meta http-equiv="refresh">. HTTP Location redirects are covered by redirectCases.
 *
 * Every probe uses the reserved `.invalid` TLD and every cross-origin request is
 * aborted by the browser before it leaves, so no external destination is contacted.
 */
export const clientRedirectCaseSchema = z.object({
  app: z.string(), path: localPath, public: z.boolean().default(false),
  queryParam: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  safePath: localPath.refine(p => !p.includes('?') && !p.includes('#'), 'safePath must be a plain path'),
  observeMs: z.number().int().min(100).max(10000).default(1500),
}).strict();
export type ClientRedirectCase = z.output<typeof clientRedirectCaseSchema>;

const PROBE_HOST = 'veriq-redirect.invalid';
/** External inputs: absolute, protocol-relative and the backslash form browsers read as protocol-relative. */
const EXTERNAL_PAYLOADS = [`https://${PROBE_HOST}/probe`, `//${PROBE_HOST}/probe`, `/\\${PROBE_HOST}/probe`];

interface Observation {
  /** A top-level frame (page or popup) tried to navigate off the app origin */
  external: boolean;
  /** Same-origin URLs the main frame moved to after the probe page committed */
  moves: URL[];
  /** A cross-origin subresource was blocked: its absence could change page behaviour */
  blockedDependency: boolean;
  /** The javascript: canary ran */
  scriptRan: boolean;
  /** The page did not answer the marker check in time, so script execution is unknown. */
  unresponsive: boolean;
}

class Inconclusive extends Error {}

/**
 * A navigation of a page or popup (not of an iframe). A popup's first navigation is
 * requested before its frame exists; Playwright then throws from frame(), and such a
 * request can only belong to a new top-level browsing context.
 */
export function isTopLevelNavigation(request: Pick<Request, 'isNavigationRequest' | 'frame'>): boolean {
  if (!request.isNavigationRequest()) return false;
  try { return !request.frame().parentFrame(); } catch { return true; }
}

/**
 * Open the probe page in a fresh tab of an already logged-in context and watch it for
 * observeMs. Returns early when an external navigation is seen.
 */
async function observe(context: BrowserContext, origin: string, c: ClientRedirectCase, value: string, marker: string, state: { current?: Observation }): Promise<Observation> {
  const obs: Observation = { external: false, moves: [], blockedDependency: false, scriptRan: false, unresponsive: false };
  state.current = obs;
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(10000);
    const url = new URL(c.path, origin);
    url.searchParams.set(c.queryParam, value);
    let committed = false;
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame() || !committed) return;
      const next = new URL(frame.url());
      if (next.origin === origin) obs.moves.push(next);
    });
    const response = await page.goto(url.href, { waitUntil: 'commit', timeout: 30000 }).catch(() => null);
    if (obs.external) return obs; // aborted before the page could commit
    if (!response) throw new Inconclusive('Probe page did not load');
    if (response.request().redirectedFrom()) throw new Inconclusive('Probe page answered with an HTTP redirect; use redirectCases for HTTP Location checks');
    if (response.status() < 200 || response.status() >= 300) throw new Inconclusive('Probe page did not answer with success');
    committed = true;
    const deadline = Date.now() + c.observeMs;
    while (Date.now() < deadline && !obs.external) await page.waitForTimeout(25);
    // A rejection means the document went away (it navigated elsewhere), so the canary
    // did not run in it; only a real timeout leaves the result unknown.
    const ran = await bounded(page.evaluate(key => (window as unknown as Record<string, unknown>)[key] === true, marker).catch(() => false), 5000);
    if (ran === undefined) obs.unresponsive = true; else obs.scriptRan = ran;
    return obs;
  } finally {
    state.current = undefined;
    // popups opened by the probe page
    // Bounded: a page that will not close is closed with the browser at the end.
    for (const p of context.pages()) if (p !== page && !p.isClosed()) await bounded(p.close(), 5000);
    await bounded(page.close(), 5000);
  }
}

export async function checkClientRedirects(ctx: RunContext, c: ClientRedirectCase): Promise<Finding[]> {
  const app = ctx.config.web.apps.find(a => a.name === c.app)!;
  const origin = new URL(app.baseUrl!).origin;
  const target = `${c.app} ${new URL(c.path, origin).pathname}`;
  const marker = `veriq_nav_${randomUUID().replaceAll('-', '')}`;
  const browser = await chromium.launch(chromiumLaunchOptions());
  let phase = 'browser login';
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    if (!c.public) {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      if (await login(page, app, ctx)) throw new Inconclusive('Login failed');
      await page.close();
    }
    const state: { current?: Observation } = {};
    // Installed after login so the app's own login flow is untouched.
    await context.route('**/*', route => {
      const request = route.request();
      let sameOrigin = false;
      try { sameOrigin = new URL(request.url()).origin === origin; } catch { /* unparsable: block */ }
      if (sameOrigin) return route.continue();
      const obs = state.current;
      if (obs) {
        if (isTopLevelNavigation(request)) obs.external = true; else obs.blockedDependency = true;
      }
      return route.abort('blockedbyclient');
    });
    await context.addInitScript(key => {
      Object.defineProperty(window, key, { value: false, writable: true, configurable: false });
    }, marker);

    phase = 'same-origin positive control';
    const control = await observe(context, origin, c, c.safePath, marker, state);
    if (control.external) throw new Inconclusive('Positive control navigated off the app origin');
    if (!control.moves.some(u => u.pathname === c.safePath)) {
      throw new Inconclusive(control.blockedDependency ? 'Positive control did not navigate; external dependencies were blocked' : 'Positive control did not navigate to safePath');
    }

    const findings: Finding[] = [];
    let inconclusive = false;
    phase = 'external navigation probes';
    for (const payload of EXTERNAL_PAYLOADS) {
      const result = await observe(context, origin, c, payload, marker, state);
      if (result.external) {
        findings.push(issue('web-client-security', 'Query input causes an external browser navigation', target,
          'After a successful same-origin control, an external-input probe made the page navigate (script or meta refresh) to another origin. The navigation was blocked before contact; query values and page content are omitted.',
          'high', 'security', 'CWE-601'));
        break;
      }
      if (result.blockedDependency) inconclusive = true;
    }
    phase = 'javascript: URL probe';
    const sink = await observe(context, origin, c, `javascript:void(window['${marker}']=true)`, marker, state);
    if (sink.unresponsive) throw new Inconclusive('The page stopped responding during the javascript: probe');
    if (sink.scriptRan) {
      findings.push(issue('web-client-security', 'Query input runs as a javascript: navigation', target,
        'The configured query input reached a navigation sink and an inert javascript: URL canary executed in the page. Payload, query values and page content are omitted.',
        'high', 'security', 'CWE-79'));
    } else if (sink.blockedDependency) inconclusive = true;
    if (!findings.length && inconclusive) throw new Inconclusive('External dependencies were blocked during a probe');
    return findings;
  } catch (e) {
    const why = e instanceof Inconclusive ? e.message : 'browser or page error';
    throw new Error(`Client-side redirect probe incomplete during ${phase} (${why}); check login, positive control, page readiness and blocked external dependencies`);
  } finally {
    await bounded(browser.close(), 15000);
  }
}

/** The reserved host used by the probes, for tests that assert it never leaks into results */
export const CLIENT_REDIRECT_PROBE_HOST = PROBE_HOST;
