import { test, expect, type Page } from "@playwright/test";
import { API, PASSWORD, sampleRun, uploadRun, watchErrors } from "./helpers";

test.describe.configure({ mode: "serial" });

let owner: { token: string; orgId: string; email: string };
let projectId = "";
let issueId = "";
let page: Page;
let errors: string[];

test.beforeAll(async ({ browser, request }) => {
  const email = `collab-${Date.now()}@acme.test`;
  const created = await (await request.post(`${API}/auth/signup`, { data: { name: "Collaboration Owner", email, password: PASSWORD, orgName: "Collaboration QA" } })).json();
  owner = { token: created.tokens.accessToken, orgId: created.org.id, email };
  const auth = { authorization: `Bearer ${owner.token}` };
  projectId = (await (await request.post(`${API}/orgs/${owner.orgId}/projects`, { headers: auth, data: { name: "Discussion API" } })).json()).project.id;
  const key = (await (await request.post(`${API}/orgs/${owner.orgId}/projects/${projectId}/api-keys`, { headers: auth, data: { name: "E2E runner" } })).json()).key;
  expect((await uploadRun(request, key, sampleRun(undefined, [{ fp: "collaboration-xss" }]))).status()).toBe(201);
  expect((await uploadRun(request, key, sampleRun(undefined, []))).status()).toBe(201);
  const issues = await (await request.get(`${API}/orgs/${owner.orgId}/projects/${projectId}/issues?status=all`, { headers: auth })).json();
  issueId = issues.issues.find((i: any) => i.fingerprint === "collaboration-xss").id;

  page = await (await browser.newContext()).newPage();
  errors = watchErrors(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/o\//);
});

test.afterAll(async () => { await page?.context().close(); });
test.afterEach(() => { expect(errors.splice(0)).toEqual([]); });

test("issue discussion displays comment markup as text and posts it", async () => {
  await page.goto(`/o/${owner.orgId}/projects/${projectId}/issues/${issueId}`);
  const comment = `<img src=x onerror=alert(1)> "quoted" & plain text`;
  await page.getByLabel("Add a comment").fill(comment);
  await page.getByRole("button", { name: "Post comment" }).click();
  const discussion = page.getByRole("region", { name: "Issue discussion" });
  await expect(discussion.getByText(comment, { exact: true })).toBeVisible();
  await expect(discussion.locator("img")).toHaveCount(0);
});

test("trends show run data and CSV export", async () => {
  await page.goto(`/o/${owner.orgId}/projects/${projectId}/trends`);
  const daily = page.getByRole("table", { name: "Daily outcomes" });
  await expect(daily).toBeVisible();
  await expect(daily.locator("tbody tr").first().locator("td").nth(1)).toHaveText("2");
  await expect(page.getByRole("table", { name: "Plugin outcomes" })).toContainText("api-auth");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  expect(download.suggestedFilename()).toBe("veriq-trends.csv");
  const csv = Buffer.concat(await (await download.createReadStream()).toArray()).toString("utf8");
  expect(csv.split("\r\n")[0]).toBe("day,runs,passed,failed,envErrors,averageDurationMs,newIssues,fixedIssues");
  expect(csv).toMatch(/,2,1,1,/);
});

test("viewers can read comments but cannot post", async ({ browser, request }) => {
  const email = `collab-viewer-${Date.now()}@acme.test`;
  const user = await (await request.post(`${API}/auth/signup`, { data: { name: "Issue Viewer", email, password: PASSWORD, createOrg: false } })).json();
  const auth = { authorization: `Bearer ${owner.token}` };
  const invite = await (await request.post(`${API}/orgs/${owner.orgId}/invites`, { headers: auth, data: { email, role: "viewer" } })).json();
  expect((await request.post(`${API}/invites/accept`, { headers: { authorization: `Bearer ${user.tokens.accessToken}` }, data: { token: invite.token } })).status()).toBe(200);

  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  const viewerErrors = watchErrors(viewer);
  await viewer.goto("/login");
  await viewer.getByLabel("Email").fill(email);
  await viewer.getByLabel("Password").fill(PASSWORD);
  await viewer.getByRole("button", { name: "Log in" }).click();
  await expect(viewer).toHaveURL(/\/o\//);
  await viewer.goto(`/o/${owner.orgId}/projects/${projectId}/issues/${issueId}`);
  await expect(viewer.getByRole("region", { name: "Issue discussion" })).toContainText("<img src=x onerror=alert(1)>");
  await expect(viewer.getByLabel("Add a comment")).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Post comment" })).toHaveCount(0);
  expect(viewerErrors).toEqual([]);
  await ctx.close();
});
