/**
 * Hosted runs in the dashboard: readiness reasons, Run now, the live queue
 * (waiting → running → result appears by itself), cancelling, and schedules.
 * The runner is played through the real /hosted endpoints.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { API, PASSWORD, dialog, fakeRunner, sampleRun, startTargetSite, toast, watchErrors } from "./helpers";

test.describe.configure({ mode: "serial" });

let owner: { token: string; orgId: string; email: string };
let projectId = "";
let envId = "";
let key = "";
let page: Page;
let errors: string[];
let site: Awaited<ReturnType<typeof startTargetSite>>;
const SITE_PORT = 4197;

const profile = {
  version: 1, apiPrefix: "/api/v1", healthPath: "/health", login: { path: "/api/v1/auth/login", tokenPath: "data.accessToken" },
  accounts: { merchantA: { role: "MERCHANT" } }, publicRoutes: ["GET /health"], privilegedPrefixes: [],
  tenantIsolation: { owner: "merchantA", attacker: "merchantB", sharedResources: [], pairs: [], maxIdsPerRoute: 3 },
  cors: { allowedOrigins: [], probeOrigin: "https://evil.example" }, pathParams: {}, gateFailOn: "high", web: { slowMs: 3000, ignoreConsole: [], apps: [] },
  routes: [{ method: "GET", path: "/api/v1/orders", apiPath: "/orders", module: "orders", authRequired: true, roles: [], multipart: false, middlewares: ["auth"] }],
};

test.beforeAll(async ({ browser, request }) => {
  site = await startTargetSite(SITE_PORT);
  const email = `hosted-${Date.now()}@acme.test`;
  const r = await (await request.post(`${API}/auth/signup`, { data: { name: "Hana", email, password: PASSWORD, orgName: "Hosted Org" } })).json();
  owner = { token: r.tokens.accessToken, orgId: r.org.id, email };
  const auth = { authorization: `Bearer ${owner.token}` };
  projectId = (await (await request.post(`${API}/orgs/${owner.orgId}/projects`, { headers: auth, data: { name: "Orders API" } })).json()).project.id;
  envId = (await (await request.post(`${API}/orgs/${owner.orgId}/projects/${projectId}/environments`, { headers: auth, data: { name: "staging", apiBaseUrl: `http://127.0.0.1:${SITE_PORT}/api` } })).json()).environment.id;
  key = (await (await request.post(`${API}/orgs/${owner.orgId}/projects/${projectId}/api-keys`, { headers: auth, data: { name: "ci" } })).json()).key;
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  errors = watchErrors(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/o\//);
});
test.afterAll(async () => { await site?.close(); await page?.context().close(); });
test.afterEach(() => { expect(errors.splice(0)).toEqual([]); });

const runs = () => page.goto(`/o/${owner.orgId}/projects/${projectId}/runs`);

test("Run now explains what's missing until the environment can be tested", async ({ request }) => {
  await runs();
  await page.getByRole("button", { name: "Run now" }).click();
  const d = dialog(page);
  await expect(d.getByTestId("readiness")).toContainText("Verify the domain of staging first");
  await expect(d.getByTestId("readiness")).toContainText("API checks need the route list");
  await expect(d.getByRole("button", { name: "Start run" })).toBeDisabled();
  await d.getByRole("button", { name: "Cancel" }).click();

  // Verify the domain through the real flow, and let a CI run upload the route list
  const auth = { authorization: `Bearer ${owner.token}` };
  const v = await (await request.get(`${API}/orgs/${owner.orgId}/projects/${projectId}/environments/${envId}/verification`, { headers: auth })).json();
  site.setToken(v.instructions.file.content);
  expect((await request.post(`${API}/orgs/${owner.orgId}/projects/${projectId}/environments/${envId}/verify`, { headers: auth })).status()).toBe(200);
  expect((await request.post(`${API}/runner/runs`, { headers: { authorization: `Bearer ${key}` }, data: { ...sampleRun(envId, []), profile } })).status()).toBe(201);

  await page.reload();
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(d.getByTestId("readiness")).toContainText("Will run API checks on staging");
  await expect(d.getByTestId("readiness")).toContainText("No test accounts");
  await expect(d.getByRole("button", { name: "Start run" })).toBeEnabled();
  await d.getByRole("button", { name: "Cancel" }).click();
});

test("Run now → waiting → running → the result appears by itself", async ({ request }) => {
  const runner = fakeRunner(request);
  await runs();
  await expect(page.locator("table tbody tr").filter({ hasText: "CI" })).toHaveCount(1);
  await page.getByRole("button", { name: "Run now" }).click();
  await dialog(page).getByLabel(/Nightly checks/).check();
  await dialog(page).getByRole("button", { name: "Start run" }).click();
  await toast(page, "Nightly checks queued for staging");
  const job = page.getByTestId("job-row");
  await expect(job).toContainText("Waiting for a runner");
  await expect(job).toContainText("Hana");

  // Starting the same run twice is refused
  await page.getByRole("button", { name: "Run now" }).click();
  await dialog(page).getByLabel(/Nightly checks/).check();
  await dialog(page).getByRole("button", { name: "Start run" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("already queued or running");
  await dialog(page).getByRole("button", { name: "Cancel" }).click();

  const claimed = await runner.claim();
  expect(claimed.job.suite).toBe("nightly");
  await expect(job).toContainText("Running", { timeout: 8000 });
  await runner.complete(claimed.job.id, { run: sampleRun(undefined, [{ fp: "hosted-e2e-1", severity: "critical" }]) });
  // The queue empties and the new run shows up without a reload
  await expect(page.getByTestId("job-row")).toHaveCount(0, { timeout: 8000 });
  const first = page.locator("table tbody tr").first();
  await expect(first).toContainText("Run now");
  await expect(first).toContainText("Failed");
  await expect(page.getByRole("link", { name: /^Issues/ })).toContainText("1");
});

test("cancelling a waiting run and a running one", async ({ request }) => {
  const runner = fakeRunner(request);
  await runs();
  await page.getByRole("button", { name: "Run now" }).click();
  await dialog(page).getByRole("button", { name: "Start run" }).click();
  await toast(page, "Staging checks queued for staging");
  await page.getByRole("button", { name: "Cancel the run on staging" }).click();
  await dialog(page).getByRole("button", { name: "Cancel run" }).click();
  await toast(page, "Run cancelled");
  await expect(page.getByTestId("job-row")).toContainText("Cancelled");
  expect(await runner.claim({ expectNone: true })).toBeNull();

  await page.getByRole("button", { name: "Run now" }).click();
  await dialog(page).getByRole("button", { name: "Start run" }).click();
  const claimed = await runner.claim();
  await expect(page.getByTestId("job-row").filter({ hasText: "Running" })).toHaveCount(1, { timeout: 8000 });
  await page.getByRole("button", { name: "Cancel the run on staging" }).click();
  await dialog(page).getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByTestId("job-row").filter({ hasText: "Stopping" })).toHaveCount(1);
  expect((await runner.heartbeat(claimed.job.id)).cancel).toBe(true);
  await runner.complete(claimed.job.id, { error: "Cancelled" });
  await expect(page.getByTestId("job-row").filter({ hasText: "Cancelled" })).toHaveCount(2, { timeout: 8000 });
});

test("a run that couldn't start shows why", async ({ request }) => {
  const runner = fakeRunner(request);
  await runs();
  await page.getByRole("button", { name: "Run now" }).click();
  await dialog(page).getByRole("button", { name: "Start run" }).click();
  const claimed = await runner.claim();
  await runner.complete(claimed.job.id, { error: "Engine exited with code 2: login path not found" });
  await expect(page.getByTestId("job-row").filter({ hasText: "Couldn't run" })).toContainText("login path not found", { timeout: 8000 });
});

test("schedules: create in plain words, pause, edit, delete", async () => {
  await page.goto(`/o/${owner.orgId}/projects/${projectId}/schedules`);
  await expect(page.getByRole("heading", { name: "No schedules" })).toBeVisible();
  await page.getByRole("button", { name: "New schedule" }).click();
  const d = dialog(page);
  await d.getByLabel("How often").selectOption("weekdays");
  await d.getByLabel("Time", { exact: true }).fill("09:15");
  await d.getByLabel("Time zone").selectOption("Asia/Karachi");
  await expect(d.getByTestId("schedule-summary")).toContainText("Weekdays at 09:15 (Asia/Karachi) · nightly checks on staging");
  await d.getByRole("button", { name: "Create schedule" }).click();
  await toast(page, "Schedule created");
  const row = page.getByTestId("schedule-row");
  await expect(row).toContainText("Weekdays at 09:15");
  await expect(row).toContainText("Asia/Karachi");
  await expect(row).toContainText("09:15");
  await expect(row).toContainText("Not yet");

  await page.getByRole("button", { name: "Pause Weekdays at 09:15" }).click();
  await toast(page, "Schedule paused");
  await expect(row).toContainText("Paused");
  await page.getByRole("button", { name: "Resume Weekdays at 09:15" }).click();
  await toast(page, "Schedule resumed");

  // Edit opens on the friendly form; a too-frequent custom cron is refused with the reason
  await page.getByRole("button", { name: "Edit Weekdays at 09:15" }).click();
  await expect(d.getByLabel("How often")).toHaveValue("weekdays");
  await expect(d.getByLabel("Time", { exact: true })).toHaveValue("09:15");
  await d.getByLabel("How often").selectOption("custom");
  await d.getByLabel("Cron expression").fill("*/10 * * * *");
  await d.getByRole("button", { name: "Save schedule" }).click();
  await expect(d.getByRole("alert")).toContainText("closer together than 60 minutes");
  await d.getByLabel("How often").selectOption("weekly");
  await d.getByLabel("Day").selectOption("Saturday");
  await d.getByRole("button", { name: "Save schedule" }).click();
  await toast(page, "Schedule saved");
  await expect(row).toContainText("Every Saturday at 09:15");

  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);

  await page.getByRole("button", { name: "Delete Every Saturday at 09:15" }).click();
  await dialog(page).getByRole("button", { name: "Delete schedule" }).click();
  await toast(page, "Schedule deleted");
  await expect(page.getByTestId("schedule-row")).toHaveCount(0);
});

test("audit log names the hosted runner and the schedule changes", async () => {
  await page.goto(`/o/${owner.orgId}/audit`);
  const text = await page.locator("table").innerText();
  for (const what of ["started a hosted run", "cancelled a hosted run", "handed test accounts to a runner", "created a schedule", "changed a schedule", "deleted a schedule"]) expect(text).toContain(what);
  await expect(page.getByTestId("audit-row").filter({ hasText: "handed test accounts" }).first()).toContainText("Hosted runner");
});

test("viewers see the queue and schedules but can't start or change anything", async ({ browser, request }) => {
  const auth = { authorization: `Bearer ${owner.token}` };
  const email = `viewer-${Date.now()}@acme.test`;
  const v = await (await request.post(`${API}/auth/signup`, { data: { name: "Vee", email, password: PASSWORD, createOrg: false } })).json();
  const inv = await (await request.post(`${API}/orgs/${owner.orgId}/invites`, { headers: auth, data: { email, role: "viewer" } })).json();
  await request.post(`${API}/invites/accept`, { headers: { authorization: `Bearer ${v.tokens.accessToken}` }, data: { token: inv.token } });
  const ctx = await browser.newContext();
  const vp = await ctx.newPage();
  await vp.goto("/login");
  await vp.getByLabel("Email").fill(email);
  await vp.getByLabel("Password").fill(PASSWORD);
  await vp.getByRole("button", { name: "Log in" }).click();
  await expect(vp).toHaveURL(/\/o\//);
  await vp.goto(`/o/${owner.orgId}/projects/${projectId}/runs`);
  await expect(vp.locator("table tbody tr").first()).toBeVisible();
  await expect(vp.getByRole("button", { name: "Run now" })).toHaveCount(0);
  await vp.goto(`/o/${owner.orgId}/projects/${projectId}/schedules`);
  await expect(vp.getByRole("button", { name: "New schedule" })).toHaveCount(0);
  await ctx.close();
});
