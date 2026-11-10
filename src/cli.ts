#!/usr/bin/env node
/**
 * qa: plugin-first QA agent.
 *
 *   qa run --suite pr|staging|nightly|local [options]   run a suite and write reports
 *   qa discover                                          write routes.json + openapi.json
 *   qa wait-for --url <base> [--fresh]                   wait until a deploy is live
 *   qa run --only web-crawl,web-visual --update-visual    approve current dashboard screenshots
 *   qa run --suite staging --upload                      also send the run to the QA platform
 *                                                        (QA_PLATFORM_URL, QA_PLATFORM_API_KEY, optional QA_PLATFORM_ENV)
 *     --platform-accounts                                take test-account logins from the platform's vault
 *                                                        (needs an API key with "read test-account passwords")
 *     --after-deploy [--deploy-version v1.2.3]           report a deployment first and link the run to it
 *     --routes-file routes.json                          test a deployment without the source: routes from a
 *                                                        project profile instead of discovery (hosted runner)
 *     --github                                           in GitHub Actions: job summary, annotations, sticky PR
 *                                                        comment, "QA gate" commit status, step outputs
 *                                                        (GITHUB_TOKEN; QA_GITHUB_COMMENT/QA_GITHUB_STATUS=false to skip)
 *   qa plugins                                           list available plugins
 *
 * Exit codes: 0 gate passed · 1 gate failed · 2 usage/config error · 3 target unreachable
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./core/config.js";
import { makeLogger, type RunContext } from "./core/context.js";
import { HttpClient } from "./core/http.js";
import { AuthProvider } from "./core/auth.js";
import { runPlugins } from "./core/runner.js";
import { gate, loadKnownIssues, triage, writeBaseline } from "./core/triage.js";
import { writeReports, type RunSummary } from "./core/report.js";
import { fetchAccounts, reportDeployment, uploadRun, type UploadResult } from "./core/upload.js";
import { buildProfile, routesFromProfile } from "./core/profile.js";
import { annotations, appendFileEnv, githubContext, gitInfo, prCommentBody, setCommitStatus, statusFor, triggerFrom, upsertPrComment, writeOutputs } from "./core/github.js";
import { changedFiles, selectRoutes } from "./core/changes.js";
import { discoverRoutes } from "./discovery/express-routes.js";
import { buildOpenApi } from "./discovery/openapi.js";
import { PLUGINS, pluginByName } from "./plugins/index.js";
import type { Suite } from "./core/types.js";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", short: "c", default: "qa.config.ts" },
    suite: { type: "string", short: "s", default: "local" },
    "base-url": { type: "string" },
    "backend-dir": { type: "string" },
    "changed-from": { type: "string" },
    only: { type: "string" },
    out: { type: "string", default: "qa-out" },
    "allow-mutations": { type: "boolean" },
    baseline: { type: "boolean", default: false },
    "update-visual": { type: "boolean", default: false },
    upload: { type: "boolean", default: false },
    "platform-env": { type: "string" },
    "platform-accounts": { type: "boolean", default: false },
    "after-deploy": { type: "boolean", default: false },
    "deploy-version": { type: "string" },
    github: { type: "boolean", default: false },
    "routes-file": { type: "string" },
    verbose: { type: "boolean", short: "v", default: false },
    url: { type: "string" },
    path: { type: "string", default: "/health" },
    timeout: { type: "string", default: "900" },
    fresh: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const log = makeLogger(!!opt.verbose);

// Local runs: load credentials from .env.qa if present (CI passes real env vars instead)
const envFile = path.resolve(".env.qa");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const cmd = positionals[0] ?? "help";

const platform = () => {
  const url = process.env.QA_PLATFORM_URL;
  const apiKey = process.env.QA_PLATFORM_API_KEY;
  return url && apiKey ? { url, apiKey, environmentId: opt["platform-env"] ?? process.env.QA_PLATFORM_ENV } : null;
};

/** Test-account logins from the platform vault (--platform-accounts). Masked in GitHub logs. */
async function platformAccounts() {
  if (!opt["platform-accounts"] && process.env.QA_PLATFORM_ACCOUNTS !== "true") return undefined;
  const p = platform();
  if (!p?.environmentId) throw new Error("--platform-accounts needs QA_PLATFORM_URL, QA_PLATFORM_API_KEY and an environment (--platform-env or QA_PLATFORM_ENV)");
  const accounts = await fetchAccounts(p, p.environmentId);
  if (process.env.GITHUB_ACTIONS === "true") for (const a of accounts) console.log(`::add-mask::${a.secret}`);
  return accounts;
}

async function setup(withDiscovery = true) {
  const { config, configDir, fromPlatform } = await loadConfig(opt.config!, {
    baseUrl: opt["base-url"] ?? process.env.QA_BASE_URL,
    backendDir: opt["backend-dir"] ?? process.env.QA_BACKEND_DIR,
    allowMutations: opt["allow-mutations"] ?? (process.env.QA_ALLOW_MUTATIONS === "true" ? true : undefined),
    platformAccounts: await platformAccounts(),
  });
  if (fromPlatform.length) log.info(`Test accounts from the platform: ${fromPlatform.join(", ")}`);
  const outDir = path.resolve(opt.out!);
  fs.mkdirSync(outDir, { recursive: true });
  // Without source (hosted runner): the route list comes from a project profile
  if (opt["routes-file"]) {
    const routes = routesFromProfile(JSON.parse(fs.readFileSync(opt["routes-file"], "utf8")));
    log.info(`${routes.length} routes from ${path.basename(opt["routes-file"])} (no source)`);
    return { config, configDir, outDir, routes, fromSource: false };
  }
  if (config.backend.none) {
    log.info("No backend source (backend: false): checks that read routes are skipped");
    return { config, configDir, outDir, routes: [], fromSource: false };
  }
  if (!fs.existsSync(config.backend.dir)) throw new Error(`Backend dir not found: ${config.backend.dir} (set QA_BACKEND_DIR)`);
  const discovery = withDiscovery ? discoverRoutes({ backendDir: config.backend.dir, routesIndex: config.backend.routesIndex, apiPrefix: config.backend.apiPrefix, appFile: config.backend.appFile }) : { routes: [], warnings: [] };
  for (const w of discovery.warnings) log.warn(w);
  return { config, configDir, outDir, routes: discovery.routes, fromSource: withDiscovery };
}

async function cmdDiscover() {
  const { config, outDir, routes } = await setup();
  fs.writeFileSync(path.join(outDir, "routes.json"), JSON.stringify(routes.map(({ routerFile, ...r }) => r), null, 2));
  const oa = await buildOpenApi(routes, { title: `${config.project} API`, serverUrl: config.target.baseUrl, outFile: path.join(outDir, "openapi.json") });
  log.info(`${routes.length} routes → ${path.join(outDir, "routes.json")}`);
  log.info(`OpenAPI → ${oa.file} (request schemas from zod: ${oa.zodResolved}${oa.zodFailedFiles.length ? `, ${oa.zodFailedFiles.length} validation file(s) not loadable: install backend node_modules for full schemas` : ""})`);
  return 0;
}

async function cmdRun() {
  const started = Date.now();
  const suite = opt.suite as Suite;
  const { config, configDir, outDir, routes, fromSource } = await setup();

  const names = opt.only ? opt.only.split(",").map((s) => s.trim()) : config.suites[suite];
  if (!names?.length) throw new Error(`Suite "${suite}" has no plugins in ${opt.config}`);
  const unknown = names.filter((n) => !pluginByName.has(n));
  if (unknown.length) throw new Error(`Unknown plugin(s): ${unknown.join(", ")}. Run "qa plugins".`);
  const plugins = names.map((n) => pluginByName.get(n)!);

  // Route selection from the git diff
  let targetRoutes = routes;
  let files: string[] | null = null;
  let selectionReason = "all routes";
  if (opt["changed-from"]) {
    files = changedFiles(config.backend.dir, opt["changed-from"]);
    const sel = selectRoutes(routes, files, config);
    targetRoutes = sel.routes;
    selectionReason = `${files.length} changed file(s), ${sel.reason}`;
  }
  log.info(`${config.project} · suite ${suite} · ${routes.length} routes discovered, ${targetRoutes.length} selected (${selectionReason})`);

  let openapiPath: string | undefined;
  if (plugins.some((p) => p.needs?.includes("openapi"))) {
    const oa = await buildOpenApi(routes, { title: `${config.project} API`, serverUrl: config.target.baseUrl, outFile: path.join(outDir, "openapi.json") });
    openapiPath = oa.file;
  }

  const ctx: RunContext = { suite, config, configDir, outDir, routes, targetRoutes, changedFiles: files, openapiPath, log, selectedPlugins: names, updateVisual: !!opt["update-visual"] };
  let envError: string | undefined;
  if (config.target.baseUrl) {
    ctx.http = new HttpClient(config.target.baseUrl, config.target.requestsPerMinute, config.target.timeoutMs);
    ctx.auth = new AuthProvider(config, ctx.http);
    const ping = await ctx.http.send({ method: "GET", path: config.backend.healthPath });
    if (ping.networkError || ping.status >= 500) {
      envError = `${config.target.baseUrl}${config.backend.healthPath} → ${ping.networkError ?? `HTTP ${ping.status}`}`;
      log.warn(`Target unhealthy, live plugins skipped: ${envError}`);
      delete ctx.http; delete ctx.auth;
      config.target.baseUrl = undefined;
    }
  }

  let results = await runPlugins(plugins, ctx);
  const knownFile = path.resolve(configDir, config.knownIssuesFile);
  results = triage(results, loadKnownIssues(knownFile));
  if (opt.baseline) {
    const n = writeBaseline(knownFile, results, loadKnownIssues(knownFile));
    log.info(`Baseline written: ${n} known issue(s) in ${knownFile}`);
    results = triage(results, loadKnownIssues(knownFile));
  }
  const g = gate(results, config.gate.failOn);
  const gh = githubContext();
  const summary: RunSummary = {
    project: config.project, suite, target: ctx.http ? config.target.baseUrl : envError ? "unreachable" : undefined,
    startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
    routesTotal: routes.length, routesSelected: targetRoutes.length, selectionReason,
    requests: ctx.http?.requestCount ?? 0, results,
    gate: { failOn: config.gate.failOn, passed: g.blocking.length === 0 && !envError, blocking: g.blocking.length, envError },
    git: gh ? gitInfo(gh) : { sha: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF_NAME, pr: process.env.QA_PR_NUMBER },
  };
  writeReports(outDir, summary);
  log.info(`Findings: ${g.all.length} total, ${g.newFindings.length} new, ${g.blocking.length} blocking (gate: ${config.gate.failOn}+)`);
  log.info(`Reports: ${path.join(outDir, "report.html")} · summary.md · report.json`);
  let uploaded: UploadResult | null = null;
  if (opt.upload) {
    const p = platform();
    if (!p) {
      log.warn("--upload needs QA_PLATFORM_URL and QA_PLATFORM_API_KEY; run not uploaded");
    } else {
      try {
        const afterDeploy = !!opt["after-deploy"];
        let deploymentId: string | undefined;
        if (afterDeploy) {
          const d = await reportDeployment(p, { environmentId: p.environmentId, sha: summary.git?.sha, ref: summary.git?.ref, version: opt["deploy-version"] ?? process.env.QA_DEPLOY_VERSION, url: config.target.baseUrl });
          deploymentId = d.id;
          log.info(`Deployment reported to the platform: ${d.id}`);
        }
        const trigger = gh ? triggerFrom(gh.eventName, afterDeploy) : afterDeploy ? "deploy" : undefined;
        // Runs that read the source also refresh the profile the hosted runner works from
        const profile = fromSource && routes.length ? buildProfile(config, routes) : undefined;
        uploaded = await uploadRun(summary, { ...p, trigger, deploymentId, profile });
        log.info(`Uploaded to platform: run ${uploaded.runId} · ${uploaded.newIssues} new, ${uploaded.fixedIssues} fixed, ${uploaded.reopenedIssues} reopened issue(s)${uploaded.runUrl ? ` · ${uploaded.runUrl}` : ""}`);
      } catch (e: any) {
        // The quality gate stays authoritative: an upload problem is reported, not turned into a test failure
        log.warn(`Upload failed: ${e?.message ?? e}`);
      }
    }
  }
  const code = envError ? 3 : g.blocking.length ? 1 : 0;
  if (opt.github) await github(summary, { backendDir: config.backend.dir, outDir, runUrl: uploaded?.runUrl ?? null, code });
  return code;
}

/** --github: everything GitHub shows about the run. Never changes the exit code. */
async function github(summary: RunSummary, o: { backendDir: string; outDir: string; runUrl: string | null; code: number }) {
  const g = githubContext();
  if (!g) {
    log.warn("--github: not running in GitHub Actions (GITHUB_ACTIONS/GITHUB_REPOSITORY not set); skipped");
    return;
  }
  const body = prCommentBody(fs.readFileSync(path.join(o.outDir, "summary.md"), "utf8"), { runUrl: o.runUrl, ciUrl: g.runUrl });
  appendFileEnv("GITHUB_STEP_SUMMARY", body);
  for (const line of annotations(summary, { backendDir: o.backendDir, workspace: g.workspace })) console.log(line);
  writeOutputs({ "exit-code": o.code, blocking: summary.gate.blocking, "gate-passed": String(o.code === 0), "run-url": o.runUrl, "report-dir": o.outDir });
  const token = process.env.QA_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    log.warn("--github: no GITHUB_TOKEN; skipped the PR comment and commit status");
    return;
  }
  if (g.prNumber && process.env.QA_GITHUB_COMMENT !== "false") {
    try {
      log.info(`PR #${g.prNumber} comment ${await upsertPrComment(g, token, body)}`);
    } catch (e: any) { log.warn(`PR comment failed: ${e?.message ?? e}`); }
  }
  if (process.env.QA_GITHUB_STATUS !== "false") {
    try {
      await setCommitStatus(g, token, { ...statusFor(summary), targetUrl: o.runUrl ?? g.runUrl });
      log.info(`Commit status "QA gate" set on ${g.sha?.slice(0, 8)}`);
    } catch (e: any) { log.warn(`Commit status failed: ${e?.message ?? e}`); }
  }
}

/** Wait until the target is healthy. With --fresh, also wait until the process started after this command did (a new deploy). */
async function cmdWaitFor() {
  const base = (opt.url ?? process.env.QA_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("--url (or QA_BASE_URL) is required");
  const deadline = Date.now() + Number(opt.timeout) * 1000;
  const startedAt = Date.now();
  log.info(`Waiting for ${base}${opt.path}${opt.fresh ? " (fresh deploy)" : ""}, up to ${opt.timeout}s`);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + opt.path, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const body: any = await res.json().catch(() => ({}));
        const uptime = Number(body.uptime);
        const sinceStart = (Date.now() - startedAt) / 1000;
        if (!opt.fresh || (Number.isFinite(uptime) && uptime <= sinceStart + 30)) {
          log.info(`Ready (uptime ${Number.isFinite(uptime) ? uptime.toFixed(0) + "s" : "n/a"})`);
          return 0;
        }
        log.debug(`healthy but old process (uptime ${uptime.toFixed(0)}s), waiting for the new deploy`);
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 10000));
  }
  log.warn("Timed out waiting for the target");
  return 3;
}

function cmdPlugins() {
  for (const p of PLUGINS) console.log(`${p.name.padEnd(18)} ${p.layer.padEnd(7)} ${p.description}${p.needs?.length ? `  [needs: ${p.needs.join(", ")}]` : ""}`);
  return 0;
}

function help() {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*?/, "").replace(/^ \* ?/gm, ""));
  return 0;
}

const commands: Record<string, () => Promise<number> | number> = { run: cmdRun, discover: cmdDiscover, "wait-for": cmdWaitFor, plugins: cmdPlugins, help };
const fn = opt.help ? help : commands[cmd];
if (!fn) {
  console.error(`Unknown command "${cmd}". Try: qa help`);
  process.exit(2);
}
Promise.resolve(fn())
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`qa: ${e?.message ?? e}`);
    process.exit(2);
  });
