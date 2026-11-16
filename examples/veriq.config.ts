/** Copy and adapt to a real project. Never put secrets or live write targets here. */
export default {
  project: "VeriQ example",
  backend: false,
  discovery: { format: "openapi", file: "./openapi.json" },
  target: { baseUrl: process.env.QA_BASE_URL, requestsPerMinute: 60, pathParams: {} },
  login: { strategy: "bearer", path: "/auth/login", tokenPath: "accessToken", bodyTemplate: { email: "{{identifier}}", password: "{{password}}" } },
  accounts: {
    user: { identifier: process.env.QA_USER_EMAIL, password: process.env.QA_USER_PASSWORD, role: "USER", device: "" },
  },
  allowMutations: false,
  disposable: false,
  suites: {
    local: ["api-smoke", "data-exposure", "validation-coverage", "uptime"],
    pr: ["validation-coverage", "api-contract", "test-results", "sast", "bundle-budget"],
    staging: ["api-smoke", "authz-matrix", "data-exposure", "uptime"],
    nightly: ["api-smoke", "data-exposure", "uptime", "web-client-security", "cross-browser", "privacy-consent"],
  },
  pluginSettings: {
    uptime: { requests: [{ path: "/health" }], maxMs: 2000 },
    // Enable after verifying the paths, accounts and expected policies:
    // "authz-matrix": { cases: [{ path: "/admin", account: "user", expectedStatuses: [403] }] },
    // "api-contract": { baseline: "./baseline.openapi.json", current: "./openapi.json" },
    // "test-results": { junit: "./reports/junit.xml", coverage: "./coverage/coverage-summary.json", minLinePercent: 80 },
    // sast: { report: "./qa-out/semgrep.sarif", run: true, rules: "./semgrep-rules.yml", target: ".." },
    // "container-iac": { report: "./qa-out/trivy.sarif", run: true, target: ".." },
    // "bundle-budget": { directory: "./dist", maxBytes: 600000, maxGzipBytes: 180000 },
  },
};
