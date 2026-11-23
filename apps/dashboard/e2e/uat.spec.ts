import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { API, PASSWORD, dialog, sampleRun, toast, uploadRun, watchErrors } from "./helpers";

test.describe.configure({ mode: "serial" });

let owner: { token: string; orgId: string; email: string };
let projectId = "";
let page: Page;
let errors: string[];

async function axe(p: Page, what: string) {
  const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect.soft(r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `accessibility problems on ${what}`).toEqual([]);
}

test.beforeAll(async ({ browser, request }) => {
  const email = `uat-${Date.now()}@acme.test`;
  const created = await (await request.post(`${API}/auth/signup`, { data: { name: "UAT Owner", email, password: PASSWORD, orgName: "UAT QA" } })).json();
  owner = { token: created.tokens.accessToken, orgId: created.org.id, email };
  const auth = { authorization: `Bearer ${owner.token}` };
  projectId = (await (await request.post(`${API}/orgs/${owner.orgId}/projects`, { headers: auth, data: { name: "Loyalty API" } })).json()).project.id;
  const key = (await (await request.post(`${API}/orgs/${owner.orgId}/projects/${projectId}/api-keys`, { headers: auth, data: { name: "E2E runner" } })).json()).key;
  expect((await uploadRun(request, key, sampleRun(undefined, []))).status()).toBe(201);

  page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  errors = watchErrors(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/o\//);
});
test.afterAll(async () => { await page?.context().close(); });
test.afterEach(() => { expect(errors.splice(0)).toEqual([]); });

test("create a release with criteria from the Acceptance tab", async () => {
  await page.goto(`/o/${owner.orgId}/projects/${projectId}/runs`);
  await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Acceptance" }).click();
  await expect(page.getByText("No UAT releases")).toBeVisible();
  await page.getByRole("button", { name: "New release" }).click();
  await axe(page, "new UAT release dialog");
  await dialog(page).getByLabel("Release name").fill("v2.3 Promotions");
  await dialog(page).getByLabel("Acceptance criteria").fill("Merchant can create a 15% promotion\n\n  Customers see the promotion in the app  ");
  await expect(dialog(page)).toContainText("2 criteria");
  await dialog(page).getByRole("button", { name: "Create release" }).click();
  await toast(page, "Release created");
  const row = page.getByTestId("uat-release-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("In testing");
  await expect(row).toContainText("0 of 2 passed");
  await axe(page, "UAT release list");
});

test("record results; sign-off only when everything passed; the decision locks the release", async () => {
  await page.getByRole("link", { name: "v2.3 Promotions" }).click();
  const summary = page.getByRole("region", { name: "Release summary" });
  await expect(summary.getByRole("button", { name: "Sign off" })).toBeDisabled();
  const first = page.getByRole("listitem", { name: /Criterion 1:/ });
  const second = page.getByRole("listitem", { name: /Criterion 2:/ });
  await first.getByLabel("Result").selectOption("passed");
  await first.getByLabel("Evidence run").selectOption({ index: 1 });
  await first.getByRole("button", { name: "Save result" }).click();
  await toast(page, "Result saved");
  await expect(first).toContainText("Passed");
  await expect(first.getByRole("link", { name: /^run / })).toBeVisible();

  await second.getByLabel("Result").selectOption("failed");
  await expect(second.getByLabel("Note")).toHaveAttribute("required", "");
  await second.getByLabel("Note").fill("Promotion did not appear for customers");
  await second.getByRole("button", { name: "Save result" }).click();
  await toast(page, "Result saved");
  await expect(summary).toContainText("1 of 2 passed · 1 failed");
  await expect(summary.getByRole("button", { name: "Sign off" })).toBeDisabled();
  await axe(page, "UAT release with recorded results");

  await second.getByLabel("Result").selectOption("passed");
  await second.getByLabel("Note").fill("");
  await second.getByRole("button", { name: "Save result" }).click();
  await toast(page, "Result saved");
  await summary.getByRole("button", { name: "Sign off" }).click();
  await axe(page, "sign-off dialog");
  await dialog(page).getByLabel("Note").fill("Approved for the 2.3 release");
  await dialog(page).getByRole("button", { name: "Sign off" }).click();
  await toast(page, "Release signed off");
  await expect(summary.getByTestId("uat-decision")).toContainText("Signed off by UAT Owner");
  await expect(page.getByRole("button", { name: "Save result" })).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Add a criterion" })).toHaveCount(0);

  const [download] = await Promise.all([page.waitForEvent("download"), summary.getByRole("button", { name: "Download report" }).click()]);
  expect(download.suggestedFilename()).toBe("uat-v2-3-promotions.md");
  const md = Buffer.concat(await (await download.createReadStream()).toArray()).toString("utf8");
  expect(md).toContain("# UAT report: v2.3 Promotions");
  expect(md).toContain("Status: **Signed off** by UAT Owner");
  expect(md).toMatch(/\| 2 \| Customers see the promotion in the app \| Passed \|/);

  await summary.getByRole("button", { name: "Reopen" }).click();
  await dialog(page).getByLabel("Reason").fill("Regression found in staging");
  await dialog(page).getByRole("button", { name: "Reopen" }).click();
  await toast(page, "Release reopened");
  await expect(summary).toContainText("In testing");
  await expect(page.getByRole("button", { name: "Save result" }).first()).toBeVisible();
});

test("a criterion linked to an uploaded API scenario shows its latest result and can use that run as evidence", async ({ request }) => {
  const auth = { authorization: `Bearer ${owner.token}` };
  const key = (await (await request.post(`${API}/orgs/${owner.orgId}/projects/${projectId}/api-keys`, { headers: auth, data: { name: "Scenario runner" } })).json()).key;
  const run = sampleRun(undefined, []) as any;
  run.results.push({ plugin: "api-scenarios", status: "passed", durationMs: 900, findings: [],
    cases: [{ name: "Merchant promotion lifecycle", status: "passed", tags: ["uat", "smoke"], ms: 420 }, { name: "Checkout awards points", status: "failed", tags: ["regression"] }] });
  const uploaded = await uploadRun(request, key, run);
  expect(uploaded.status()).toBe(201);
  const runId = (await uploaded.json()).runId;

  await page.reload();
  const form = page.getByRole("form", { name: "Add a criterion" });
  await form.getByLabel("Criterion").fill("Merchants manage promotions end to end");
  const scenarioField = form.getByLabel("Automated scenario");
  const listId = await scenarioField.getAttribute("list");
  await expect(page.locator(`datalist[id="${listId}"] option`)).toHaveCount(2);
  await expect(page.locator(`datalist[id="${listId}"] option[value="Merchant promotion lifecycle"]`)).toHaveText("Latest: passed (uat, smoke)");
  await scenarioField.fill("Merchant promotion lifecycle");
  await form.getByRole("button", { name: "Add criterion" }).click();
  await toast(page, "Criterion added");
  await expect(scenarioField).toHaveValue("");

  const row = page.getByRole("listitem", { name: /Criterion 3:/ });
  const automated = row.getByTestId("uat-automated");
  await expect(automated).toContainText("Automated scenario: Merchant promotion lifecycle");
  await expect(automated).toContainText("Latest result: Passed");
  await expect(automated.getByRole("link", { name: /^run / })).toHaveAttribute("href", new RegExp(`/runs/${runId}$`));
  await axe(page, "criterion with an automated result");
  await automated.getByRole("button", { name: "Use this run as evidence" }).click();
  await row.getByLabel("Result").selectOption("passed");
  await row.getByRole("button", { name: "Save result" }).click();
  await toast(page, "Result saved");
  const saved = page.getByRole("listitem", { name: /Criterion 3:/ });
  await expect(saved).toContainText("Passed");
  await expect(saved.getByText(/^Evidence:/)).toBeVisible();
  await expect(saved.getByRole("button", { name: "Use this run as evidence" })).toHaveCount(0);
});

test("viewers see the release but cannot record or decide", async ({ browser, request }) => {
  const email = `uat-viewer-${Date.now()}@acme.test`;
  const user = await (await request.post(`${API}/auth/signup`, { data: { name: "UAT Viewer", email, password: PASSWORD, createOrg: false } })).json();
  const invite = await (await request.post(`${API}/orgs/${owner.orgId}/invites`, { headers: { authorization: `Bearer ${owner.token}` }, data: { email, role: "viewer" } })).json();
  expect((await request.post(`${API}/invites/accept`, { headers: { authorization: `Bearer ${user.tokens.accessToken}` }, data: { token: invite.token } })).status()).toBe(200);
  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  const viewerErrors = watchErrors(viewer);
  await viewer.goto("/login");
  await viewer.getByLabel("Email").fill(email);
  await viewer.getByLabel("Password").fill(PASSWORD);
  await viewer.getByRole("button", { name: "Log in" }).click();
  await expect(viewer).toHaveURL(/\/o\//);
  await viewer.goto(`/o/${owner.orgId}/projects/${projectId}/uat`);
  await expect(viewer.getByRole("button", { name: "New release" })).toHaveCount(0);
  await viewer.getByRole("link", { name: "v2.3 Promotions" }).click();
  await expect(viewer.getByRole("listitem", { name: /Criterion 1:/ })).toContainText("Passed");
  await expect(viewer.getByRole("button", { name: "Save result" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Sign off" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Download report" })).toBeVisible();
  expect(viewerErrors).toEqual([]);
  await ctx.close();
});
