/**
 * The QA agent's config for testing the platform API itself (dogfooding).
 * scripts/dogfood.ts fills the QA_* values for a throwaway in-memory instance.
 */
import { defineConfig } from "../../src/core/config.js";

const env = (k: string) => process.env[k] || undefined;
const pathParams: Record<string, string> = {};
for (const k of ["orgId", "projectId", "environmentId"]) {
  const v = env(`QA_PARAM_${k.toUpperCase()}`);
  if (v) pathParams[k] = v;
}

export default defineConfig({
  project: "QA platform API",
  backend: { dir: ".", routesIndex: "src/routes/index.ts", appFile: "src/app.ts", apiPrefix: "/api/v1", healthPath: "/health", envExample: ".env.example", modulesDir: "src/modules" },
  target: { baseUrl: env("QA_BASE_URL"), requestsPerMinute: 6000, timeoutMs: 10000, slowMs: 1500, pathParams },
  login: { path: "/api/v1/auth/login", tokenPath: "tokens.accessToken", bodyTemplate: { email: "{{identifier}}", password: "{{password}}" } },
  accounts: {
    ownerA: { identifier: env("QA_OWNER_A_ID"), password: env("QA_OWNER_A_PASS"), role: "owner", device: "web" },
    ownerB: { identifier: env("QA_OWNER_B_ID"), password: env("QA_OWNER_B_PASS"), role: "owner", device: "web" },
    viewerA: { identifier: env("QA_VIEWER_A_ID"), password: env("QA_VIEWER_A_PASS"), role: "viewer", device: "web" },
  },
  publicRoutes: ["GET /public/reports/:token", "GET /health", "POST /auth/signup", "POST /auth/login", "POST /auth/refresh", "POST /auth/logout", "GET /auth/options", "POST /auth/forgot-password", "POST /auth/reset-password", "POST /auth/verify-email", "GET /metrics"],
  privilegedPrefixes: [],
  tenantIsolation: { owner: "ownerA", attacker: "ownerB", sharedResources: [], pairs: [], maxIdsPerRoute: 3 },
  cors: { allowedOrigins: ["http://localhost:5173"], probeOrigin: "https://qa-evil-origin.example" },
  globalPaths: ["src/app.ts", "src/routes/**", "src/middleware/**", "src/lib/**", "src/db/**", "migrations/**"],
  secrets: { ignorePaths: ["test/**", "scripts/**", "docker-compose.yml"] },
  suites: {
    local: ["route-auth", "secrets", "health-cors", "api-auth", "api-smoke", "tenant-isolation", "load-smoke", "zap-baseline"],
    pr: ["route-auth", "secrets", "health-cors", "api-auth", "api-smoke", "tenant-isolation"],
    staging: ["health-cors", "api-auth", "api-smoke", "tenant-isolation"],
    nightly: ["route-auth", "secrets", "health-cors", "api-auth", "api-smoke", "tenant-isolation"],
  },
  // Throwaway in-memory database: write probes with tokens are fine
  allowMutations: true,
  knownIssuesFile: "qa-known-issues.json",
});
