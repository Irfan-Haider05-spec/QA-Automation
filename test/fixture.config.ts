/** Config for the self-test fixture API (test/fixture-api). Not used in production. */
import { defineConfig } from "../src/core/config.js";
export default defineConfig({
  project: "Fixture API (self-test)",
  backend: { dir: "./fixture-api", routesIndex: "src/app/routes/index.ts", appFile: "src/app.ts", apiPrefix: "/api/v1", healthPath: "/health", envExample: ".env.example", modulesDir: "src/app/modules" },
  target: { baseUrl: process.env.QA_BASE_URL ?? "http://127.0.0.1:4010", requestsPerMinute: 1200, timeoutMs: 8000, slowMs: 2000 },
  accounts: {
    merchantA: { identifier: "merchant-a@qa.test", password: "QaPass#1", role: "MERCHANT", device: "merchant" },
    merchantB: { identifier: "merchant-b@qa.test", password: "QaPass#2", role: "MERCHANT", device: "merchant" },
    customer: { identifier: "customer@qa.test", password: "QaPass#3", role: "USER", device: "user" },
    admin: { identifier: "admin@qa.test", password: "QaPass#4", role: "SUPER_ADMIN", device: "admin" },
  },
  publicRoutes: ["GET /health", "POST /auth/login"],
  privilegedPrefixes: ["/admin", "/report-analytics"],
  cors: { allowedOrigins: ["http://localhost:5173"], probeOrigin: "https://qa-evil-origin.example" },
  globalPaths: ["src/app.ts", "src/app/middlewares/**", "src/config/**"],
  fuzz: { maxExamples: 10, account: "merchantA" },
  envDrift: { ignoreKeys: ["FIXTURE_THEME", "FIXTURE_SOCKET_OPEN", "PORT"] },
  suites: {
    pr: ["route-auth", "env-drift", "secrets", "health-cors", "api-auth", "api-smoke", "tenant-isolation"],
    staging: ["health-cors", "api-auth", "api-smoke", "tenant-isolation"],
    nightly: ["route-auth", "env-drift", "secrets", "health-cors", "api-auth", "api-smoke", "tenant-isolation", "api-fuzz"],
    local: ["route-auth", "env-drift", "secrets", "health-cors", "api-auth", "api-smoke", "tenant-isolation", "web-crawl", "web-a11y", "web-visual"],
  },
  knownIssuesFile: "fixture-known-issues.json",
  lighthouse: { pages: { business: ["/index.html", "/heavy.html"] } },
  flows: { dir: "fixture-flows", stepTimeoutMs: 5000 },
  mobile: { flowsDir: "fixture-mobile", maestroPath: process.env.QA_MAESTRO ?? "maestro", appId: "com.mlitech.qa", env: { EMAIL: "{{merchantA.identifier}}", PASSWORD: "{{merchantA.password}}" } },
  zap: { engine: (process.env.QA_ZAP_ENGINE as "auto" | "builtin" | undefined) ?? "auto", ignore: ["10096"] },
  load: {
    routes: process.env.QA_LOAD_ROUTES?.split(",") ?? ["GET /system/crash", "GET /admin/stats", "GET /system/slow", "GET /system/limited", "GET /promotion/:id"],
    vus: 4, durationSec: 4, rampSec: 0, maxRps: 25,
    thresholds: { p95Ms: 1500 },
  },
  socket: {
    urls: (process.env.QA_SOCKET_URLS ?? "").split(",").filter(Boolean),
    account: "merchantA",
    triggers: [
      { method: "POST", path: "/api/v1/notification/ping", event: "newNotification" },
      { method: "POST", path: "/api/v1/notification/activation-test", event: "salesActivation::*" },
    ],
    maxConnectionsPerUser: 2,
    connectTimeoutMs: 3000,
    settleMs: 800,
    eventTimeoutMs: 2000,
  },
  web: {
    apps: [{ name: "business", baseUrl: (process.env.QA_BASE_URL ?? "http://127.0.0.1:4010") + "/web", loginPath: "/login.html", account: "merchantA", seedRoutes: ["/index.html"], maxPages: 20 }],
    slowMs: 5000,
    visual: { baselineDir: process.env.QA_VISUAL_DIR ?? "fixture-visual-baselines", maxDiffRatio: 0.01, mask: [] },
  },
});
