/**
 * QA Agent configuration for the MLITech (Rewaldo) backend.
 * COPY TO: Loyalty-Backend-Code/qa.config.ts (repository root), next to .github/workflows/qa.yml
 *
 * Secrets never live in this file. Test-account logins come from the QA platform's
 * vault on staging (platform-accounts in the workflow) or from env vars (the PR job's
 * seeded throwaway accounts, or a local .env.qa when running by hand).
 */

const env = (k: string) => process.env[k] || undefined;

export default {
  project: "MLITech backend",

  backend: {
    dir: ".", // this repository
    routesIndex: "src/app/routes/index.ts",
    appFile: "src/app.ts",
    apiPrefix: "/api/v1",
    healthPath: "/health",
    envExample: ".env.example",
    modulesDir: "src/app/modules",
  },

  target: {
    baseUrl: env("QA_BASE_URL"),
    // apiLimiter allows 120 req/min per IP; stay under it
    requestsPerMinute: Number(env("QA_RPM") ?? 90),
    timeoutMs: 15000,
    slowMs: 2000,
  },

  login: { path: "/api/v1/auth/login", tokenPath: "data.accessToken" },

  // Dedicated QA accounts only. The backend keeps ONE session per user, so a
  // human using these accounts would be logged out by every agent run.
  accounts: {
    merchantA: { identifier: env("QA_MERCHANT_A_ID"), password: env("QA_MERCHANT_A_PASS"), role: "MERCHANT", device: "merchant" },
    merchantB: { identifier: env("QA_MERCHANT_B_ID"), password: env("QA_MERCHANT_B_PASS"), role: "MERCHANT", device: "merchant" },
    customer: { identifier: env("QA_CUSTOMER_ID"), password: env("QA_CUSTOMER_PASS"), role: "USER", device: "user" },
    admin: { identifier: env("QA_ADMIN_ID"), password: env("QA_ADMIN_PASS"), role: "SUPER_ADMIN", device: "admin" },
  },

  // Routes that are meant to work without a token. Anything else without auth() is reported.
  publicRoutes: [
    "GET /", "GET /health", "POST /subscription/webhook",
    "POST /auth/login", "POST /auth/forgot-password", "POST /auth/refresh-token", "POST /auth/resend-otp",
    "POST /auth/verify-email", "POST /auth/verify-otp", "POST /auth/reset-password", "POST /auth/google", "POST /auth/apple",
    "POST /user",                                   // customer sign-up
    "GET /disclaimers/:type", "GET /rules/*",
    "GET /package", "GET /package/active-packages",
    "GET /promo-merchant/popular-merchants",
    "POST /referrals/verify-referral",
    "GET /kuickpay/return", "GET /kuickpay/ipn", "POST /kuickpay/ipn", // payment gateway callbacks (signature-checked)
  ],

  privilegedPrefixes: ["/admin", "/admin-promo", "/admin-tier", "/audit", "/usermanagement", "/sales-rep", "/overview", "/report-analytics"],

  tenantIsolation: {
    owner: "merchantA",
    attacker: "merchantB",
    // Detail routes that are intentionally readable across merchants. Add a route
    // here only after confirming it is meant to be shared.
    sharedResources: [],
    pairs: [],
    maxIdsPerRoute: 3,
  },

  cors: {
    // Dashboard origins that must be allowed on the target, e.g. "https://business.rewaldo.com"
    allowedOrigins: (env("QA_CORS_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    probeOrigin: "https://qa-evil-origin.example",
  },

  // A change in any of these selects every route for the API checks
  globalPaths: [
    "src/app.ts", "src/server.ts", "src/app/routes/**", "src/app/middlewares/**", "src/config/**",
    "src/shared/**", "src/helpers/**", "src/utils/**", "src/errors/**", "src/DB/**", "src/enums/**",
    "package.json", "package-lock.json", "Dockerfile",
  ],

  secrets: { ignorePaths: [] },
  envDrift: { ignoreKeys: ["MONGO_ROOT_USER", "MONGO_ROOT_PASS"] },
  fuzz: { maxExamples: 25, account: "merchantA" },

  // Mobile apps (Maestro). Put flows in qa-mobile/*.yaml (see the .example) and run on a device or
  // emulator: the customer and merchant Flutter apps need Semantics labels on the widgets the flows tap.
  mobile: {
    flowsDir: "qa-mobile",
    appId: env("QA_MOBILE_APP_ID"),
    env: { CUSTOMER_ID: "{{customer.identifier}}", CUSTOMER_PASSWORD: "{{customer.password}}" },
  },

  // Business flows: one file per flow in qa-flows/ (see qa-flows/*.example). Read-only flows run
  // on staging; flows that change data run only where allowMutations is on.
  flows: { dir: "qa-flows" },

  // Lighthouse (nightly) on each dashboard's first pages, logged in. Add more pages per
  // dashboard here, e.g. pages: { admin: ["/", "/merchants"], business: ["/", "/promotions"] }.
  lighthouse: { maxPages: 3, thresholds: { performance: 50, lcpMs: 4000 } },

  // Passive security scan (nightly). Built-in rules by default; the nightly job sets
  // QA_ZAP_DOCKER=true to run the full OWASP ZAP baseline in Docker instead.
  zap: { docker: env("QA_ZAP_DOCKER") === "true", spiderMinutes: 2 },

  // Load smoke (nightly, GET only). apiLimiter allows 120 requests/min per IP, so this stays
  // at 2 requests/s; allow-list the runner's IP on staging and raise QA_LOAD_RPS to really load it.
  load: {
    vus: 4,
    durationSec: 60,
    maxRps: Number(env("QA_LOAD_RPS") ?? 2),
    account: "merchantA",
    thresholds: { p95Ms: 2000, errorRate: 0.01 },
  },

  // Realtime (Socket.IO). In the PR job two backend processes share one Redis, so an event
  // must reach the user's socket on both. The triggers write data (a notification), so they
  // run only on the throwaway PR database; staging gets the token checks only.
  socket: {
    urls: (env("QA_SOCKET_URLS") ?? "").split(",").filter(Boolean), // empty = target.baseUrl
    tokenIn: "auth",
    tokenKey: "token",
    account: "merchantA",
    attacker: "merchantB",
    maxConnectionsPerUser: 3, // MAX_SOCKET_CONNECTIONS_PER_USER in src/helpers/socketHelper.ts
    triggers: [
      { method: "POST", path: "/api/v1/notification/test", event: "newNotification" },
      { method: "POST", path: "/api/v1/notification/sales-rep-active-test", event: "salesActivation::*" },
    ],
  },

  // Dashboards (Phase 2). Crawled read-only: links only, no button clicks, logout/delete skipped.
  // They log in through the real login form with the accounts above, so they run after the API checks.
  web: {
    apps: [
      {
        name: "admin",
        baseUrl: env("QA_ADMIN_WEB_URL"),
        loginPath: env("QA_ADMIN_WEB_LOGIN") ?? "/login",
        account: "admin",
        seedRoutes: ["/"],
        sourceDir: env("QA_ADMIN_WEB_DIR"), // optional checkout of the admin dashboard repo: adds its React Router paths
        excludePaths: [],
        maxPages: 60,
      },
      {
        name: "business",
        baseUrl: env("QA_BUSINESS_WEB_URL"),
        loginPath: env("QA_BUSINESS_WEB_LOGIN") ?? "/login",
        account: "merchantA",
        seedRoutes: ["/"],
        sourceDir: env("QA_BUSINESS_WEB_DIR"),
        excludePaths: [],
        maxPages: 60,
      },
    ],
    slowMs: 5000,
    ignoreConsole: ["Download the React DevTools", "\\[vite\\]"],
    viewport: { width: 1366, height: 900 },
    // Staging data changes, so mask live numbers/charts before trusting visual diffs
    visual: { baselineDir: "qa-visual-baselines", maxDiffRatio: 0.01, mask: ["canvas", "[data-qa-mask]", "time"] },
  },

  suites: {
    // Every PR: static checks + live checks against a throwaway backend booted in CI
    pr: ["route-auth", "env-drift", "secrets", "deps", "health-cors", "api-auth", "api-smoke", "tenant-isolation", "socket-fanout"],
    // After each staging deploy: live checks against the deployed environment
    staging: ["health-cors", "api-auth", "api-smoke", "tenant-isolation", "socket-fanout", "web-crawl", "flows"],
    // Nightly: everything, including fuzzing
    nightly: ["route-auth", "env-drift", "secrets", "deps", "health-cors", "api-auth", "api-smoke", "tenant-isolation", "socket-fanout", "load-smoke", "zap-baseline", "api-fuzz", "web-crawl", "web-a11y", "web-visual", "lighthouse", "flows", "mobile"],
    // Manual runs from a laptop
    local: ["route-auth", "env-drift", "secrets", "deps", "health-cors", "api-auth", "api-smoke", "tenant-isolation", "socket-fanout", "zap-baseline", "web-crawl", "web-a11y"],
  },

  gate: { failOn: "high" },
  // Only true on the throwaway CI database (the PR workflow sets QA_ALLOW_MUTATIONS=true)
  allowMutations: false,
  // Accepted findings (the baseline). Commit it; see the qa-agent README, "Adopting on an existing codebase".
  knownIssuesFile: "qa-known-issues.json",
};
