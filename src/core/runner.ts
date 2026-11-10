import type { RunContext } from "./context.js";
import type { PluginResult, QaPlugin } from "./types.js";

const PLUGIN_TIMEOUT_MS = 20 * 60 * 1000;

function requirementGap(p: QaPlugin, ctx: RunContext): string | null {
  if (p.layer === "static" && ctx.config.backend.none) return "no backend source (backend: false in the config)";
  for (const need of p.needs ?? []) {
    if (need === "baseUrl" && !ctx.config.target.baseUrl) return "no target URL (set QA_BASE_URL or --base-url)";
    if (need === "accounts" && !Object.keys(ctx.config.accounts).length) return "no QA accounts configured (QA_* credentials missing)";
    if (need === "openapi" && !ctx.openapiPath) return "no OpenAPI spec generated";
    if (need === "backendDir" && ctx.config.backend.none) return "no backend source (backend: false in the config)";
    if (need === "webApps" && !ctx.config.web.apps.some((a) => a.baseUrl)) return "no dashboard URLs configured (QA_ADMIN_WEB_URL / QA_BUSINESS_WEB_URL)";
  }
  return null;
}

async function runOne(p: QaPlugin, ctx: RunContext): Promise<PluginResult> {
  const started = Date.now();
  const skip = requirementGap(p, ctx) ?? p.skipReason?.(ctx) ?? null;
  if (skip) {
    ctx.log.info(`○ ${p.name}: skipped (${skip})`);
    return { plugin: p.name, status: "skipped", reason: skip, durationMs: 0, findings: [] };
  }
  ctx.log.info(`▶ ${p.name}`);
  try {
    let timer: NodeJS.Timeout | undefined;
    const out = await Promise.race([
      p.run(ctx),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`plugin timed out after ${PLUGIN_TIMEOUT_MS / 60000} min`)), PLUGIN_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    const findings = Array.isArray(out) ? out : out.findings;
    const stats = Array.isArray(out) ? undefined : out.stats;
    const durationMs = Date.now() - started;
    ctx.log.info(`  ${p.name}: ${findings.length} finding(s) in ${(durationMs / 1000).toFixed(1)}s`);
    return { plugin: p.name, status: findings.length ? "failed" : "passed", durationMs, findings, stats };
  } catch (e: any) {
    if (e?.name === "SkipError") {
      ctx.log.info(`○ ${p.name}: skipped (${e.message})`);
      return { plugin: p.name, status: "skipped", reason: e.message, durationMs: Date.now() - started, findings: [] };
    }
    ctx.log.warn(`${p.name} errored: ${e?.message ?? e}`);
    return { plugin: p.name, status: "errored", reason: String(e?.message ?? e), durationMs: Date.now() - started, findings: [] };
  }
}

/** Static plugins run in parallel; plugins that hit the API share one throttled client and run in order. */
export async function runPlugins(plugins: QaPlugin[], ctx: RunContext): Promise<PluginResult[]> {
  const staticOnes = plugins.filter((p) => p.layer === "static");
  // Web plugins log in through the dashboards. The backend keeps one session per
  // user, so they must run after the API plugins have finished with their tokens.
  const liveOnes = [...plugins.filter((p) => p.layer !== "static" && p.layer !== "web"), ...plugins.filter((p) => p.layer === "web")];
  const staticResults = await Promise.all(staticOnes.map((p) => runOne(p, ctx)));
  const liveResults: PluginResult[] = [];
  for (const p of liveOnes) liveResults.push(await runOne(p, ctx));
  const order = new Map(plugins.map((p, i) => [p.name, i]));
  return [...staticResults, ...liveResults].sort((a, b) => order.get(a.plugin)! - order.get(b.plugin)!);
}
