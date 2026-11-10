/**
 * Load smoke: a short, capped burst of concurrent GET requests against the
 * target, to catch errors and slowdowns that only show up under load
 * (exhausted DB pools, blocking code, missing indexes).
 *
 * Safety: GET only, never more than load.maxRps requests per second in total,
 * stops after load.durationSec. HTTP 429 (the backend's rate limiter) is
 * counted separately and is not an error: allow-list the QA runner's IP on
 * staging to load-test past the limiter.
 *
 * Routes: load.routes ("GET /path", params filled from target.pathParams), or
 * the parameter-free GET routes api-smoke uses (up to load.maxRoutes).
 */
import type { Finding, QaPlugin, RouteInfo } from "../core/types.js";
import type { RunContext } from "../core/context.js";
import { fillParams } from "../core/http.js";
import { routeKey } from "./util.js";

interface Target { key: string; url: string; headers: Record<string, string>; label?: string }
interface Sample { ms: number; status: number; error?: string }

export const percentile = (sorted: number[], p: number) => {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[i]);
};

async function hit(t: Target, timeoutMs: number): Promise<Sample> {
  const started = performance.now();
  try {
    const res = await fetch(t.url, { headers: { accept: "application/json", ...t.headers }, signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer();
    return { ms: performance.now() - started, status: res.status };
  } catch (e) {
    return { ms: performance.now() - started, status: 0, error: (e as Error).name === "TimeoutError" ? `timeout after ${timeoutMs} ms` : (e as Error).message };
  }
}

async function pickTargets(ctx: RunContext): Promise<{ targets: Target[]; skipped: string[] }> {
  const { config } = ctx;
  const http = ctx.http!;
  const auth = ctx.auth!;
  const skipped: string[] = [];
  const params = config.target.pathParams;
  const known = (r: RouteInfo) => [...r.path.matchAll(/:([A-Za-z0-9_]+)/g)].every((m) => m[1] in params);
  let routes: RouteInfo[];
  if (config.load.routes.length) {
    routes = [];
    for (const k of config.load.routes) {
      const r = ctx.routes.find((x) => routeKey(x) === k);
      if (!r) { skipped.push(`${k}: not found in the backend routes`); continue; }
      if (r.method !== "GET") { skipped.push(`${k}: only GET routes are load-tested`); continue; }
      if (!known(r)) { skipped.push(`${k}: set its path params in target.pathParams`); continue; }
      routes.push(r);
    }
  } else {
    routes = ctx.targetRoutes.filter((r) => r.method === "GET" && known(r)).slice(0, config.load.maxRoutes);
  }
  const targets: Target[] = [];
  for (const r of routes) {
    let headers: Record<string, string> = {};
    let label: string | undefined;
    if (r.authRequired) {
      label = config.load.account && auth.account(config.load.account) && (!r.roles.length || r.roles.includes(auth.account(config.load.account).role))
        ? config.load.account
        : auth.accountForRoles(r.roles);
      const h = label ? await auth.header(label) : undefined;
      if (!h) { skipped.push(`${routeKey(r)}: no account with an allowed role`); continue; }
      headers = h;
    }
    targets.push({ key: routeKey(r), url: http.url(fillParams(r.path, params)), headers, label });
  }
  return { targets, skipped };
}

export const loadSmokePlugin: QaPlugin = {
  name: "load-smoke",
  layer: "perf",
  description: "Short capped burst of concurrent GETs: error rate and p95 latency under load",
  needs: ["baseUrl"],
  async run(ctx) {
    const L = ctx.config.load;
    const findings: Finding[] = [];
    const { targets, skipped } = await pickTargets(ctx);
    if (!targets.length) {
      return { findings, stats: { routes: 0, note: skipped.length ? skipped.slice(0, 3).join("; ") : "no GET routes without unknown params" } };
    }

    // Warm-up: one request per route, sequential, as the unloaded baseline
    const baseline = new Map<string, number>();
    for (const t of targets) baseline.set(t.key, (await hit(t, ctx.config.target.timeoutMs)).ms);

    // Load: `vus` workers share one rate limit of maxRps, ramping up over rampSec
    const samples = new Map<string, Sample[]>(targets.map((t) => [t.key, []]));
    const started = Date.now();
    const end = started + L.durationSec * 1000;
    let next = started;
    let i = 0;
    const slot = async () => {
      const elapsed = (Date.now() - started) / 1000;
      const rps = L.rampSec > 0 ? Math.max(1, Math.min(L.maxRps, (L.maxRps * elapsed) / L.rampSec)) : L.maxRps;
      const at = Math.max(next, Date.now());
      next = at + 1000 / rps;
      if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
    };
    const worker = async () => {
      while (Date.now() < end) {
        await slot();
        if (Date.now() >= end) break;
        const t = targets[i++ % targets.length];
        samples.get(t.key)!.push(await hit(t, ctx.config.target.timeoutMs));
      }
    };
    await Promise.all(Array.from({ length: L.vus }, worker));
    const seconds = (Date.now() - started) / 1000;

    // Results
    const all = [...samples.values()].flat();
    const limited = all.filter((s) => s.status === 429).length;
    const counted = all.filter((s) => s.status !== 429);
    const errors = counted.filter((s) => s.status === 0 || s.status >= 500);
    const lat = counted.filter((s) => s.status > 0).map((s) => s.ms).sort((a, b) => a - b);
    const errorRate = counted.length ? errors.length / counted.length : 0;
    const stats: Record<string, number | string> = {
      routes: targets.length, requests: all.length, rps: Math.round((all.length / seconds) * 10) / 10,
      p50Ms: percentile(lat, 50), p95Ms: percentile(lat, 95), maxMs: Math.round(lat.at(-1) ?? 0),
      errorRatePct: Math.round(errorRate * 1000) / 10, rateLimited: limited,
    };
    const curl = (t: Target) => `curl -i '${t.url}'${t.label ? ` -H 'authorization: Bearer $QA_TOKEN_${t.label.toUpperCase()}'` : ""}`;

    for (const t of targets) {
      const ss = samples.get(t.key)!.filter((s) => s.status !== 429);
      if (!ss.length) continue;
      const errs = ss.filter((s) => s.status === 0 || s.status >= 500);
      const sorted = ss.filter((s) => s.status > 0).map((s) => s.ms).sort((a, b) => a - b);
      const p95 = percentile(sorted, 95);
      const p50 = percentile(sorted, 50);
      const rate = errs.length / ss.length;
      const log = `${ss.length} requests · p50 ${p50} ms · p95 ${p95} ms · errors ${errs.length}${errs[0] ? ` (first: ${errs[0].error ?? `HTTP ${errs[0].status}`})` : ""}`;
      if (rate > L.thresholds.errorRate) {
        findings.push({
          plugin: this.name, severity: "high", category: "performance", target: t.key,
          title: `Errors under load: ${Math.round(rate * 100)}% of ${ss.length} requests failed`,
          detail: `At up to ${L.maxRps} requests/s from ${L.vus} concurrent clients.`,
          evidence: { url: t.url, status: errs[0]?.status || undefined, curl: curl(t), log },
        });
        continue;
      }
      if (p95 > L.thresholds.p95Ms) {
        findings.push({
          plugin: this.name, severity: "medium", category: "performance", target: t.key,
          title: `Slow under load: p95 ${p95} ms (limit ${L.thresholds.p95Ms} ms)`,
          evidence: { url: t.url, curl: curl(t), log },
        });
        continue;
      }
      const base = baseline.get(t.key) ?? 0;
      if (p95 > 500 && base > 0 && p95 > base * L.thresholds.slowdownFactor) {
        findings.push({
          plugin: this.name, severity: "medium", category: "performance", target: t.key,
          title: `Response time grows under load: p95 ${p95} ms vs ${Math.round(base)} ms alone`,
          detail: "Often a blocking call, a missing database index or a small connection pool.",
          evidence: { url: t.url, curl: curl(t), log },
        });
      }
    }
    if (limited) {
      findings.push({
        plugin: this.name, severity: "low", category: "config", target: "load rate limiter",
        title: `Rate limiter answered ${limited} of ${all.length} requests with 429`,
        detail: `Those requests weren't counted. To test past the limiter, allow-list the QA runner's IP on staging or lower load.maxRps (now ${L.maxRps}).`,
      });
    }
    if (skipped.length) stats.skipped = skipped.length;
    return { findings, stats };
  },
};
