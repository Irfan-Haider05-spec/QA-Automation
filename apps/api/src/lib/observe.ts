/**
 * Request ids, request logs and Prometheus metrics.
 *
 *  - X-Request-Id: taken from the proxy when it looks safe, else generated; echoed in
 *    the response and in every log line (and in 500 responses) so a user's report can
 *    be matched to the log.
 *  - Logs: one line per request. LOG_FORMAT=json (production default) for log
 *    collectors, text for development, off for tests. No bodies, tokens or emails.
 *  - /metrics (Prometheus text) when METRICS_TOKEN is set; send it as a Bearer token.
 */
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";

const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const counts = new Map<string, number>(); // `${method}|${route}|${status}` → count
const hist = new Map<string, { buckets: number[]; sum: number; count: number }>(); // `${method}|${route}`

/** The route template ("/api/v1/orgs/:orgId/projects"), never the concrete ids: keeps metric labels and logs small */
export function routeOf(req: Request): string {
  if (!req.route) return "unmatched";
  // Mounted routers only expose the matched URL in baseUrl: put the param names back
  let base = req.baseUrl;
  for (const [k, v] of Object.entries(req.params ?? {})) {
    if (typeof v === "string" && v) base = base.split("/").map((seg) => (seg === v ? `:${k}` : seg)).join("/");
  }
  base = base.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/:id");
  const r = `${base}${req.route.path === "/" ? "" : req.route.path}`;
  return r || "/";
}

export function record(method: string, route: string, status: number, seconds: number) {
  const k = `${method}|${route}|${status}`;
  counts.set(k, (counts.get(k) ?? 0) + 1);
  const hk = `${method}|${route}`;
  const h = hist.get(hk) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
  BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i]++; });
  h.sum += seconds;
  h.count++;
  hist.set(hk, h);
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function requestObserver(config: Pick<Config, "LOG_FORMAT">) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.get("x-request-id");
    const id = incoming && /^[\w.-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    res.locals.requestId = id;
    res.setHeader("x-request-id", id);
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = routeOf(req);
      if (req.path === "/metrics") return;
      record(req.method, route, res.statusCode, seconds);
      if (config.LOG_FORMAT === "off" || req.path === "/health") return;
      const line = { time: new Date().toISOString(), level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", msg: "request", requestId: id, method: req.method, route, status: res.statusCode, ms: Math.round(seconds * 1000), orgId: req.params?.orgId, userId: req.user?.id, ip: req.ip };
      if (config.LOG_FORMAT === "json") console.log(JSON.stringify(line));
      else console.log(`${line.time.slice(11, 19)} ${req.method} ${route} ${res.statusCode} ${line.ms}ms ${id.slice(0, 8)}`);
    });
    next();
  };
}

export function metricsHandler(db: Db, config: Pick<Config, "METRICS_TOKEN">) {
  return async (req: Request, res: Response) => {
    const token = config.METRICS_TOKEN;
    const given = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token || given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
      return res.status(token ? 401 : 404).json({ error: { code: token ? "unauthorized" : "not_found", message: token ? "Bearer METRICS_TOKEN required" : "Metrics are off (set METRICS_TOKEN)" } });
    }
    const out: string[] = [];
    out.push("# HELP qa_http_requests_total HTTP requests by route and status", "# TYPE qa_http_requests_total counter");
    for (const [k, v] of counts) {
      const [method, route, status] = k.split("|");
      out.push(`qa_http_requests_total{method="${method}",route="${esc(route)}",status="${status}"} ${v}`);
    }
    out.push("# HELP qa_http_request_duration_seconds Request duration", "# TYPE qa_http_request_duration_seconds histogram");
    for (const [k, h] of hist) {
      const [method, route] = k.split("|");
      const l = `method="${method}",route="${esc(route)}"`;
      BUCKETS.forEach((b, i) => out.push(`qa_http_request_duration_seconds_bucket{${l},le="${b}"} ${h.buckets[i]}`));
      out.push(`qa_http_request_duration_seconds_bucket{${l},le="+Inf"} ${h.count}`, `qa_http_request_duration_seconds_sum{${l}} ${h.sum.toFixed(6)}`, `qa_http_request_duration_seconds_count{${l}} ${h.count}`);
    }
    try {
      const rows = await db.raw("select metric, label, value from qa_platform_stats()");
      const by = (m: string) => rows.filter((r: any) => r.metric === m);
      out.push("# HELP qa_jobs Hosted jobs by status", "# TYPE qa_jobs gauge", ...by("jobs").map((r: any) => `qa_jobs{status="${r.label}"} ${r.value}`));
      out.push("# HELP qa_notification_deliveries Notification deliveries by status", "# TYPE qa_notification_deliveries gauge", ...by("deliveries").map((r: any) => `qa_notification_deliveries{status="${r.label}"} ${r.value}`));
      for (const [m, help] of [["orgs", "Organizations"], ["users", "Accounts"], ["runs_24h", "Runs in the last 24 hours"]]) {
        out.push(`# HELP qa_${m} ${help}`, `# TYPE qa_${m} gauge`, `qa_${m} ${by(m)[0]?.value ?? 0}`);
      }
      out.push("# HELP qa_db_up Database reachable", "# TYPE qa_db_up gauge", "qa_db_up 1");
    } catch {
      out.push("# HELP qa_db_up Database reachable", "# TYPE qa_db_up gauge", "qa_db_up 0");
    }
    const mem = process.memoryUsage();
    out.push("# TYPE process_resident_memory_bytes gauge", `process_resident_memory_bytes ${mem.rss}`, "# TYPE nodejs_heap_used_bytes gauge", `nodejs_heap_used_bytes ${mem.heapUsed}`, "# TYPE process_uptime_seconds gauge", `process_uptime_seconds ${Math.round(process.uptime())}`);
    res.type("text/plain; version=0.0.4").send(out.join("\n") + "\n");
  };
}
