/**
 * Walks every screen and action of the dashboard as real users would:
 * an owner, an invited developer limited to one client, and a viewer.
 * Tests run in order and share state (one fresh in-memory database per run).
 */
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { dialog, loginUi, orgIdFromUrl, PASSWORD, sampleRun, signupUi, startTargetSite, toast, uploadRun, watchErrors } from "./helpers";

test.describe.configure({ mode: "serial" });

const OWNER = { name: "Ayesha Khan", email: "ayesha@acme.test" };
const DEV = { name: "Bilal Ahmed", email: "bilal@acme.test" };
let ctx: BrowserContext;
let page: Page;
let errors: string[];
let orgId = "";
let projectId = "";
let envId = "";
let apiKey = "";
let devInviteLink = "";
let target: Awaited<ReturnType<typeof startTargetSite>>;

async function newUser(browser: Browser) {
  const c = await browser.newContext();
  const p = await c.newPage();
  return { c, p, errors: watchErrors(p) };
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  errors = watchErrors(page);
  target = await startTargetSite(4199);
});

test.afterAll(async () => {
  await target?.close();
  await ctx?.close();
});

test.afterEach(async () => {
  const seen = errors.splice(0);
  expect(seen, "browser errors on the owner's page").toEqual([]);
});

// ── Auth ─────────────────────────────────────────────────────────────────────

test("signed-out visitors are sent to log in, keeping where they were going", async () => {
  await page.goto("/o/00000000-0000-4000-8000-000000000000/projects");
  await expect(page).toHaveURL(/\/login\?next=%2Fo%2F/);
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
});

test("signup validates input, then creates the account and organization", async () => {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Work email").fill(OWNER.email);
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Create account" }).click();
  // Browser validation keeps the user on the page
  await expect(page).toHaveURL(/\/signup/);
  expect(await page.getByLabel("Password").evaluate((el: HTMLInputElement) => el.validity.tooShort)).toBe(true);

  await signupUi(page, OWNER.name, OWNER.email, "Acme QA");
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  orgId = orgIdFromUrl(page);
  await expect(page.getByRole("heading", { level: 1, name: "Acme QA" })).toBeVisible();
  await expect(page.getByTestId("org-switcher")).toContainText("Owner");
});

test("signup with an email that's taken shows a clear error", async ({ browser }) => {
  const u = await newUser(browser);
  await signupUi(u.p, "Someone", OWNER.email.toUpperCase(), "Other");
  await expect(u.p.getByRole("alert")).toContainText(/already exists/i);
  await u.c.close();
});

test("log out, wrong password, then log in again", async () => {
  await page.getByRole("button", { name: new RegExp(OWNER.name) }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => localStorage.getItem("qa.session"))).toBeNull();

  await loginUi(page, OWNER.email, "not-the-password");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${orgId}$`));
});

test("an expired access token is refreshed silently", async () => {
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("qa.session")!);
    s.accessToken = "expired.invalid.token";
    localStorage.setItem("qa.session", JSON.stringify(s));
  });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Acme QA" })).toBeVisible();
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem("qa.session")!));
  expect(s.accessToken).not.toBe("expired.invalid.token");
});

test("a revoked session signs the user out", async ({ browser }) => {
  const u = await newUser(browser);
  await u.p.goto("/login");
  await loginUi(u.p, OWNER.email);
  await expect(u.p).toHaveURL(new RegExp(`/o/${orgId}$`));
  await u.p.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("qa.session")!);
    localStorage.setItem("qa.session", JSON.stringify({ ...s, accessToken: "bad", refreshToken: "bad-refresh-token" }));
  });
  await u.p.reload();
  await expect(u.p).toHaveURL(/\/login/);
  await u.c.close();
});

// ── Clients ──────────────────────────────────────────────────────────────────

test("clients: create, rename, delete", async () => {
  await page.getByRole("link", { name: "Clients" }).click();
  await expect(page.getByRole("heading", { name: "No clients" })).toBeVisible();
  for (const name of ["Client One", "Client Two"]) {
    await page.getByRole("button", { name: "New client" }).click();
    await dialog(page).getByLabel("Client name").fill(name);
    await dialog(page).getByRole("button", { name: "Create client" }).click();
    await toast(page, `Client "${name}" created`);
  }
  await page.getByRole("button", { name: "Rename Client One" }).click();
  await dialog(page).getByLabel("Client name").fill("Northwind");
  await dialog(page).getByRole("button", { name: "Save name" }).click();
  await toast(page, "Client renamed");
  await expect(page.getByRole("cell", { name: "Northwind", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Delete Client Two" }).click();
  await dialog(page).getByRole("button", { name: "Delete client" }).click();
  await toast(page, "Client deleted");
  await expect(page.getByRole("cell", { name: "Client Two", exact: true })).toHaveCount(0);

  // Empty name is blocked by the form
  await page.getByRole("button", { name: "New client" }).click();
  await dialog(page).getByRole("button", { name: "Create client" }).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

// ── Projects ─────────────────────────────────────────────────────────────────

test("projects: create one for a client and land on its environments", async () => {
  await page.getByRole("link", { name: "Projects" }).click();
  await page.getByRole("button", { name: "New project" }).click();
  await dialog(page).getByLabel("Project name").fill("Loyalty API");
  await dialog(page).getByLabel("Client").selectOption({ label: "Northwind" });
  await dialog(page).getByLabel("Repository URL").fill("https://github.com/acme/loyalty-api");
  await dialog(page).getByRole("button", { name: "Create project" }).click();
  await toast(page, 'Project "Loyalty API" created');
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/environments$/);
  projectId = page.url().match(/projects\/([0-9a-f-]{36})/)![1];
  await expect(page.getByRole("heading", { level: 1, name: "Loyalty API" })).toBeVisible();
  await expect(page.locator(".crumbs")).toContainText("Northwind");

  // A second project, used later for deletion and client scoping
  await page.goto(`/o/${orgId}/projects?new=1`);
  await dialog(page).getByLabel("Project name").fill("Internal Tools");
  await dialog(page).getByRole("button", { name: "Create project" }).click();
  await toast(page, 'Project "Internal Tools" created');

  // A client that still has projects can't be deleted
  await page.goto(`/o/${orgId}/clients`);
  await expect(page.getByRole("row", { name: /Northwind/ })).toContainText("1");
  await page.getByRole("button", { name: "Delete Northwind" }).click();
  await dialog(page).getByRole("button", { name: "Delete client" }).click();
  await expect(dialog(page).getByRole("alert")).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();

  await page.goto(`/o/${orgId}/projects`);
  await expect(page.getByRole("link", { name: /Loyalty API/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Internal Tools/ })).toBeVisible();
});

test("projects: the list filter narrows results", async () => {
  const filter = page.getByPlaceholder(/filter/i);
  await filter.fill("loyal");
  await expect(page.getByRole("link", { name: /Loyalty API/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Internal Tools/ })).toHaveCount(0);
  await filter.fill("");
});

// ── Environments, verification, test accounts ────────────────────────────────

test("environments: one host per environment is enforced", async () => {
  await page.goto(`/o/${orgId}/projects/${projectId}/environments`);
  await page.getByRole("button", { name: "New environment" }).click();
  const d = dialog(page);
  await d.getByLabel("Name", { exact: true }).first().fill("broken");
  await d.getByLabel("API base URL").fill("http://127.0.0.1:4199/api");
  await d.getByRole("button", { name: "Add dashboard" }).click();
  await d.getByLabel("Name", { exact: true }).nth(1).fill("admin");
  await d.getByLabel("URL", { exact: true }).fill("http://localhost:5999/admin");
  await d.getByRole("button", { name: "Create environment" }).click();
  await expect(d.getByRole("alert")).toContainText(/share one host/i);
  await d.getByRole("button", { name: "Cancel" }).click();
});

test("environments: create with a dashboard and write tests allowed", async () => {
  await page.getByRole("button", { name: "New environment" }).click();
  const d = dialog(page);
  await d.getByLabel("Name", { exact: true }).first().fill("staging");
  await d.getByLabel("API base URL").fill("http://127.0.0.1:4199/api");
  await d.getByRole("button", { name: "Add dashboard" }).click();
  await d.getByLabel("Name", { exact: true }).nth(1).fill("admin");
  await d.getByLabel("URL", { exact: true }).fill("http://127.0.0.1:4199/admin");
  await d.getByLabel(/Disposable database/).check();
  await d.getByRole("button", { name: "Create environment" }).click();
  await toast(page, 'Environment "staging" created');
  const env = page.getByRole("region", { name: "Environment staging" });
  await expect(env).toContainText("Disposable: write tests allowed");
  await expect(env).toContainText("http://127.0.0.1:4199/admin");
  await expect(env).toContainText("Domain not verified");
  envId = (await env.locator("text=Environment ID").locator("span.mono").textContent())!.trim();
  expect(envId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByRole("link", { name: /Environments/ })).toContainText("1");
});

test("environments: domain verification fails until the file is served, then passes", async () => {
  const env = page.getByRole("region", { name: "Environment staging" });
  await env.getByRole("button", { name: "Verify domain" }).click();
  await expect(env.getByLabel("DNS record name")).toHaveText("_qa-verify.127.0.0.1");
  const token = (await env.getByLabel("File content").textContent())!.trim();
  await expect(env.getByLabel("DNS record value")).toHaveText(`qa-verify=${token}`);

  await env.getByRole("button", { name: "Check now" }).click();
  await expect(env.getByRole("alert")).toContainText(/couldn't find the record/i);

  target.setToken(token);
  await env.getByRole("button", { name: "Check now" }).click();
  await toast(page, "Domain verified");
  await expect(env).toContainText("Domain verified");
});

test("environments: edit and delete", async () => {
  // A throwaway environment to edit and delete
  await page.getByRole("button", { name: "New environment" }).click();
  await dialog(page).getByLabel("Name", { exact: true }).fill("temp");
  await dialog(page).getByRole("button", { name: "Create environment" }).click();
  await toast(page, 'Environment "temp" created');
  const temp = page.getByRole("region", { name: "Environment temp" });
  await expect(temp).toContainText("Add a URL to verify the domain.");

  await temp.getByRole("button", { name: "Edit" }).click();
  await dialog(page).getByLabel("Name", { exact: true }).fill("temp-renamed");
  await dialog(page).getByRole("button", { name: "Save environment" }).click();
  await toast(page, "Environment saved");
  const renamed = page.getByRole("region", { name: "Environment temp-renamed" });
  await renamed.getByRole("button", { name: "Delete" }).click();
  await dialog(page).getByRole("button", { name: "Delete environment" }).click();
  await toast(page, "Environment deleted");
  await expect(page.getByRole("region", { name: /temp/ })).toHaveCount(0);
});

test("test accounts: add, edit without revealing the password, delete", async () => {
  const env = page.getByRole("region", { name: "Environment staging" });
  for (const [name, id] of [["merchantA", "a@shop.test"], ["merchantB", "b@shop.test"]]) {
    await env.getByRole("button", { name: "Add test account" }).click();
    const d = dialog(page);
    await d.getByLabel("Account name").fill(name);
    await d.getByLabel("Role in your app").fill("MERCHANT");
    await d.getByLabel("Login email or phone").fill(id);
    await d.getByLabel("Device").fill("merchant");
    await d.getByLabel("Password", { exact: true }).fill("s3cret-merchant-pw");
    await d.getByRole("button", { name: "Add account" }).click();
    await toast(page, `Account "${name}" added`);
  }
  await expect(env.getByRole("row", { name: /merchantA/ })).toContainText("Stored encrypted");
  await expect(page.locator("body")).not.toContainText("s3cret-merchant-pw");

  await env.getByRole("button", { name: "Edit merchantA" }).click();
  const d = dialog(page);
  await expect(d.getByLabel("Account name")).toBeDisabled();
  await expect(d.getByLabel("New password")).toHaveValue("");
  await d.getByLabel("Role in your app").fill("OWNER");
  await d.getByRole("button", { name: "Save account" }).click();
  await toast(page, "Account saved");
  await expect(env.getByRole("row", { name: /merchantA/ })).toContainText("OWNER");

  await env.getByRole("button", { name: "Delete merchantB" }).click();
  await dialog(page).getByRole("button", { name: "Delete account" }).click();
  await toast(page, "Account deleted");
  await expect(env.getByRole("row", { name: /merchantB/ })).toHaveCount(0);

  // Invalid account name is refused by the form
  await env.getByRole("button", { name: "Add test account" }).click();
  await dialog(page).getByLabel("Account name").fill("1bad name");
  await dialog(page).getByLabel("Role in your app").fill("X");
  await dialog(page).getByLabel("Login email or phone").fill("x");
  await dialog(page).getByLabel("Password", { exact: true }).fill("x");
  await dialog(page).getByRole("button", { name: "Add account" }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
});

// ── API keys and run upload ──────────────────────────────────────────────────

test("api keys: create shows the key once; it uploads runs", async ({ request }) => {
  await page.getByRole("link", { name: "API keys" }).click();
  await expect(page.getByRole("heading", { name: "No API keys" })).toBeVisible();
  await page.getByRole("button", { name: "New API key" }).click();
  await dialog(page).getByLabel("Key name").fill("GitHub Actions");
  await dialog(page).getByRole("button", { name: "Create key" }).click();
  await toast(page, 'API key "GitHub Actions" created');
  apiKey = (await dialog(page).getByLabel("API key").textContent())!.trim();
  expect(apiKey).toMatch(/^qak_/);
  await dialog(page).getByRole("button", { name: "Done" }).click();
  await expect(page.locator("body")).not.toContainText(apiKey);
  await expect(page.getByRole("row", { name: /GitHub Actions/ })).toContainText("Active");

  const r1 = await uploadRun(request, apiKey, sampleRun(envId, [{ fp: "fp-crit-1", severity: "critical" }, { fp: "fp-high-2" }, { fp: "fp-med-3", severity: "medium", plugin: "api-smoke" }]));
  expect(r1.status(), await r1.text()).toBe(201);
  const r2 = await uploadRun(request, apiKey, sampleRun(envId, [{ fp: "fp-crit-1", severity: "critical" }, { fp: "fp-med-3", severity: "medium", plugin: "api-smoke" }]));
  expect(r2.status()).toBe(201);
  expect((await r2.json()).fixedIssues).toBe(1);
  await page.reload();
  await expect(page.getByRole("row", { name: /GitHub Actions/ })).not.toContainText("Never");
});

test("runs: list, ribbon and run detail with findings and evidence", async () => {
  await page.getByRole("link", { name: "Runs" }).click();
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(page.locator(".ribbon.lg .bar:not(.ghost)")).toHaveCount(2);
  await expect(page.locator(".ribbon.lg")).toHaveAttribute("aria-label", "Last 2 runs: 0 passed, 2 did not pass");

  // Open the first (oldest) run from the ribbon
  await page.locator(".ribbon.lg a.bar").first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  const findings = page.getByRole("region", { name: "Findings" });
  await expect(findings.getByRole("heading", { name: /Findings/ })).toContainText("3");
  await expect(page.getByRole("region", { name: "Plugins" })).toContainText("api-auth");

  await findings.getByRole("button", { name: /critical 1/ }).click();
  await expect(findings.locator("tbody tr.clickable")).toHaveCount(1);
  await findings.getByRole("button", { name: "All" }).click();
  await expect(findings.locator("tbody tr.clickable")).toHaveCount(3);

  await findings.locator("tbody tr.clickable").first().click();
  await expect(findings.getByLabel("Reproduce with curl")).toContainText("curl -i");
  await expect(findings.getByLabel("Response")).toContainText('{"ok":true}');
});

test("issues: filter by status and severity", async () => {
  await page.getByRole("link", { name: /^Issues/ }).click();
  const seg = page.getByRole("group", { name: "Filter by status" });
  await expect(seg.getByRole("button", { name: /Open/ })).toContainText("2");
  await expect(seg.getByRole("button", { name: /Fixed/ })).toContainText("1");
  await expect(page.locator("table tbody tr")).toHaveCount(2);
  await page.getByLabel("Severity").selectOption("critical");
  await expect(page.locator("table tbody tr")).toHaveCount(1);
  await page.getByLabel("Severity").selectOption("");
  await seg.getByRole("button", { name: /Fixed/ }).click();
  await expect(page.locator("table tbody tr")).toHaveCount(1);
  await expect(page.locator("table tbody")).toContainText("fp-high-2");
  await seg.getByRole("button", { name: /All/ }).click();
  await expect(page.locator("table tbody tr")).toHaveCount(3);
  await seg.getByRole("button", { name: /Open/ }).click();
});

test("issues: assign, accept with a reason and date, reopen, ignore", async () => {
  await page.locator("table tbody tr").filter({ hasText: "fp-crit-1" }).getByRole("link").first().click();
  const panel = page.getByRole("complementary", { name: "Issue details" });
  await expect(panel).toContainText("fp-crit-1");
  await expect(panel).toContainText("2 times");
  await expect(panel.getByLabel("Reproduce with curl")).toBeVisible();

  await panel.getByLabel("Assignee").selectOption({ label: OWNER.name });
  await toast(page, "Issue assigned");
  await expect(panel).toContainText(`Assignee${OWNER.name}`);

  await panel.getByRole("button", { name: "Accept for now" }).click();
  await panel.getByLabel("Why is this accepted for now?").fill("Fix scheduled with the auth refactor");
  await panel.getByLabel("Accept until").fill("2099-01-31");
  await panel.getByRole("button", { name: "Accept issue" }).click();
  await toast(page, "Issue accepted");
  await expect(panel).toContainText("Accepted");
  await expect(panel.locator(".alert")).toContainText("Fix scheduled with the auth refactor");
  await expect(panel.locator(".alert")).toContainText("2099");
  await expect(page.getByRole("group", { name: "Filter by status" }).getByRole("button", { name: /Accepted/ })).toContainText("1");

  await panel.getByRole("button", { name: "Reopen" }).click();
  await toast(page, "Issue reopened");
  await expect(panel.locator(".btn-row").first()).toContainText("Open");

  await panel.getByRole("button", { name: "Ignore" }).click();
  await panel.getByRole("button", { name: "Ignore issue" }).click(); // empty reason → blocked
  await expect(panel.getByLabel("Why ignore this?")).toBeVisible();
  await panel.getByLabel("Why ignore this?").fill("False positive: public health route");
  await panel.getByRole("button", { name: "Ignore issue" }).click();
  await toast(page, "Issue ignored");
  await expect(panel).toContainText("Ignored");

  await panel.getByRole("button", { name: "Close issue details" }).click();
  await expect(panel).toHaveCount(0);
});

test("overview shows project health", async () => {
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByTestId("health-row")).toHaveCount(2);
  await expect(page.getByTestId("health-row").filter({ hasText: "Loyalty API" })).toBeVisible();
  await expect(page.getByTestId("overview-summary")).toBeVisible();
});

test("project settings: rename and change stack", async () => {
  await page.goto(`/o/${orgId}/projects/${projectId}/settings`);
  await expect(page.getByRole("button", { name: "Save project" })).toBeDisabled();
  await page.getByLabel("Project name").fill("Loyalty Backend");
  await page.getByLabel("Stack").selectOption("nestjs");
  await page.getByRole("button", { name: "Save project" }).click();
  await toast(page, "Project saved");
  await expect(page.getByRole("heading", { level: 1, name: "Loyalty Backend" })).toBeVisible();
});

// ── Members, invites, client scoping, roles ──────────────────────────────────

test("members: invite a developer limited to one client", async () => {
  await page.getByRole("link", { name: "Members" }).click();
  await expect(page.getByTestId("member-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Invite member" }).click();
  const d = dialog(page);
  await d.getByLabel("Email").fill(DEV.email);
  await d.getByLabel("Role").selectOption("developer");
  await d.getByLabel("Only some clients' projects").check();
  await expect(d.getByRole("button", { name: "Create invite" })).toBeDisabled();
  await d.getByLabel("Northwind").check();
  await d.getByRole("button", { name: "Create invite" }).click();
  await toast(page, `Invite created for ${DEV.email}`);
  devInviteLink = (await d.getByLabel("Invite link").textContent())!.trim();
  expect(devInviteLink).toContain("/invite?token=");
  await d.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("invite-row")).toContainText("Northwind");

  // A second invite, to revoke
  await page.getByRole("button", { name: "Invite member" }).click();
  await dialog(page).getByLabel("Email").fill("temp@acme.test");
  await dialog(page).getByRole("button", { name: "Create invite" }).click();
  await dialog(page).getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Revoke invite for temp@acme.test" }).click();
  await dialog(page).getByRole("button", { name: "Revoke invite" }).click();
  await toast(page, "Invite revoked");
  await expect(page.getByTestId("invite-row")).toHaveCount(1);

  // Inviting an existing member is refused
  await page.getByRole("button", { name: "Invite member" }).click();
  await dialog(page).getByLabel("Email").fill(OWNER.email);
  await dialog(page).getByRole("button", { name: "Create invite" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText(/already a member/i);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
});

test("invite: the wrong account can't accept; the invitee signs up and joins", async ({ browser }) => {
  const path = new URL(devInviteLink).pathname + new URL(devInviteLink).search;
  // Owner opening the link: wrong account
  await page.goto(path);
  await page.getByRole("button", { name: "Accept invite" }).click();
  await expect(page.getByRole("alert")).toContainText(`This invite is for ${DEV.email}`);

  const u = await newUser(browser);
  await u.p.goto(path);
  await expect(u.p).toHaveURL(/\/login\?next=/);
  await u.p.getByRole("link", { name: "Sign up" }).click();
  await expect(u.p.getByLabel("Organization name")).toHaveCount(0);
  await u.p.getByLabel("Your name").fill(DEV.name);
  await u.p.getByLabel("Work email").fill(DEV.email);
  await u.p.getByLabel("Password").fill(PASSWORD);
  await u.p.getByRole("button", { name: "Create account" }).click();
  await expect(u.p).toHaveURL(/\/invite\?token=/);
  await u.p.getByRole("button", { name: "Accept invite" }).click();
  await expect(u.p).toHaveURL(new RegExp(`/o/${orgId}$`));
  await expect(u.p.getByTestId("org-switcher")).toContainText("limited to some clients");

  // Only Northwind's project is visible; the other project 404s
  await u.p.getByRole("link", { name: "Projects" }).click();
  await expect(u.p.getByRole("link", { name: /Loyalty Backend/ })).toBeVisible();
  await expect(u.p.getByRole("link", { name: /Internal Tools/ })).toHaveCount(0);
  // Developer can triage and manage keys, but not delete the project or see the audit log
  await u.p.getByRole("link", { name: /Loyalty Backend/ }).click();
  await expect(u.p.getByRole("link", { name: "API keys" })).toBeVisible();
  await u.p.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Settings" }).click();
  await expect(u.p.getByRole("button", { name: "Delete project" })).toHaveCount(0);
  await expect(u.p.getByRole("link", { name: "Audit log" })).toHaveCount(0);
  // The invitee has no stray organization of their own
  await u.p.getByTestId("org-switcher").click();
  await expect(u.p.getByRole("menuitem")).toHaveCount(2); // Acme QA + "Create organization"
  await u.p.keyboard.press("Escape");
  // Reusing the link fails
  await u.p.goto(path);
  await u.p.getByRole("button", { name: "Accept invite" }).click();
  await expect(u.p.getByRole("alert")).toBeVisible();
  expect(u.errors).toEqual([]);
  await u.c.close();
});

test("members: change a member to viewer; viewers get a read-only dashboard", async ({ browser }) => {
  await page.goto(`/o/${orgId}/members`);
  await page.getByRole("button", { name: `Edit ${DEV.name}` }).click();
  await dialog(page).getByLabel("Role").selectOption("viewer");
  await dialog(page).getByLabel("All projects").check();
  await dialog(page).getByRole("button", { name: "Save member" }).click();
  await toast(page, "Member saved");
  const row = page.getByTestId("member-row").filter({ hasText: DEV.email });
  await expect(row).toContainText("Viewer");
  await expect(row).toContainText("All projects");

  const u = await newUser(browser);
  await u.p.goto("/login");
  await loginUi(u.p, DEV.email);
  await expect(u.p).toHaveURL(new RegExp(`/o/${orgId}$`));
  await u.p.getByRole("link", { name: "Projects" }).click();
  await expect(u.p.getByRole("link", { name: /Internal Tools/ })).toBeVisible();
  await expect(u.p.getByRole("button", { name: "New project" })).toHaveCount(0);
  await u.p.goto(`/o/${orgId}/projects/${projectId}/issues`);
  await u.p.getByRole("group", { name: "Filter by status" }).getByRole("button", { name: /All/ }).click();
  await u.p.locator("table tbody tr").first().getByRole("link").first().click();
  await expect(u.p.getByRole("complementary", { name: "Issue details" })).toBeVisible();
  await expect(u.p.getByRole("button", { name: "Accept for now" })).toHaveCount(0);
  await expect(u.p.getByRole("link", { name: "API keys" })).toHaveCount(0);
  await u.p.goto(`/o/${orgId}/projects/${projectId}/environments`);
  await expect(u.p.getByRole("button", { name: "New environment" })).toHaveCount(0);
  await expect(u.p.getByRole("button", { name: "Add test account" })).toHaveCount(0);
  await u.p.goto(`/o/${orgId}/clients`);
  await expect(u.p.getByRole("button", { name: "New client" })).toHaveCount(0);
  await u.p.goto(`/o/${orgId}/members`);
  await expect(u.p.getByRole("button", { name: "Invite member" })).toHaveCount(0);
  await u.p.goto(`/o/${orgId}/settings`);
  await expect(u.p.getByLabel("Organization name", { exact: true })).toBeDisabled();
  await expect(u.p.getByRole("button", { name: "Delete organization" })).toHaveCount(0);
  // The viewer leaves the organization
  await u.p.goto(`/o/${orgId}/members`);
  await u.p.getByRole("button", { name: "Leave" }).click();
  await dialog(u.p).getByRole("button", { name: "Leave organization" }).click();
  await expect(u.p.getByRole("heading", { name: "You're not in any organization yet" })).toBeVisible();
  expect(u.errors).toEqual([]);
  await u.c.close();

  await page.reload();
  await expect(page.getByTestId("member-row")).toHaveCount(1);
});

test("api keys: a revoked key can't upload", async ({ request }) => {
  await page.goto(`/o/${orgId}/projects/${projectId}/api-keys`);
  await page.getByRole("button", { name: "Revoke GitHub Actions" }).click();
  await dialog(page).getByRole("button", { name: "Revoke key" }).click();
  await toast(page, "API key revoked");
  await expect(page.getByRole("row", { name: /GitHub Actions/ })).toContainText("Revoked");
  const r = await uploadRun(request, apiKey, sampleRun(envId, []));
  expect(r.status()).toBe(401);
});

test("audit log records what happened, with a filter", async () => {
  await page.getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByTestId("audit-row").first()).toBeVisible();
  const text = await page.locator("table").innerText();
  for (const what of ["created a client", "created a project", "verified a domain", "added a test account", "created an API key", "uploaded a run", "triaged an issue", "invited a member", "accepted an invite", "changed a member's access", "left the organization", "revoked an API key"]) {
    expect(text, `audit log should contain "${what}"`).toContain(what);
  }
  expect(text).not.toContain("s3cret-merchant-pw");
  await page.getByLabel("Filter events").fill("domain");
  await expect(page.getByTestId("audit-row")).toHaveCount(1);
});

test("not found pages for unknown routes, projects and organizations", async () => {
  await page.goto(`/o/${orgId}/projects/00000000-0000-4000-8000-000000000000`);
  await expect(page.getByRole("heading", { name: /not found|doesn't exist|can't find/i })).toBeVisible();
  await page.goto(`/o/${orgId}/no-such-page`);
  await expect(page.getByRole("heading", { name: /not found|doesn't exist|can't find/i })).toBeVisible();
  await page.goto(`/o/00000000-0000-4000-8000-000000000000`);
  await expect(page.getByRole("heading", { name: /not found|doesn't exist|can't find/i })).toBeVisible();
});

test("project settings: delete a project", async () => {
  await page.goto(`/o/${orgId}/projects`);
  await page.getByRole("link", { name: /Internal Tools/ }).click();
  await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Delete project" }).click();
  await dialog(page).getByRole("button", { name: "Delete project" }).click();
  await toast(page, "Project deleted");
  await expect(page).toHaveURL(new RegExp(`/o/${orgId}/projects$`));
  await expect(page.getByRole("link", { name: /Internal Tools/ })).toHaveCount(0);
});

// ── Organizations ────────────────────────────────────────────────────────────

test("organizations: rename, create another, switch, delete with name check", async () => {
  await page.goto(`/o/${orgId}/settings`);
  await page.getByLabel("Organization name", { exact: true }).fill("Acme Quality");
  await page.getByRole("button", { name: "Save name" }).click();
  await toast(page, "Organization renamed");
  await expect(page.getByTestId("org-switcher")).toContainText("Acme Quality");

  await page.getByTestId("org-switcher").click();
  await page.getByRole("menuitem", { name: "Create organization" }).click();
  await expect(page.getByLabel("New organization name")).toBeFocused();
  await page.getByLabel("New organization name").fill("Side Project Co");
  await page.getByRole("button", { name: "Create organization" }).click();
  await toast(page, 'Organization "Side Project Co" created');
  await expect(page.getByTestId("org-switcher")).toContainText("Side Project Co");
  const secondOrg = orgIdFromUrl(page);
  expect(secondOrg).not.toBe(orgId);

  await page.getByTestId("org-switcher").click();
  await page.getByRole("menuitem", { name: "Acme Quality" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${orgId}$`));
  await expect(page.getByTestId("health-row")).toHaveCount(1);

  await page.goto(`/o/${secondOrg}/settings`);
  await page.getByRole("button", { name: "Delete organization" }).click();
  await dialog(page).getByLabel("Organization name").fill("wrong name");
  await dialog(page).getByRole("button", { name: "Delete organization" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("doesn't match");
  await dialog(page).getByLabel("Organization name").fill("Side Project Co");
  await dialog(page).getByRole("button", { name: "Delete organization" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${orgId}$`));
  await page.getByTestId("org-switcher").click();
  await expect(page.getByRole("menuitem", { name: "Side Project Co" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("keyboard: modals trap Escape and return focus", async () => {
  await page.goto(`/o/${orgId}/clients`);
  const btn = page.getByRole("button", { name: "New client" });
  await btn.click();
  await expect(dialog(page).getByLabel("Client name")).toBeFocused();
  await page.keyboard.type("Typed while open");
  await expect(dialog(page).getByLabel("Client name")).toHaveValue("Typed while open");
  await page.keyboard.press("Escape");
  await expect(btn).toBeFocused();
});
