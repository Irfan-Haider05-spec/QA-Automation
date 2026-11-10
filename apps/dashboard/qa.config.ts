/**
 * The QA agent's config for testing the platform dashboard itself (dogfooding).
 * scripts/dogfood.ts starts a throwaway API + dashboard and fills the QA_* values.
 */
import { defineConfig } from "../../src/core/config.js";

const env = (k: string) => process.env[k] || undefined;

export default defineConfig({
  project: "QA platform dashboard",
  // The platform API is this dashboard's backend
  backend: { dir: "../api", routesIndex: "src/routes/index.ts", appFile: "src/app.ts", apiPrefix: "/api/v1", healthPath: "/health", envExample: ".env.example", modulesDir: "src/modules" },
  target: { baseUrl: env("QA_BASE_URL"), requestsPerMinute: 6000, timeoutMs: 10000, slowMs: 1500 },
  login: { path: "/api/v1/auth/login", tokenPath: "tokens.accessToken", bodyTemplate: { email: "{{identifier}}", password: "{{password}}" } },
  accounts: { owner: { identifier: env("QA_OWNER_ID"), password: env("QA_OWNER_PASS"), role: "owner" } },
  web: {
    slowMs: 3000,
    apps: [{ name: "dashboard", baseUrl: env("QA_WEB_URL"), loginPath: "/login", account: "owner", seedRoutes: ["/"], maxPages: 80 }],
  },
  suites: { local: ["web-crawl", "web-a11y", "lighthouse", "zap-baseline"], pr: ["web-crawl", "web-a11y"], staging: ["web-crawl", "web-a11y"], nightly: ["web-crawl", "web-a11y"] },
  knownIssuesFile: "qa-known-issues.json",
});
