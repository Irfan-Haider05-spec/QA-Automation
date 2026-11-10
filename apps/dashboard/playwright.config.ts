/**
 * End-to-end tests: a fresh API on an in-memory database plus the built
 * dashboard (vite preview), driven through a real browser.
 *
 *   npm run build -w @qa/dashboard && npm run e2e -w @qa/dashboard
 *
 * Against an already-running deployment (e.g. nginx + real Postgres) instead:
 *   E2E_BASE_URL=http://127.0.0.1:8080 npm run e2e -w @qa/dashboard
 * The API there must run with the same test settings as the webServer below.
 *
 * Browser: Playwright's own Chromium by default; set QA_CHROMIUM_PATH to use
 * another Chromium/Chrome binary (and QA_CHROMIUM_ARGS for extra flags).
 */
import { defineConfig } from "@playwright/test";

const API_PORT = Number(process.env.E2E_API_PORT ?? 4111);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4174);
const EXTERNAL = process.env.E2E_BASE_URL?.replace(/\/+$/, "");
const exe = process.env.QA_CHROMIUM_PATH;
const args = (process.env.QA_CHROMIUM_ARGS ?? "").split(/\s+/).filter(Boolean);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  outputDir: "e2e-results",
  use: {
    baseURL: EXTERNAL ?? `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { ...(exe ? { executablePath: exe } : {}), args },
  },
  webServer: EXTERNAL ? [] : [
    {
      command: "npm run -s start -w @qa/api",
      cwd: "../..",
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "development",
        PORT: String(API_PORT),
        DATABASE_URL: "pglite://memory",
        JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123",
        VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
        CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
        ALLOW_HTTP_VERIFICATION: "true",
        RATE_LIMIT_PER_MINUTE: "100000",
        AUTH_RATE_LIMIT_PER_MINUTE: "100000",
        RUNNER_TOKEN: "e2e-runner-token-0123456789-0123456789",
        SCHEDULER_ENABLED: "false",
        ALLOW_PRIVATE_WEBHOOKS: "true",
        SMTP_URL: "smtp://127.0.0.1:4125",
        NOTIFY_INTERVAL_MS: "500",
        APP_URL: `http://127.0.0.1:${WEB_PORT}`,
      },
    },
    {
      command: `npx vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_API_PROXY: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
