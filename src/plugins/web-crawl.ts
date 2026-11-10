/**
 * Dashboard health from a logged-in crawl: uncaught JS errors, console errors,
 * failed API calls (4xx/5xx, CORS/network blocks), broken assets, blank
 * pages, pages that bounce back to login, and slow pages.
 */
import type { Finding, QaPlugin } from "../core/types.js";
import { getCrawl } from "../web/crawler.js";

const shortUrl = (u: string) => {
  try { const x = new URL(u); return x.pathname.replace(/[0-9a-f]{24}/gi, ":id"); } catch { return u; }
};

export const webCrawlPlugin: QaPlugin = {
  name: "web-crawl",
  layer: "web",
  description: "Logged-in crawl of each dashboard: JS errors, failed API calls, blank/slow pages",
  needs: ["webApps"],
  async run(ctx) {
    const findings: Finding[] = [];
    const stats: Record<string, number | string> = {};
    for (const app of ctx.config.web.apps.filter((a) => a.baseUrl)) {
      const c = await getCrawl(ctx, app);
      stats[`${app.name}Pages`] = c.pages.length;
      if (!c.loggedIn) {
        findings.push({
          plugin: this.name, severity: "high", category: "env", target: `${app.name} login`,
          title: `Could not log in to the ${app.name} dashboard: ${c.loginError}`,
          detail: `Account "${app.account}" at ${app.baseUrl}${app.loginPath}. No pages were checked.`,
          evidence: { url: app.baseUrl + app.loginPath, image: c.loginScreenshot },
        });
        continue;
      }
      for (const p of c.pages) {
        const target = `${app.name} ${p.template}`;
        const ev = { url: p.url, image: p.screenshot };
        if (p.navError) {
          findings.push({ plugin: this.name, severity: "high", category: "regression", target, title: `Page failed to load: ${p.navError}`, evidence: ev });
          continue;
        }
        if (p.bounced) {
          findings.push({ plugin: this.name, severity: "high", category: "regression", target, title: "Opening this page sends a logged-in user back to the login screen", detail: "Usually a 401 from an API call on this page, or a route guard that reads the wrong token key.", evidence: ev });
          continue;
        }
        if (p.status && p.status >= 400) {
          findings.push({ plugin: this.name, severity: p.status >= 500 ? "high" : "medium", category: "regression", target, title: `Page document returned HTTP ${p.status}`, detail: p.status === 404 ? "On a static host this usually means the SPA fallback (all paths → index.html) is missing." : undefined, evidence: ev });
        }
        for (const e of [...new Set(p.pageErrors)].slice(0, 3)) {
          findings.push({ plugin: this.name, severity: "high", category: "regression", target, title: `Uncaught JavaScript error: ${e.slice(0, 160)}`, evidence: ev });
        }
        if (p.blank) {
          findings.push({ plugin: this.name, severity: "high", category: "regression", target, title: "Page renders blank (white screen)", detail: "The body has almost no content after loading. Check the console errors for this page.", evidence: ev });
        }
        const apiFails = p.network.filter((n) => n.kind === "api");
        for (const n of apiFails) {
          const sev = n.failure ? "medium" : n.status! >= 500 ? "high" : n.status === 401 || n.status === 403 ? "high" : "medium";
          const what = n.failure ? `blocked or failed (${n.failure})` : `returned ${n.status}`;
          findings.push({
            plugin: this.name, severity: sev, category: "regression", target,
            title: `API call ${n.method} ${shortUrl(n.url)} ${what} while loading the page`,
            detail: n.failure ? "A request that fails without a status is often a CORS rejection or a wrong API base URL in the build." : n.status === 401 ? "The user is logged in, so the token is probably not being attached to this request." : undefined,
            evidence: { ...ev, log: n.url },
          });
        }
        const assets = p.network.filter((n) => n.kind === "asset");
        if (assets.length) {
          findings.push({ plugin: this.name, severity: "medium", category: "regression", target, title: `${assets.length} asset(s) failed to load`, detail: assets.slice(0, 5).map((a) => `${a.status ?? a.failure} ${shortUrl(a.url)}`).join("\n"), evidence: ev });
        }
        // Console errors that are not already explained by a page error or failed request
        const explained = (m: string) => /Failed to load resource|net::ERR/i.test(m);
        const cons = [...new Set(p.consoleErrors.filter((m) => !explained(m)))];
        if (cons.length) {
          findings.push({ plugin: this.name, severity: "medium", category: "quality", target, title: `Console error: ${cons[0].slice(0, 160)}`, detail: cons.length > 1 ? `${cons.length} distinct console errors:\n${cons.slice(0, 5).join("\n")}` : undefined, evidence: ev });
        }
        if (p.loadMs > ctx.config.web.slowMs) {
          findings.push({ plugin: this.name, severity: "low", category: "performance", target, title: `Slow page: ${(p.loadMs / 1000).toFixed(1)} s until network idle (limit ${(ctx.config.web.slowMs / 1000).toFixed(1)} s)`, evidence: ev });
        }
      }
    }
    return { findings, stats };
  },
};
