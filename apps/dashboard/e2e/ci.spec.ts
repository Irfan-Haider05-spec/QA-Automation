/**
 * CI integration in the dashboard: API key permissions, run triggers with
 * GitHub links, deployments, and the CI setup tab's generated files.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { API, PASSWORD, dialog, sampleRun, toast, uploadRun, watchErrors } from "./helpers";

test.describe.configure({ mode: "serial" });

let owner: { token: string; orgId: string; email: string };
let projectId = "";
let envId = "";
let key = "";

async function apiSignup(request: APIRequestContext, label: string, orgName?: string, createOrg = true) {
  const email = `${label}-${Date.now()}@acme.test`;
  const r = await (await request.post(`${API}/auth/signup`, { data: { name: label, email, password: PASSWORD, orgName, createOrg } })).json();
  return { token: r.tokens.accessToken as string, orgId: r.org?.id as string, email };
}
async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/o\//);
}

test.beforeAll(async ({ request }) => {
  owner = await apiSignup(request, "ci-owner", "CI Org");
  const auth = { authorization: `Bearer ${owner.token}` };
  projectId = (await (await request.post(`${API}/orgs/${owner.orgId}/projects`, { headers: auth, data: { name: "Orders API", stack: "node-express" } })).json()).project.id;
  envId = (await (await request.post(`${API}/orgs/${owner.orgId}/projects/${projectId}/environments`, { headers: auth, data: { name: "staging", apiBaseUrl: "https://staging-orders.acme.test" } })).json()).environment.id;
  for (const name of ["merchantA", "merchantB"]) {
    await request.post(`${API}/orgs/${owner.orgId}/projects/${projectId}/environments/${envId}/credentials`, { headers: auth, data: { name, role: "MERCHANT", identifier: `${name}@x.test`, secret: "pw-secret-1" } });
  }
});

test("owner creates a key that can read test-account passwords", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, owner.email);
  await page.goto(`/o/${owner.orgId}/projects/${projectId}/api-keys`);
  await page.getByRole("button", { name: "New API key" }).click();
  await dialog(page).getByLabel("Key name").fill("GitHub Actions");
  await dialog(page).getByLabel(/Can read test-account passwords/).check();
  await dialog(page).getByRole("button", { name: "Create key" }).click();
  await toast(page, 'API key "GitHub Actions" created');
  key = (await dialog(page).getByLabel("API key").textContent())!.trim();
  await expect(dialog(page).getByRole("link", { name: "CI setup" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("row", { name: /GitHub Actions/ })).toContainText("Upload runs, read test-account passwords");
  expect(errors).toEqual([]);
});

test("runs show their trigger with links to GitHub, and the deployment", async ({ page, request }) => {
  const errors = watchErrors(page);
  // A deploy-triggered run, a PR run and a local run
  const dep = await (await request.post(`${API}/runner/deployments`, { headers: { authorization: `Bearer ${key}` }, data: { environmentId: envId, sha: "deadbeefcafe1234", ref: "staging", version: "v3.1.0" } })).json();
  const git = { sha: "deadbeefcafe1234", ref: "staging", repo: "acme/orders", ciUrl: "https://github.com/acme/orders/actions/runs/55" };
  expect((await uploadRun(request, key, { ...sampleRun(envId, [{ fp: "ci-deploy-1" }]), trigger: "deploy", deploymentId: dep.deployment.id, git })).status()).toBe(201);
  expect((await uploadRun(request, key, { ...sampleRun(undefined, []), trigger: "pr", git: { sha: "abcabcabc999", ref: "feature/x", pr: "42", repo: "acme/orders", ciUrl: "https://github.com/acme/orders/actions/runs/56" } })).status()).toBe(201);
  expect((await uploadRun(request, key, { ...sampleRun(undefined, []), source: "cli", git: undefined })).status()).toBe(201);

  await login(page, owner.email);
  await page.goto(`/o/${owner.orgId}/projects/${projectId}/runs`);
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Local run");
  await expect(rows.nth(1).getByRole("link", { name: "PR #42" })).toHaveAttribute("href", "https://github.com/acme/orders/pull/42");
  await expect(rows.nth(2).getByRole("link", { name: "Deploy v3.1.0" })).toHaveAttribute("href", "https://github.com/acme/orders/commit/deadbeefcafe1234");

  await rows.nth(2).getByRole("link", { name: /Open run/ }).click();
  await expect(page.getByRole("link", { name: "deadbeef" })).toHaveAttribute("href", "https://github.com/acme/orders/commit/deadbeefcafe1234");
  await expect(page.getByRole("link", { name: "Job log and report artifact" })).toHaveAttribute("href", git.ciUrl);
  await expect(page.locator("dl.kv")).toContainText("v3.1.0");
  expect(errors).toEqual([]);
});

test("CI setup tab generates the workflow and config for this project", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, owner.email);
  await page.goto(`/o/${owner.orgId}/projects/${projectId}/runs`);
  await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "CI setup" }).click();
  await expect(page.getByRole("heading", { name: "Run the QA agent in GitHub Actions" })).toBeVisible();
  await expect(page.locator(".steps")).toContainText("QA_PLATFORM_API_KEY");
  await expect(page.locator(".steps")).toContainText("https://staging-orders.acme.test");

  const wf = page.getByTestId("file-.github/workflows/qa.yml");
  await expect(wf).toContainText(`QA_PLATFORM_ENV: ${envId}`);
  await expect(wf).toContainText(`QA_PLATFORM_URL: ${new URL(page.url()).origin}`);
  await expect(wf).toContainText('platform-accounts: "true"');
  await expect(wf).toContainText("branches: [staging]");
  await page.getByLabel("Branch that deploys to staging").fill("release");
  await expect(wf).toContainText("branches: [release]");
  await page.getByLabel("GitHub Action", { exact: true }).fill("acme/qa-agent@v2");
  await expect(wf).toContainText("uses: acme/qa-agent@v2");

  const cfg = page.getByTestId("file-qa.config.ts");
  await expect(cfg).toContainText('project: "Orders API"');
  await expect(cfg).toContainText("merchantA: { identifier: process.env.QA_MERCHANT_A_ID");
  await expect(cfg).toContainText('owner: "merchantA", attacker: "merchantB"');

  // PR checks only
  await page.getByLabel("Staging environment").selectOption("");
  await expect(wf).not.toContainText("staging:");
  await expect(wf).not.toContainText("QA_PLATFORM_ENV");
  await expect(page.getByLabel("Branch that deploys to staging")).toBeDisabled();

  // Download gives the same file
  await page.getByLabel("Staging environment").selectOption(envId);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("region", { name: "Workflow file" }).getByRole("button", { name: "Download" }).click()]);
  expect(download.suggestedFilename()).toBe("qa.yml");
  const text = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
  expect(text).toContain(`QA_PLATFORM_ENV: ${envId}`);

  // Deployments, with the result of the run that checked each one
  const dep = page.getByTestId("deployment-row");
  await expect(dep).toHaveCount(1);
  await expect(dep).toContainText("v3.1.0");
  await expect(dep).toContainText("staging");
  await expect(dep.getByRole("link")).toContainText("Failed");

  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test("without a password-reading key the CI tab explains the env-var route", async ({ page, request }) => {
  const auth = { authorization: `Bearer ${owner.token}` };
  const keys = (await (await request.get(`${API}/orgs/${owner.orgId}/projects/${projectId}/api-keys`, { headers: auth })).json()).apiKeys;
  for (const k of keys) await request.delete(`${API}/orgs/${owner.orgId}/projects/${projectId}/api-keys/${k.id}`, { headers: auth });
  await login(page, owner.email);
  await page.goto(`/o/${owner.orgId}/projects/${projectId}/ci`);
  await expect(page.locator(".alert").filter({ hasText: "Test accounts" })).toContainText("Test accounts are read from CI env vars");
  await expect(page.getByTestId("file-.github/workflows/qa.yml")).toContainText('platform-accounts: "false"');
  await expect(page.locator(".steps").getByRole("link", { name: "Create an API key" })).toBeVisible();
});

test("developers can't create password-reading keys; viewers don't see CI setup", async ({ browser, request }) => {
  const auth = { authorization: `Bearer ${owner.token}` };
  const people: Record<string, { email: string }> = {};
  for (const role of ["developer", "viewer"] as const) {
    const u = await apiSignup(request, `ci-${role}`, undefined, false);
    const inv = await (await request.post(`${API}/orgs/${owner.orgId}/invites`, { headers: auth, data: { email: u.email, role } })).json();
    expect((await request.post(`${API}/invites/accept`, { headers: { authorization: `Bearer ${u.token}` }, data: { token: inv.token } })).status()).toBe(200);
    people[role] = u;
  }
  const dctx = await browser.newContext();
  const dev = await dctx.newPage();
  await login(dev, people.developer.email);
  await dev.goto(`/o/${owner.orgId}/projects/${projectId}/api-keys`);
  await dev.getByRole("button", { name: "New API key" }).click();
  await expect(dialog(dev).getByLabel(/Can read test-account passwords/)).toHaveCount(0);
  await expect(dialog(dev)).toContainText("can only be created by owners and admins");
  await dctx.close();

  const vctx = await browser.newContext();
  const viewer = await vctx.newPage();
  await login(viewer, people.viewer.email);
  await viewer.goto(`/o/${owner.orgId}/projects/${projectId}/runs`);
  await expect(viewer.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "CI setup" })).toHaveCount(0);
  await vctx.close();
});
