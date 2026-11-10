/**
 * Health endpoint, response headers and CORS behaviour of the live target.
 */
import type { Finding, QaPlugin } from "../core/types.js";
import { snippet } from "../core/http.js";

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
        evidence: { url: h.url, status: h.status, responseSnippet: snippet(h.text) },
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
    if (acao === cfg.cors.probeOrigin || (acao === "*" && evil.headers.get("access-control-allow-credentials") === "true")) {
      findings.push({
        plugin: this.name, severity: "high", category: "security", target: `CORS ${probePath}`,
        title: "CORS allows an arbitrary origin",
        detail: `A preflight from ${cfg.cors.probeOrigin} got Access-Control-Allow-Origin: ${acao}. Any website could call the API with the user's cookies.`,
        evidence: { url: evil.url, status: evil.status, curl: http.curl({ method: "OPTIONS", path: probePath, headers: { origin: cfg.cors.probeOrigin } }) },
      });
    } else if (evil.status >= 500) {
      findings.push({
        plugin: this.name, severity: "low", category: "quality", target: `CORS ${probePath}`,
        title: `A disallowed origin gets HTTP ${evil.status} instead of a clean rejection`,
        detail: "The CORS origin callback throws an Error, which the global error handler turns into a 5xx. It is blocked, but it shows up as server errors in monitoring.",
        evidence: { url: evil.url, status: evil.status, responseSnippet: snippet(evil.text, 200) },
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
