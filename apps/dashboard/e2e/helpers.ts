import http from "node:http";
import { expect, type Page, type APIRequestContext } from "@playwright/test";

export const PASSWORD = "e2e-password-123";
export const API = process.env.E2E_BASE_URL
  ? `${process.env.E2E_BASE_URL.replace(/\/+$/, "")}/api/v1`
  : `http://127.0.0.1:${process.env.E2E_API_PORT ?? 4111}/api/v1`;

/** Console errors and failed requests the app shouldn't produce */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // Expected: the browser logs failed HTTP responses the tests provoke on purpose
    if (/Failed to load resource: the server responded with a status of (401|403|404|409|422|400)/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  return errors;
}

export async function signupUi(page: Page, name: string, email: string, orgName?: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  if (orgName) await page.getByLabel("Organization name").fill(orgName);
  await page.getByRole("button", { name: "Create account" }).click();
}

export async function loginUi(page: Page, email: string, password = PASSWORD) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

export const toast = (page: Page, text: string | RegExp) => expect(page.locator(".toasts .toast").filter({ hasText: text }).first()).toBeVisible();
export const dialog = (page: Page) => page.getByRole("dialog");

export function orgIdFromUrl(page: Page) {
  const m = new URL(page.url()).pathname.match(/^\/o\/([0-9a-f-]{36})/);
  if (!m) throw new Error(`No org in ${page.url()}`);
  return m[1];
}

/** A tiny site the tests can "own", for domain verification */
export function startTargetSite(port: number) {
  let token = "";
  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/qa-verification.txt" && token) { res.writeHead(200, { "content-type": "text/plain" }); res.end(token); return; }
    res.writeHead(404); res.end("not found");
  });
  return new Promise<{ setToken: (t: string) => void; close: () => Promise<void> }>((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ setToken: (t) => { token = t; }, close: () => new Promise((r) => server.close(() => r())) })),
  );
}

export function sampleRun(environmentId: string | undefined, findings: Array<{ fp: string; severity?: string; plugin?: string }>, full = true) {
  const plugins = new Map<string, any[]>();
  for (const f of findings) {
    const p = f.plugin ?? "api-auth";
    if (!plugins.has(p)) plugins.set(p, []);
    plugins.get(p)!.push({
      plugin: p, severity: f.severity ?? "high", title: `Route answers without a token ${f.fp}`, detail: "GET returned 200 with no Authorization header.",
      target: `GET /api/v1/x/${f.fp}`, category: "security", fingerprint: f.fp,
      evidence: { status: 200, curl: `curl -i 'http://127.0.0.1:4199/api/v1/x/${f.fp}'`, responseSnippet: '{"ok":true}' },
    });
  }
  for (const p of ["api-auth", "route-auth", "api-smoke"]) if (!plugins.has(p)) plugins.set(p, []);
  const results = [...plugins.entries()].map(([plugin, fs]) => ({ plugin, status: fs.length ? "failed" : "passed", durationMs: 140, findings: fs }));
  const blocking = findings.filter((f) => ["critical", "high"].includes(f.severity ?? "high")).length;
  return {
    project: "Loyalty API", suite: "staging", target: "http://127.0.0.1:4199/api", startedAt: new Date().toISOString(), durationMs: 6400,
    routesTotal: 20, routesSelected: full ? 20 : 5, selectionReason: full ? "all routes" : "changed files", requests: 87,
    results, gate: { failOn: "high", passed: blocking === 0, blocking }, git: { sha: "abc1234", ref: "main" }, source: "ci",
    ...(environmentId ? { environmentId } : {}),
  };
}

export async function uploadRun(request: APIRequestContext, key: string, body: unknown) {
  return request.post(`${API}/runner/runs`, { headers: { authorization: `Bearer ${key}` }, data: body });
}

export const RUNNER_TOKEN = "e2e-runner-token-0123456789-0123456789";
/** Plays a hosted runner against the real /hosted endpoints */
export function fakeRunner(request: APIRequestContext, id = "e2e-runner") {
  const headers = { authorization: `Bearer ${RUNNER_TOKEN}`, "x-runner-id": id };
  return {
    /** Claim the next job. Waits up to 8 s for one (the "Start run" request may still be in flight); expectNone: ask once. */
    claim: async ({ expectNone = false } = {}) => {
      const until = Date.now() + (expectNone ? 0 : 8000);
      for (;;) {
        const r = await request.post(`${API}/hosted/jobs/claim`, { headers });
        if (r.status() !== 204) return r.json();
        if (Date.now() >= until) return null;
        await new Promise((res) => setTimeout(res, 200));
      }
    },
    heartbeat: async (jobId: string) => (await request.post(`${API}/hosted/jobs/${jobId}/heartbeat`, { headers })).json(),
    complete: async (jobId: string, body: unknown) => (await request.post(`${API}/hosted/jobs/${jobId}/complete`, { headers, data: body })).json(),
  };
}
