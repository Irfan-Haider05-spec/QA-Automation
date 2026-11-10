/**
 * Business flows: short scripted journeys through a dashboard (create a
 * promotion, redeem a reward, export a report), run in a real browser after
 * logging in. A flow fails on the first step that throws; the finding names the
 * step, keeps a screenshot, and lists server errors and console errors seen
 * during the flow.
 *
 * A flow is a .ts/.js/.mjs file in flows.dir (no imports needed):
 *
 *   export default {
 *     name: "Create a promotion",
 *     app: "business",          // web app from the config; logs in with its account
 *     writes: true,             // changes data → runs only when allowMutations is on (default true)
 *     async run({ page, step, see, unique }) {
 *       await step("Open promotions", () => page.goto("/promotions"));   // paths are relative to the app
 *       await step("Fill the form", async () => {
 *         await page.getByLabel("Title").fill(unique("QA promo"));
 *         await page.getByRole("button", { name: "Save" }).click();
 *       });
 *       await see("Promotion created");
 *     },
 *   };
 *
 * Record the clicks with `npx playwright codegen <dashboard URL>` and paste them into run().
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import type { Finding, QaPlugin } from "../core/types.js";
import type { RunContext } from "../core/context.js";
import type { WebAppConfig } from "../core/config.js";
import { login, slugOf } from "../web/crawler.js";

export interface FlowContext {
  page: Page;
  /** Name a step; a failure inside it is reported with this name */
  step: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>;
  /** Wait until this text (or regex) is visible on the page */
  see: (text: string | RegExp, timeoutMs?: number) => Promise<void>;
  /** A value that differs on every run, e.g. unique("QA promo") → "QA promo 1731080000123" */
  unique: (prefix: string) => string;
  app: WebAppConfig;
  account: string;
}

export interface FlowFile {
  name: string;
  app: string;
  account?: string;
  writes?: boolean;
  /** Skip logging in (flows that test the login itself) */
  login?: boolean;
  /** Report the flow as slow above this, in ms */
  maxMs?: number;
  run: (ctx: FlowContext) => Promise<void>;
}

export function listFlowFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(m?[jt]s)$/.test(f) && !f.endsWith(".d.ts")).sort().map((f) => path.join(dir, f));
}

export const flowsPlugin: QaPlugin = {
  name: "flows",
  layer: "web",
  description: "Scripted business flows through the dashboards (logged in, real browser)",
  skipReason(ctx) {
    const dir = path.resolve(ctx.configDir, ctx.config.flows.dir);
    return listFlowFiles(dir).length ? null : `no flow files in ${path.relative(process.cwd(), dir) || dir}`;
  },
  async run(ctx) {
    const F = ctx.config.flows;
    const dir = path.resolve(ctx.configDir, F.dir);
    const shots = path.join(ctx.outDir, "flows");
    fs.mkdirSync(shots, { recursive: true });
    const findings: Finding[] = [];
    const stats: Record<string, string | number> = { passed: 0, failed: 0, skipped: 0 };
    let browser: Browser | undefined;
    try {
      for (const file of listFlowFiles(dir)) {
        const rel = path.relative(ctx.configDir, file);
        let flow: FlowFile;
        try {
          const mod = await import(pathToFileURL(file).href);
          flow = mod.default ?? mod.flow;
          if (!flow?.name || typeof flow.run !== "function") throw new Error("export default { name, app, run } expected");
        } catch (e) {
          findings.push({ plugin: this.name, severity: "medium", category: "config", target: `flow ${rel}`, title: `Flow file can't be loaded: ${(e as Error).message.split("\n")[0]}`, evidence: { file: rel } });
          stats.failed = Number(stats.failed) + 1;
          continue;
        }
        const target = `flow ${flow.name}`;
        const app = ctx.config.web.apps.find((a) => a.name === flow.app);
        if (!app?.baseUrl) {
          stats.skipped = Number(stats.skipped) + 1;
          stats[flow.name] = `skipped: dashboard "${flow.app}" has no URL`;
          continue;
        }
        if ((flow.writes ?? true) && !ctx.config.allowMutations) {
          stats.skipped = Number(stats.skipped) + 1;
          stats[flow.name] = "skipped: changes data and allowMutations is off";
          continue;
        }
        const account = flow.account ?? app.account;
        if (flow.login !== false && !ctx.config.accounts[account]) {
          stats.skipped = Number(stats.skipped) + 1;
          stats[flow.name] = `skipped: account "${account}" has no login`;
          continue;
        }

        browser ??= await chromium.launch({
          executablePath: process.env.QA_CHROMIUM_PATH || undefined,
          args: process.env.QA_CHROMIUM_ARGS ? process.env.QA_CHROMIUM_ARGS.split(/\s+/).filter(Boolean) : undefined,
        });
        const context = await browser.newContext({ viewport: ctx.config.web.viewport, baseURL: app.baseUrl.replace(/\/?$/, "/"), locale: "en-US" });
        context.setDefaultTimeout(F.stepTimeoutMs);
        const page = await context.newPage();
        // page.goto("/x") should mean the app's /x, also when the app lives under a sub-path
        const goto = page.goto.bind(page);
        page.goto = ((url: string, opts?: Parameters<Page["goto"]>[1]) => goto(/^https?:\/\//.test(url) ? url : app.baseUrl + (url.startsWith("/") ? url : `/${url}`), opts)) as Page["goto"];
        const serverErrors: string[] = [];
        const consoleErrors: string[] = [];
        page.on("response", (r) => { if (r.status() >= 500) serverErrors.push(`${r.request().method()} ${r.url()} → ${r.status()}`); });
        page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
        page.on("pageerror", (e) => consoleErrors.push(`${e.name}: ${e.message}`.slice(0, 200)));

        let current = "Log in";
        let depth = 0; // see() inside step() keeps the step's name
        const steps: string[] = [];
        const started = Date.now();
        let failure: string | undefined;
        try {
          if (flow.login !== false) {
            const err = await login(page, { ...app, account }, ctx);
            if (err) throw new Error(err);
          }
          const fctx: FlowContext = {
            page, app, account,
            step: async (name, fn) => {
              if (depth === 0) current = name;
              depth++;
              try { const r = await fn(); if (depth === 1) steps.push(name); return r; } finally { depth--; }
            },
            see: async (text, timeoutMs) => {
              const label = `See "${String(text)}"`;
              if (depth === 0) current = label;
              await page.getByText(text).first().waitFor({ state: "visible", timeout: timeoutMs ?? F.stepTimeoutMs });
              if (depth === 0) steps.push(label);
            },
            unique: (prefix) => `${prefix} ${Date.now()}`,
          };
          await Promise.race([
            flow.run(fctx),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`flow took longer than ${F.timeoutMs} ms`)), F.timeoutMs)),
          ]);
        } catch (e) {
          failure = String((e as Error).message ?? e).split("\n")[0].slice(0, 300);
        }
        const ms = Date.now() - started;
        const shot = path.join(shots, `${slugOf("/" + flow.name)}.png`);
        await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
        const lastUrl = page.url();
        await context.close().catch(() => {});
        const log = [
          `Steps done: ${steps.length ? steps.join(" → ") : "none"}`,
          serverErrors.length ? `Server errors:\n${[...new Set(serverErrors)].slice(0, 8).join("\n")}` : "",
          consoleErrors.length ? `Console errors:\n${[...new Set(consoleErrors)].slice(0, 5).join("\n")}` : "",
        ].filter(Boolean).join("\n\n");
        const evidence = { url: lastUrl, image: fs.existsSync(shot) ? path.relative(ctx.outDir, shot) : undefined, file: rel, log };
        if (failure) {
          stats.failed = Number(stats.failed) + 1;
          stats[flow.name] = `failed at "${current}"`;
          findings.push({
            plugin: this.name, severity: F.severity, category: "regression", target,
            title: `Flow "${flow.name}" failed at step "${current}"`,
            detail: `${failure}${serverErrors.length ? `\n\n${serverErrors.length} server error(s) during the flow, first: ${serverErrors[0]}` : ""}`,
            evidence,
          });
          continue;
        }
        stats.passed = Number(stats.passed) + 1;
        stats[flow.name] = `passed in ${(ms / 1000).toFixed(1)} s`;
        const maxMs = flow.maxMs ?? F.maxMs;
        if (ms > maxMs) {
          findings.push({ plugin: this.name, severity: "medium", category: "performance", target: `${target} duration`, title: `Flow "${flow.name}" is slow: ${(ms / 1000).toFixed(1)} s (limit ${(maxMs / 1000).toFixed(0)} s)`, evidence });
        }
        if (serverErrors.length) {
          findings.push({ plugin: this.name, severity: "medium", category: "regression", target: `${target} server errors`, title: `Flow "${flow.name}" passed but the server returned ${serverErrors.length} error(s)`, detail: serverErrors[0], evidence });
        }
      }
    } finally {
      await browser?.close().catch(() => {});
    }
    return { findings, stats };
  },
};
