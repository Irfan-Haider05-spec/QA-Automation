import type { RunContext } from "./context.js";
import type { PluginResult, QaPlugin } from "./types.js";
import { findingSchema } from "./plugin-sdk.js";
import { redactText, redactValue } from "./redact.js";
import { sanitizeEvidenceText } from "./http.js";

const GENERIC_REMEDIATION = "Review the evidence, correct the reported behavior, and rerun the same check.";
/** Default next step per check, used when a finding does not carry its own. */
export const DEFAULT_REMEDIATION: Record<string, string> = {
  "route-auth": "Add the authentication middleware to the route, or list it in publicRoutes in qa.config.ts if it is meant to be public.",
  "env-drift": "Add the missing keys to .env.example (without real values) or remove keys the code no longer reads.",
  secrets: "Remove the secret from the code and its history, rotate it at the provider, and load it from an environment variable.",
  deps: "Upgrade the affected package to a fixed version (npm audit shows it) and rerun the tests.",
  "health-cors": "Fix the health endpoint, and allow only the known dashboard origins in the CORS configuration (no wildcard with credentials).",
  "api-smoke": "Fix the server error shown in the evidence; a 5xx on a valid request means unhandled input or a failing dependency.",
  "tenant-isolation": "Filter every query by the caller's own merchant/tenant id on the server, and return 404 for records of other tenants.",
  "socket-fanout": "Send socket events only to the rooms of the user or tenant they belong to, and check the token on connection.",
  "load-smoke": "Find the slow or failing endpoint in the evidence and fix the query, index or dependency behind it before the next load test.",
  "zap-baseline": "Apply the header or configuration change ZAP names in the finding, then rerun the scan.",
  "api-fuzz": "Validate the request body with a schema and return 400 for invalid input instead of a server error.",
  "web-crawl": "Fix the broken page, failed request or console error shown in the evidence.",
  "web-a11y": "Fix the accessibility rule named in the finding (labels, contrast, roles) on the listed elements.",
  "web-visual": "If the change is intended, update the visual baseline; otherwise fix the layout change shown in the diff.",
  lighthouse: "Improve the metric named in the finding (for example image size, render-blocking scripts or caching).",
  flows: "Fix the step where the flow failed, using the screenshot and error in the evidence.",
  mobile: "Fix the step where the mobile flow failed, using the screenshot and log in the evidence.",
};

const PLUGIN_TIMEOUT_MS = 20 * 60 * 1000;

function requirementGap(p: QaPlugin, ctx: RunContext): string | null {
  for (const need of p.needs ?? []) {
    if (need === "baseUrl" && !ctx.config.target.baseUrl) return "no target URL (set QA_BASE_URL or --base-url)";
    if (need === "accounts" && !Object.keys(ctx.config.accounts).length) return "no QA accounts configured (QA_* credentials missing)";
    if (need === "openapi" && !ctx.openapiPath) return "no OpenAPI spec generated";
    if (need === "backendDir" && ctx.config.backend.none) return "no backend source (backend: false in the config)";
    if (need === "webApps" && !ctx.config.web.apps.some((a) => a.baseUrl)) return "no dashboard URLs configured (QA_ADMIN_WEB_URL / QA_BUSINESS_WEB_URL)";
  }
  return null;
}

/**
 * Whether any selected plugin that will actually run talks to the target API. Plugins
 * that will be skipped (not configured, missing prerequisite) do not count. When this is
 * false the CLI does not health-check the target, so a static-only run is not failed by
 * an unrelated unreachable API.
 */
export function targetNeeded(plugins: QaPlugin[], ctx: RunContext): boolean {
  return plugins.some((p) => {
    try {
      if (requirementGap(p, ctx) || p.skipReason?.(ctx)) return false;
      return p.usesTarget ? p.usesTarget(ctx) : !!p.needs?.includes("baseUrl") || p.layer !== "static";
    } catch { return true; } // unreadable settings: check the target, as before
  });
}

async function runOne(p: QaPlugin, ctx: RunContext): Promise<PluginResult> {
  const started = Date.now();
  try {
  const skip = requirementGap(p, ctx) ?? p.skipReason?.(ctx) ?? null;
  if (skip) {
    ctx.log.info(`○ ${p.name}: skipped (${skip})`);
    return { plugin: p.name, status: "skipped", reason: skip, durationMs: 0, findings: [] };
  }
  ctx.log.info(`▶ ${p.name}`);
    let timer: NodeJS.Timeout | undefined;
    const out = await Promise.race([
      p.run(ctx),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`plugin timed out after ${PLUGIN_TIMEOUT_MS / 60000} min`)), PLUGIN_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    const raw = Array.isArray(out) ? out : out.findings;
    if (!Array.isArray(raw) || raw.length > 5000) throw new Error("Plugin output must contain at most 5000 findings");
    if (p.confirm) for (const finding of raw) {
      const confirmation = await p.confirm(ctx, finding);
      if (confirmation === "cleared") finding.flaky = true;
    }
    const secrets = ctx.auth?.secretValues() ?? Object.values(ctx.config.accounts).flatMap((a) => [a.password, a.apiKey, a.accessToken].filter((v): v is string => !!v));
    const findings = raw.map((f) => {
      findingSchema.parse(f);
      if (f.plugin !== p.name) throw new Error("Plugin returned findings under another plugin's name");
      if (f.evidence?.image) f.evidence.image = f.evidence.image.replace(/\\/g, "/");
      if (f.evidence?.responseSnippet) f.evidence.responseSnippet = sanitizeEvidenceText(f.evidence.responseSnippet);
      return redactValue({ ...f, confidence: f.confidence ?? "medium", remediation: f.remediation ?? DEFAULT_REMEDIATION[p.name] ?? GENERIC_REMEDIATION }, secrets);
    });
    const stats = Array.isArray(out) ? undefined : out.stats;
    const cases = Array.isArray(out) ? undefined : out.cases;
    if (cases && (!Array.isArray(cases) || cases.length > 2000)) throw new Error("Plugin output must contain at most 2000 cases");
    const durationMs = Date.now() - started;
    ctx.log.info(`  ${p.name}: ${findings.length} finding(s) in ${(durationMs / 1000).toFixed(1)}s`);
    return { plugin: p.name, status: findings.length ? "failed" : "passed", durationMs, findings, stats, ...(cases?.length ? { cases } : {}) };
  } catch (e: any) {
    if (e?.name === "SkipError") {
      ctx.log.info(`○ ${p.name}: skipped (${e.message})`);
      return { plugin: p.name, status: "skipped", reason: e.message, durationMs: Date.now() - started, findings: [] };
    }
    const reason = redactText(String(e?.message ?? e), ctx.auth?.secretValues() ?? []);
    ctx.log.warn(`${p.name} errored: ${reason}`);
    return { plugin: p.name, status: "errored", reason, durationMs: Date.now() - started, findings: [] };
  }
}

/** Static plugins run in parallel; plugins that hit the API share one throttled client and run in order. */
export async function runPlugins(plugins: QaPlugin[], ctx: RunContext): Promise<PluginResult[]> {
  const staticOnes = plugins.filter((p) => p.layer === "static");
  // Web plugins log in through the dashboards. The backend keeps one session per
  // user, so they must run after the API plugins have finished with their tokens.
  const liveOnes = [...plugins.filter((p) => p.layer !== "static" && p.layer !== "web" && p.name !== "auth-session"),
    ...plugins.filter((p) => p.name === "auth-session"), ...plugins.filter((p) => p.layer === "web")];
  const staticResults = await Promise.all(staticOnes.map((p) => runOne(p, ctx)));
  const liveResults: PluginResult[] = [];
  for (const p of liveOnes) liveResults.push(await runOne(p, ctx));
  const order = new Map(plugins.map((p, i) => [p.name, i]));
  return [...staticResults, ...liveResults].sort((a, b) => order.get(a.plugin)! - order.get(b.plugin)!);
}
