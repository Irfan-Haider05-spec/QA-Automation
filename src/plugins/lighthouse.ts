/**
 * Lighthouse on a few key pages of each dashboard, logged in: performance score,
 * Largest Contentful Paint, Total Blocking Time, layout shift, and the
 * best-practices score. Desktop settings by default (dashboards are used on laptops).
 *
 * The browser logs in once through the real login form (like web-crawl), then
 * Lighthouse opens each page in the same browser profile, so it measures the
 * pages people actually see after login. One HTML report per page is kept in
 * the report folder (lighthouse/).
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";
import type { Finding, QaPlugin } from "../core/types.js";
import type { RunContext } from "../core/context.js";
import type { WebAppConfig } from "../core/config.js";
import { login, slugOf } from "../web/crawler.js";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)); });
  });

export interface PageScores { performance: number; accessibility: number; bestPractices: number; lcpMs: number; tbtMs: number; cls: number }

/** Lighthouse result (lhr) → the numbers we judge */
export function scoresOf(lhr: any): PageScores {
  const cat = (k: string) => Math.round((lhr.categories?.[k]?.score ?? 0) * 100);
  const num = (k: string) => Number(lhr.audits?.[k]?.numericValue ?? 0);
  return {
    performance: cat("performance"),
    accessibility: cat("accessibility"),
    bestPractices: cat("best-practices"),
    lcpMs: Math.round(num("largest-contentful-paint")),
    tbtMs: Math.round(num("total-blocking-time")),
    cls: Math.round(num("cumulative-layout-shift") * 1000) / 1000,
  };
}

/** The biggest savings Lighthouse suggests, for the finding text */
export function topOpportunities(lhr: any, n = 3): string[] {
  return Object.values<any>(lhr.audits ?? {})
    .filter((a) => a.details?.type === "opportunity" && (a.details.overallSavingsMs ?? 0) >= 150)
    .sort((a, b) => b.details.overallSavingsMs - a.details.overallSavingsMs)
    .slice(0, n)
    .map((a) => `${a.title} (~${Math.round(a.details.overallSavingsMs)} ms)`);
}

export function judge(app: string, pagePath: string, s: PageScores, t: RunContext["config"]["lighthouse"]["thresholds"], extra: { url: string; report: string; tips: string[] }): Finding[] {
  const out: Finding[] = [];
  const target = `${app} ${pagePath}`;
  const log = `performance ${s.performance} · accessibility ${s.accessibility} · best practices ${s.bestPractices} · LCP ${(s.lcpMs / 1000).toFixed(1)} s · TBT ${s.tbtMs} ms · CLS ${s.cls}\nReport: ${extra.report}`;
  const ev = { url: extra.url, log };
  const slow: string[] = [];
  if (s.lcpMs > t.lcpMs) slow.push(`LCP ${(s.lcpMs / 1000).toFixed(1)} s`);
  if (s.tbtMs > t.tbtMs) slow.push(`TBT ${s.tbtMs} ms`);
  if (s.performance < t.performance || slow.length) {
    out.push({
      plugin: "lighthouse", severity: s.performance < t.performance / 2 ? "high" : "medium", category: "performance", target,
      title: `Slow page: performance ${s.performance}${slow.length ? ` (${slow.join(", ")})` : ""}`,
      detail: extra.tips.length ? `Biggest savings: ${extra.tips.join("; ")}.` : undefined, evidence: ev,
    });
  }
  if (s.cls > t.cls) {
    out.push({ plugin: "lighthouse", severity: "low", category: "quality", target: `${target} layout shift`, title: `Content jumps while loading (CLS ${s.cls}, limit ${t.cls})`, detail: "Reserve space for images, charts and late-loading content.", evidence: ev });
  }
  if (s.bestPractices < t.bestPractices) {
    out.push({ plugin: "lighthouse", severity: "low", category: "quality", target: `${target} best practices`, title: `Best-practices score ${s.bestPractices} (limit ${t.bestPractices})`, detail: "See the Lighthouse report: console errors, deprecated APIs, insecure requests, missing image sizes.", evidence: ev });
  }
  return out;
}

async function auditApp(ctx: RunContext, app: WebAppConfig, findings: Finding[], stats: Record<string, string | number>) {
  const L = ctx.config.lighthouse;
  const { default: lighthouse } = await import("lighthouse");
  const desktop = (await import("lighthouse/core/config/desktop-config.js")).default;
  const pages = (L.pages[app.name] ?? app.seedRoutes).slice(0, L.maxPages);
  const outDir = path.join(ctx.outDir, "lighthouse");
  fs.mkdirSync(outDir, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "qa-lh-"));
  const port = await freePort();
  const extraArgs = process.env.QA_CHROMIUM_ARGS ? process.env.QA_CHROMIUM_ARGS.split(/\s+/).filter(Boolean) : [];
  // A persistent profile is the browser's default context, which Lighthouse's new tabs share (login cookies, storage)
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.QA_CHROMIUM_PATH || undefined,
    headless: true,
    args: [`--remote-debugging-port=${port}`, ...extraArgs],
    viewport: ctx.config.web.viewport,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const err = await login(page, app, ctx);
    if (err) {
      findings.push({ plugin: "lighthouse", severity: "medium", category: "config", target: `${app.name} login`, title: `Couldn't log in to ${app.name} for Lighthouse: ${err}` });
      return;
    }
    for (const p of pages) {
      const url = app.baseUrl + p;
      const res = await lighthouse(url, { port, output: "html", logLevel: "error", onlyCategories: ["performance", "accessibility", "best-practices"], disableStorageReset: true }, L.formFactor === "desktop" ? desktop : undefined);
      if (!res?.lhr) { stats[`${app.name} ${p}`] = "no result"; continue; }
      if (res.lhr.runtimeError) {
        findings.push({ plugin: "lighthouse", severity: "medium", category: "regression", target: `${app.name} ${p}`, title: `Lighthouse couldn't load the page: ${res.lhr.runtimeError.message ?? res.lhr.runtimeError.code}`, evidence: { url } });
        continue;
      }
      const landed = new URL(res.lhr.finalDisplayedUrl ?? url);
      if (landed.pathname.endsWith(app.loginPath) && !p.endsWith(app.loginPath)) {
        findings.push({ plugin: "lighthouse", severity: "medium", category: "config", target: `${app.name} ${p}`, title: "Lighthouse was sent back to the login page", detail: "The login session didn't carry over to Lighthouse's tab (session kept only in sessionStorage?). Scores for this page were skipped.", evidence: { url } });
        continue;
      }
      const file = path.join(outDir, `${app.name}-${slugOf(p)}.html`);
      fs.writeFileSync(file, Array.isArray(res.report) ? res.report[0] : res.report);
      const s = scoresOf(res.lhr);
      stats[`${app.name} ${p}`] = `perf ${s.performance}, LCP ${(s.lcpMs / 1000).toFixed(1)}s`;
      findings.push(...judge(app.name, p, s, L.thresholds, { url, report: path.relative(ctx.outDir, file), tips: topOpportunities(res.lhr) }));
    }
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

export const lighthousePlugin: QaPlugin = {
  name: "lighthouse",
  layer: "perf",
  description: "Lighthouse on key dashboard pages (logged in): performance, LCP, TBT, layout shift, best practices",
  needs: ["webApps"],
  async run(ctx) {
    const findings: Finding[] = [];
    const stats: Record<string, string | number> = {};
    for (const app of ctx.config.web.apps.filter((a) => a.baseUrl)) await auditApp(ctx, app, findings, stats);
    return { findings, stats };
  },
};
