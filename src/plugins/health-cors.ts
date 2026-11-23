/**
 * Health endpoint, response headers and CORS behaviour of the live target.
 */
import type { Finding, QaPlugin } from "../core/types.js";
import { responseEvidence } from "../core/http.js";

const EVIL = "qa-evil-origin.example";

export interface CorsProbe { origin: string; flaw: string; downgrade: boolean }
/**
 * Attacker-controllable origins that loose origin checks accept: a check with startsWith,
 * endsWith or includes instead of an exact comparison, or an unanchored regular expression.
 * Each probe is an origin an attacker could really own: no port in the middle of a host
 * name, and no look-alike of an IP address or a single-label host such as localhost.
 */
export function bypassOrigins(allowed: string[]): CorsProbe[] {
  const out = new Map<string, CorsProbe>();
  const add = (origin: string, flaw: string, downgrade = false) => out.set(origin, { origin, flaw, downgrade });
  for (const value of allowed.slice(0, 10)) {
    let u: URL;
    try { u = new URL(value); } catch { continue; }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const port = u.port ? `:${u.port}` : "";
    // "https://app.example.com.evil.example" passes startsWith("https://app.example.com").
    if (!port) add(`${u.protocol}//${u.hostname}.${EVIL}`, `starts with the allowed origin ${u.origin}`);
    // "https://evilapp.example.com" passes endsWith("app.example.com") and includes("app").
    const registrable = u.hostname.includes(".") && !/^[\d.]+$/.test(u.hostname) && !u.hostname.startsWith("[");
    if (registrable) add(`${u.protocol}//qa-evil${u.hostname}${port}`, `ends with the host of ${u.origin} but is a different site`);
    if (u.protocol === "https:") add(`http://${u.host}`, `is the unencrypted http:// version of ${u.origin}`, true);
  }
  // A probe the project itself allows on purpose is not a bypass.
  for (const value of allowed) out.delete(value.replace(/\/+$/, ""));
  return [...out.values()];
}

export const healthCorsPlugin: QaPlugin = {
  name: "health-cors",
  layer: "api",
  description: "Health check, security headers, CORS allow/deny",
  needs: ["baseUrl"],
  async run(ctx) {
    const http = ctx.http!;
    const cfg = ctx.config;
    const findings: Finding[] = [];
    const h = await http.send({ method: "GET", path: cfg.backend.healthPath });
    if (h.networkError || h.status !== 200) {
      findings.push({
        plugin: this.name, severity: "critical", category: h.networkError ? "env" : "regression", target: `GET ${cfg.backend.healthPath}`,
        title: h.networkError ? `Target unreachable: ${h.networkError}` : `Health check returned ${h.status}`,
        evidence: { url: h.url, status: h.status, responseSnippet: responseEvidence(h) },
      });
      return findings;
    }
    if (h.ms > cfg.target.slowMs) {
      findings.push({ plugin: this.name, severity: "medium", category: "performance", target: `GET ${cfg.backend.healthPath}`, title: `Health check is slow (${h.ms} ms)`, evidence: { url: h.url } });
    }

    const headerChecks: Array<[string, (v: string | null) => boolean, string]> = [
      ["x-powered-by", (v) => v === null, "X-Powered-By header reveals the framework"],
      ["x-content-type-options", (v) => v === "nosniff", "X-Content-Type-Options: nosniff is missing"],
    ];
    if (h.url.startsWith("https://")) headerChecks.push(["strict-transport-security", (v) => !!v, "Strict-Transport-Security header is missing on HTTPS"]);
    for (const [name, ok, title] of headerChecks) {
      if (!ok(h.headers.get(name))) findings.push({ plugin: this.name, severity: "low", category: "security", target: `header ${name}`, title, evidence: { url: h.url } });
    }

    // CORS: an unknown origin must not be reflected; configured origins must be allowed.
    const probePath = cfg.login.path;
    const pre = (origin: string) => http.send({ method: "OPTIONS", path: probePath, headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" } });
    const evil = await pre(cfg.cors.probeOrigin);
    const acao = evil.headers.get("access-control-allow-origin");
    const arbitrary = acao === cfg.cors.probeOrigin || (acao === "*" && evil.headers.get("access-control-allow-credentials") === "true");
    if (arbitrary) {
      findings.push({
        plugin: this.name, severity: "high", category: "security", target: `CORS ${probePath}`,
        title: "CORS allows an arbitrary origin",
        detail: `A preflight from ${cfg.cors.probeOrigin} got Access-Control-Allow-Origin: ${acao}. Any website could call the API with the user's cookies.`,
        evidence: { url: evil.url, status: evil.status, curl: http.curl({ method: "OPTIONS", path: probePath, headers: { origin: cfg.cors.probeOrigin } }) },
      });
    } else {
      // An exact allow-list rejects these; a loose comparison or an unanchored pattern lets
      // an attacker's site through. null is what sandboxed frames and file: pages send.
      const bypasses = [...bypassOrigins(cfg.cors.allowedOrigins), { origin: "null", flaw: "is the opaque null origin of sandboxed frames and local files", downgrade: false }];
      for (const probe of bypasses) {
        const res = await pre(probe.origin);
        if (res.headers.get("access-control-allow-origin") !== probe.origin) continue;
        const credentials = res.headers.get("access-control-allow-credentials") === "true";
        const downgrade = probe.downgrade;
        findings.push({
          plugin: this.name, severity: downgrade ? "low" : credentials ? "high" : "medium", category: "security", target: `CORS ${probe.origin}`,
          title: downgrade ? "CORS trusts the plain-HTTP version of an allowed origin" : "CORS origin check can be bypassed",
          detail: `A preflight from ${probe.origin}, which ${probe.flaw}, got Access-Control-Allow-Origin: ${probe.origin}${credentials ? " with Access-Control-Allow-Credentials: true" : ""}. `
            + (downgrade ? "A network attacker who can inject into plain-HTTP traffic could make requests as that origin."
              : `Compare the Origin header with an exact allow-list instead of startsWith/endsWith/includes or an unanchored pattern.${credentials ? " Any site matching this pattern can call the API with the user's cookies." : ""}`),
          evidence: { url: res.url, status: res.status, curl: http.curl({ method: "OPTIONS", path: probePath, headers: { origin: probe.origin } }) },
        });
      }
    }
    if (!arbitrary && evil.status >= 500) {
      findings.push({
        plugin: this.name, severity: "low", category: "quality", target: `CORS ${probePath}`,
        title: `A disallowed origin gets HTTP ${evil.status} instead of a clean rejection`,
        detail: "The CORS origin callback throws an Error, which the global error handler turns into a 5xx. It is blocked, but it shows up as server errors in monitoring.",
        evidence: { url: evil.url, status: evil.status, responseSnippet: responseEvidence(evil, 200) },
      });
    }
    for (const origin of cfg.cors.allowedOrigins) {
      const ok = await pre(origin);
      if (ok.headers.get("access-control-allow-origin") !== origin) {
        findings.push({
          plugin: this.name, severity: "high", category: "config", target: `CORS ${origin}`,
          title: `Dashboard origin ${origin} is rejected by CORS`,
          detail: "Browsers on this origin cannot call the API. Check CLIENT_URL / ADMIN_URL on the target environment.",
          evidence: { url: ok.url, status: ok.status },
        });
      }
    }
    return { findings, stats: { healthMs: h.ms } };
  },
};
