import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { Resolver } from "node:dns/promises";
import { z } from "zod";
import { SkipError, type Finding } from "../../core/types.js";
import { checkedPlugin, issue, localPath, readJson, request, requestSchema } from "./support.js";
import { executeK6 } from "../../core/k6-execution.js";
import { errorSourceSchema, readErrorSource, type ErrorEvent } from "./error-source.js";
import { appendHistory, readHistory, redactTarget, resolveStorePath, summarizeTarget, uptimeRecordSchema, type UptimeRecord } from "../../core/observation-history.js";

const uptimeStoreSchema = z.object({
  path: z.string().min(1).max(512),
  intervalSeconds: z.number().int().min(30).max(86400),
  retentionDays: z.number().int().min(1).max(400).default(90),
  maxEntries: z.number().int().min(100).max(200000).default(50000),
  windowHours: z.number().int().min(1).max(9600).default(168),
  targetPercent: z.number().min(0).max(100).optional(),
  minCoveragePercent: z.number().min(1).max(100).default(80),
}).strict().refine(s => s.windowHours <= s.retentionDays * 24, "windowHours cannot exceed the retention period");

export const uptime = checkedPlugin("uptime", "api", "Measure configured health requests; persist bounded observation history and report availability only over observed time",
  z.object({ requests: z.array(requestSchema).min(1).max(10), maxMs: z.number().positive().default(2000), history: z.string().optional(), store: uptimeStoreSchema.optional() }).strict(),
  async (ctx, c) => {
    if (c.requests.some((r) => r.method !== "GET")) throw new Error("Uptime checks are GET-only");
    // Validate the store (path and existing content) before sending any request.
    const storeFile = c.store ? resolveStorePath(ctx.configDir, c.store.path) : undefined;
    const retention = c.store ? { retentionDays: c.store.retentionDays, maxEntries: c.store.maxEntries, maxBytes: c.store.maxEntries * 512 } : undefined;
    if (storeFile) readHistory(storeFile, uptimeRecordSchema, retention!.maxBytes, Date.now(), r => r.at);
    const findings: Finding[] = []; let healthy = 0;
    const observed: UptimeRecord[] = []; let checkErrors = 0;
    for (const spec of c.requests) {
      const target = redactTarget("GET", spec.path);
      const at = () => new Date().toISOString();
      const headers = spec.account ? await ctx.auth!.header(spec.account) : undefined;
      if (spec.account && !headers) {
        // The check could not run: this says nothing about the target's availability.
        checkErrors++; observed.push({ v: 1, at: at(), target, outcome: "check-error", reason: "auth" });
        continue;
      }
      const res = await ctx.http!.send({ method: "GET", path: spec.path, retry: false, headers });
      const ms = Math.max(0, Math.round(res.ms));
      if (res.networkError) {
        const reason = /timeout|abort/i.test(res.networkError) ? "timeout" : "network";
        observed.push({ v: 1, at: at(), target, outcome: "down", reason, ms });
        findings.push(issue("uptime", "Health request unavailable", spec.path, reason === "timeout" ? "Request timed out" : "Network error", "high", "env"));
      } else if (res.status < 200 || res.status >= 300) {
        observed.push({ v: 1, at: at(), target, outcome: "down", reason: "http", status: res.status, ms });
        findings.push(issue("uptime", "Health request unavailable", spec.path, `HTTP ${res.status}`, "high", "env"));
      } else {
        healthy++;
        const slow = res.ms > c.maxMs;
        observed.push({ v: 1, at: at(), target, outcome: slow ? "slow" : "up", status: res.status, ms });
        if (slow) findings.push(issue("uptime", "Health request is slow", spec.path, `${res.ms} ms, limit ${c.maxMs} ms.`, "medium", "performance"));
      }
    }
    const stats: Record<string, number | string> = { samples: c.requests.length, healthy, checkErrors };
    if (c.history) {
      const observations = z.array(z.object({ at: z.string().datetime(), available: z.boolean() }).strict()).min(1).max(100000).parse(readJson(ctx, c.history));
      const timestamps = observations.map((v) => Date.parse(v.at));
      if (new Set(timestamps).size !== timestamps.length) throw new Error("Duplicate uptime observation timestamps");
      stats.observedAvailabilityPercent = observations.filter((v) => v.available).length / observations.length * 100;
      stats.historySamples = observations.length;
      stats.historyFrom = new Date(Math.min(...timestamps)).toISOString(); stats.historyTo = new Date(Math.max(...timestamps)).toISOString();
      stats.coverage = "Observation ratio only; gaps are not assumed to be uptime";
    }
    if (c.store && storeFile) {
      const now = Date.now();
      const merged = await appendHistory(storeFile, uptimeRecordSchema, observed, retention!, now, r => r.at);
      const windowSeconds = c.store.windowHours * 3600;
      const summaries = [...new Set(c.requests.map(r => redactTarget("GET", r.path)))]
        .map(target => summarizeTarget(merged, target, now, windowSeconds, c.store!.intervalSeconds));
      fs.mkdirSync(ctx.outDir, { recursive: true });
      fs.writeFileSync(path.join(ctx.outDir, "uptime-history.json"), JSON.stringify({
        generatedAt: new Date(now).toISOString(), windowFrom: new Date(now - windowSeconds * 1000).toISOString(), windowTo: new Date(now).toISOString(),
        intervalSeconds: c.store.intervalSeconds, retentionDays: c.store.retentionDays, storedRecords: merged.length, targets: summaries,
        note: "Availability is computed over observed time only; unobserved time and failed checks count as neither uptime nor downtime.",
      }, null, 2), { mode: 0o600 });
      stats.storedRecords = merged.length;
      stats.windowHours = c.store.windowHours;
      stats.minCoveragePercent = Math.min(...summaries.map(s => s.coveragePercent));
      for (const s of summaries) {
        if (c.store.targetPercent === undefined) continue;
        if (s.coveragePercent < c.store.minCoveragePercent || s.observedAvailabilityPercent === null) {
          findings.push(issue("uptime", "Availability target not evaluable: history coverage too low", s.target,
            `Observed ${s.coveragePercent}% of the last ${c.store.windowHours} h (minimum ${c.store.minCoveragePercent}%). Unobserved time is not counted as uptime.`, "medium", "env"));
        } else if (s.observedAvailabilityPercent < c.store.targetPercent) {
          findings.push(issue("uptime", "Observed availability below target", s.target,
            `${s.observedAvailabilityPercent}% over ${s.coveragePercent}% observed coverage of the last ${c.store.windowHours} h (target ${c.store.targetPercent}%); ${s.outageEpisodes} outage episode(s), longest ${s.longestOutageSeconds} s.`, "high", "env"));
        }
      }
    }
    if (checkErrors) throw new Error(`Uptime check could not authenticate for ${checkErrors} target(s); recorded as failed checks, not outages`);
    return { findings, stats };
  }, ["baseUrl"]);

const domainName = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i);
export const tlsDnsMail = checkedPlugin("tls-dns-mail", "security", "Validate TLS trust/expiry and configured SPF, DKIM and DMARC records",
  z.object({ host: domainName, port: z.number().int().min(1).max(65535).default(443), warnDays: z.number().int().min(1).max(365).default(30),
    mailDomain: domainName.optional(), dkimSelectors: z.array(z.string().regex(/^[a-z0-9_-]{1,63}$/i)).max(10).default([]),
    domainExpiresAt: z.string().datetime().optional() }).strict(), async (_ctx, c) => {
    const findings: Finding[] = [];
    const certificate = await new Promise<{ validTo?: string; protocol?: string; error?: string }>((resolve) => {
      const socket = tls.connect({ host: c.host, port: c.port, servername: c.host, rejectUnauthorized: true, minVersion: "TLSv1.2" });
      socket.setTimeout(10000, () => socket.destroy(new Error("TLS connection timed out")));
      socket.once("secureConnect", () => { const cert = socket.getPeerCertificate(); const protocol = socket.getProtocol() ?? undefined; socket.end(); resolve({ validTo: cert.valid_to, protocol }); });
      socket.once("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
    });
    if (certificate.error) findings.push(issue("tls-dns-mail", "TLS connection or certificate validation failed", c.host, certificate.error, "high", "security", "CWE-295"));
    else {
      const expiry = Date.parse(certificate.validTo ?? "");
      if (!Number.isFinite(expiry)) throw new Error("TLS peer did not provide a certificate expiry");
      if (expiry - Date.now() < c.warnDays * 86400000) findings.push(issue("tls-dns-mail", "TLS certificate nearing expiry", c.host, `Expires ${new Date(expiry).toISOString()}.`, "medium", "config"));
    }
    if (c.domainExpiresAt && Date.parse(c.domainExpiresAt) - Date.now() < c.warnDays * 86400000) findings.push(issue("tls-dns-mail", "Domain registration nearing expiry", c.host, `Configured registration expiry: ${c.domainExpiresAt}; verify with the registrar.`, "medium", "config"));
    if (c.mailDomain) {
      const resolver = new Resolver({ timeout: 5000, tries: 2 });
      for (const [label, host, prefix] of [["SPF", c.mailDomain, "v=spf1"], ["DMARC", `_dmarc.${c.mailDomain}`, "v=DMARC1"], ...c.dkimSelectors.map((s) => ["DKIM", `${s}._domainkey.${c.mailDomain}`, "v=DKIM1"])]) {
        let records: string[];
        try { records = (await resolver.resolveTxt(host)).map((parts) => parts.join("")); }
        catch (e: any) { if (!["ENODATA", "ENOTFOUND"].includes(e.code)) throw new Error(`DNS lookup failed for ${host}: ${e.code}`); records = []; }
        const matching = records.filter((r) => r.toLowerCase().startsWith(prefix.toLowerCase()) || (label === "DKIM" && /(?:^|;)\s*p=/.test(r)));
        if (matching.length !== 1) findings.push(issue("tls-dns-mail", `${label} record missing or ambiguous`, host, `Found ${matching.length} matching TXT records.`, "medium", "config"));
        else if ((label === "SPF" && /\+all\b/.test(matching[0])) || (label === "DMARC" && /(?:^|;)\s*p=none(?:;|$)/i.test(matching[0]))) findings.push(issue("tls-dns-mail", `${label} uses a permissive policy`, host, "Review the domain's intended mail enforcement policy.", "low", "config"));
      }
    }
    return { findings, stats: { protocol: certificate.protocol ?? "unavailable", legacyTlsProbed: "no", domainExpirySource: c.domainExpiresAt ? "configured" : "not checked" } };
  });

const errorWindow = z.object({ release: z.string(), durationSeconds: z.number().positive(), complete: z.literal(true),
  errors: z.array(z.object({ fingerprint: z.string().min(1), count: z.number().int().nonnegative() }).strict()).max(10000) }).strict();
type ErrorWindow = z.output<typeof errorWindow>;
function compareWindows(base: ErrorWindow, current: ErrorWindow, c: { release: string; minNewEvents: number; spikeFactor: number }): Finding[] {
  const counts = (events: ErrorWindow["errors"]) => { const m = new Map<string, number>(); for (const e of events) m.set(e.fingerprint, (m.get(e.fingerprint) ?? 0) + e.count); return m; };
  const previous = counts(base.errors); const findings: Finding[] = [];
  for (const [id, count] of counts(current.errors)) {
    const old = previous.get(id) ?? 0;
    if (count >= c.minNewEvents && (old === 0 || count / current.durationSeconds > old / base.durationSeconds * c.spikeFactor)) findings.push(issue("post-deploy-errors", old ? "Post-deploy error rate increased" : "New post-deploy error type", id,
      `Release ${c.release}: ${count} events / ${current.durationSeconds}s; baseline ${old} / ${base.durationSeconds}s.`, "high", "regression"));
  }
  return findings;
}
function windowFrom(events: ErrorEvent[], release: string, durationSeconds: number): ErrorWindow {
  const m = new Map<string, number>();
  for (const e of events) m.set(e.fingerprint, (m.get(e.fingerprint) ?? 0) + 1);
  if (m.size > 10000) throw new Error("More than 10000 distinct error fingerprints in one window");
  return { release, durationSeconds, complete: true, errors: [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([fingerprint, count]) => ({ fingerprint, count })) };
}
const sourceWindows = z.object({
  deployedAt: z.string().datetime(),
  baselineSeconds: z.number().int().min(60).max(30 * 86400),
  currentSeconds: z.number().int().min(60).max(30 * 86400),
  settleSeconds: z.number().int().min(0).max(86400).default(120),
}).strict();

export const postDeployErrors = checkedPlugin("post-deploy-errors", "api", "Compare complete normalized error windows for a deployed release, from window files or a provider-neutral event source",
  z.object({ baseline: z.string().optional(), current: z.string().optional(), release: z.string().min(1).max(200), minNewEvents: z.number().int().min(1).default(1), spikeFactor: z.number().min(1).default(2),
    source: errorSourceSchema.optional(), windows: sourceWindows.optional() }).strict()
    .refine(c => (c.baseline && c.current && !c.source && !c.windows) || (!c.baseline && !c.current && c.source && c.windows), "Configure baseline+current window files, or source+windows"),
  async (ctx, c) => {
    if (!c.source) {
      const base = errorWindow.parse(readJson(ctx, c.baseline!)), current = errorWindow.parse(readJson(ctx, c.current!));
      if (current.release !== c.release) throw new Error("Error window does not belong to the requested release");
      return compareWindows(base, current, c);
    }
    const w = c.windows!, deployed = Date.parse(w.deployedAt), now = Date.now();
    const range = { from: deployed - w.baselineSeconds * 1000, to: deployed + w.currentSeconds * 1000 };
    // An unfinished window (or one still being ingested) cannot show an absence of errors.
    if (range.to + w.settleSeconds * 1000 > now) throw new Error("The current window has not finished and settled yet; no result is accepted");
    const result = await readErrorSource(ctx.configDir, c.source, range);
    const baselineEvents = result.events.filter(e => e.at < deployed);
    // With a release field, current-window events from other releases are not attributed to this one.
    const releaseKnown = !!c.source.fields.release;
    const currentAll = result.events.filter(e => e.at >= deployed);
    const currentEvents = releaseKnown ? currentAll.filter(e => e.release === c.release) : currentAll;
    const baseline = windowFrom(baselineEvents, "baseline", w.baselineSeconds);
    const current = windowFrom(currentEvents, c.release, w.currentSeconds);
    fs.mkdirSync(ctx.outDir, { recursive: true });
    for (const [name, value] of [["post-deploy-errors-baseline.json", baseline], ["post-deploy-errors-current.json", current]] as const) {
      fs.writeFileSync(path.join(ctx.outDir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
    }
    return { findings: compareWindows(baseline, current, c), stats: {
      sourceKind: c.source.kind, sourcePages: result.pages, eventsRead: result.read, baselineEvents: baselineEvents.length, currentEvents: currentEvents.length,
      otherReleaseEvents: currentAll.length - currentEvents.length, baselineFingerprints: baseline.errors.length, currentFingerprints: current.errors.length,
    } };
  });

export const loadStress = checkedPlugin("load-stress", "perf", "Import k6 handleSummary metrics and enforce explicit load thresholds",
  z.object({ report: z.string().min(1).optional(), execution: z.object({ path: localPath, account: z.string().min(1).optional(),
    executable: z.string().min(1).max(4096).default("k6"), vus: z.number().int().min(1).max(20).default(1),
    iterations: z.number().int().min(1).max(10000), requestsPerSecond: z.number().int().min(1).max(100),
    maxDurationSeconds: z.number().int().min(1).max(120).default(30), requestTimeoutMs: z.number().int().min(100).max(10000).default(5000),
  }).strict().optional(), maxP95Ms: z.number().positive(), maxErrorRate: z.number().min(0).max(1), minRequests: z.number().int().min(1).default(100) }).strict()
    .refine(c => !!c.report !== !!c.execution, "Configure either report import or execution, not both"),
  async (ctx, c) => {
    if (c.execution && c.minRequests > c.execution.iterations) throw new Error("minRequests exceeds the configured iteration count");
    if (c.execution && !ctx.config.target.baseUrl) throw new SkipError("no target URL (set QA_BASE_URL or --base-url)");
    const executed = c.execution ? await executeK6(ctx, c.execution, c) : undefined;
    const metric = z.object({ values: z.record(z.string(), z.number()), thresholds: z.record(z.string(), z.object({ ok: z.boolean() })).optional() });
    const doc = z.object({ metrics: z.record(z.string(), metric) }).parse(readJson(ctx, executed?.report ?? c.report!));
    const n = doc.metrics.http_reqs?.values.count, p95 = doc.metrics.http_req_duration?.values["p(95)"], rate = doc.metrics.http_req_failed?.values.rate;
    if (n === undefined || !Number.isInteger(n) || n < c.minRequests || p95 === undefined || p95 < 0 || rate === undefined || rate < 0 || rate > 1) throw new Error("k6 report lacks valid metrics or sufficient requests");
    if (c.execution && (n !== c.execution.iterations || doc.metrics.iterations?.values.count !== c.execution.iterations)) throw new Error("k6 did not complete all configured iterations; partial results cannot pass");
    const findings: Finding[] = [];
    if (p95 > c.maxP95Ms || rate > c.maxErrorRate) findings.push(issue("load-stress", "Stress-test performance budget exceeded", "k6", `p95 ${p95} ms; error rate ${rate}; ${n} requests.`, "high", "performance"));
    for (const [name, value] of Object.entries(doc.metrics)) for (const [threshold, result] of Object.entries(value.thresholds ?? {})) if (!result.ok) findings.push(issue("load-stress", "k6 threshold failed", name, threshold, "high", "performance"));
    const failedThreshold = Object.values(doc.metrics).some(v => Object.values(v.thresholds ?? {}).some(t => !t.ok));
    if (executed && ((executed.exitCode === 99) !== failedThreshold)) throw new Error("k6 exit status contradicts threshold results; no successful result accepted");
    return { findings, stats: { requests: n, p95Ms: p95, errorRate: rate } };
  });

// These read their own inputs and never call the target API.
tlsDnsMail.usesTarget = () => false;
postDeployErrors.usesTarget = () => false;
loadStress.usesTarget = (ctx) => !!(ctx.config.pluginSettings?.["load-stress"] as { execution?: unknown } | undefined)?.execution;
