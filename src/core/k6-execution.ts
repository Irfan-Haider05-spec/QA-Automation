import fs from "node:fs";
import path from "node:path";
import type { RunContext } from "./context.js";
import { runBoundedProcess } from "./bounded-process.js";

export interface K6Execution {
  path: string; account?: string; executable: string; vus: number; iterations: number;
  requestsPerSecond: number; maxDurationSeconds: number; requestTimeoutMs: number;
}

/** Generated GET-only load probe: no arbitrary scripts, imports, redirects or CLI flags. */
export async function executeK6(ctx: RunContext, c: K6Execution, limits: { maxP95Ms: number; maxErrorRate: number }) {
  if (!ctx.config.allowMutations || !ctx.config.disposable) throw new Error("k6 execution requires allowMutations and disposable");
  if (!ctx.config.target.baseUrl) throw new Error("k6 execution requires target.baseUrl");
  const base = new URL(ctx.config.target.baseUrl);
  const target = new URL(ctx.config.target.baseUrl.replace(/\/$/, "") + c.path);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash || target.origin !== base.origin || target.search || target.hash) throw new Error("k6 target must be same-origin without credentials, query or fragment");
  if (c.requestsPerSecond * 60 > ctx.config.target.requestsPerMinute) throw new Error("k6 request rate exceeds the configured target budget");
  if (c.iterations / c.requestsPerSecond >= c.maxDurationSeconds) throw new Error("k6 duration cannot accommodate the requested iterations and rate");
  let headers: Record<string, string> = {};
  if (c.account) {
    const resolved = await ctx.auth?.header(c.account);
    if (!resolved) throw new Error("k6 account could not authenticate");
    headers = resolved;
  }
  fs.mkdirSync(ctx.outDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(path.resolve(ctx.outDir), "k6-"));
  const report = path.join(dir, "summary.json"), script = path.join(dir, "probe.js"), config = path.join(dir, "config.json");
  fs.writeFileSync(config, "{}", { mode: 0o600 });
  const options = {
    scenarios: { probe: { executor: "shared-iterations", vus: c.vus, iterations: c.iterations, maxDuration: `${c.maxDurationSeconds}s`, gracefulStop: "0s" } },
    rps: c.requestsPerSecond, maxRedirects: 0, discardResponseBodies: true,
    summaryTrendStats: ["p(95)"], systemTags: [],
    thresholds: { http_req_duration: [`p(95)<=${limits.maxP95Ms}`], http_req_failed: [`rate<=${limits.maxErrorRate}`] },
  };
  fs.writeFileSync(script, `import http from 'k6/http';
export const options = ${JSON.stringify(options)};
http.setResponseCallback(http.expectedStatuses({min:200,max:299}));
export default function () { http.get(__ENV.VERIQ_K6_TARGET, {headers:JSON.parse(__ENV.VERIQ_K6_HEADERS),redirects:0,timeout:'${c.requestTimeoutMs}ms'}); }
export function handleSummary(data) { return { [__ENV.VERIQ_K6_REPORT]: JSON.stringify(data) }; }
`, { mode: 0o600 });
  // Do not inherit K6_* flags, cloud tokens, proxy credentials or application secrets.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (/^(path|systemroot|windir|temp|tmp|tmpdir|home|userprofile|appdata|localappdata)$/i.test(key)) env[key] = value;
  Object.assign(env, { VERIQ_K6_TARGET: target.href, VERIQ_K6_HEADERS: JSON.stringify(headers), VERIQ_K6_REPORT: report });
  const exitCode = await runBoundedProcess({ command: c.executable, args: ["run", "--quiet", "--no-usage-report", "--config", config, script], cwd: ctx.configDir, timeoutMs: (c.maxDurationSeconds + 10) * 1000, env });
  if (exitCode !== 0 && exitCode !== 99) throw new Error("k6 execution failed; no report accepted");
  try {
    const stat = fs.lstatSync(report);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 20 * 1024 * 1024) throw new Error("Invalid report");
  } catch { throw new Error("k6 did not produce a fresh regular summary report"); }
  return { report, exitCode };
}
