/**
 * Accessibility (WCAG 2 A/AA, axe-core) of states the crawler can't reach:
 * auth screens, every dialog, the issue panel, and dark mode.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { API, PASSWORD, sampleRun, uploadRun } from "./helpers";

async function axe(page: Page, what: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const problems = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect.soft(problems, `accessibility problems on ${what}`).toEqual([]);
}

test("auth screens", async ({ page }) => {
  for (const p of ["/login", "/signup"]) {
    await page.goto(p);
    await axe(page, p);
  }
  await page.goto("/login");
  await page.getByLabel("Email").fill("nobody@acme.test");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await axe(page, "login error");
});

test("dialogs, issue panel and dark mode", async ({ page, request }) => {
  test.setTimeout(120_000);
  const email = `a11y-${Date.now()}@acme.test`;
  const su = await (await request.post(`${API}/auth/signup`, { data: { name: "Ally", email, password: PASSWORD, orgName: "A11y Org" } })).json();
  const auth = { authorization: `Bearer ${su.tokens.accessToken}` };
  const o = su.org.id;
  await request.post(`${API}/orgs/${o}/clients`, { headers: auth, data: { name: "Contoso" } });
  const p = (await (await request.post(`${API}/orgs/${o}/projects`, { headers: auth, data: { name: "Shop API" } })).json()).project;
  const e = (await (await request.post(`${API}/orgs/${o}/projects/${p.id}/environments`, { headers: auth, data: { name: "staging", apiBaseUrl: "https://staging.acme.test" } })).json()).environment;
  await request.post(`${API}/orgs/${o}/projects/${p.id}/environments/${e.id}/credentials`, { headers: auth, data: { name: "merchantA", role: "MERCHANT", identifier: "a@x.test", secret: "x" } });
  const key = (await (await request.post(`${API}/orgs/${o}/projects/${p.id}/api-keys`, { headers: auth, data: { name: "CI" } })).json()).key;
  await uploadRun(request, key, sampleRun(e.id, [{ fp: "a11y-crit", severity: "critical" }, { fp: "a11y-high" }, { fp: "a11y-med1", severity: "medium" }, { fp: "a11y-low1", severity: "low" }]));

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${o}`));
  const base = `/o/${o}`;

  const dialogs: Array<[string, string, string]> = [
    [`${base}/clients`, "New client", "new client dialog"],
    [`${base}/projects`, "New project", "new project dialog"],
    [`${base}/projects/${p.id}/environments`, "New environment", "new environment dialog"],
    [`${base}/projects/${p.id}/environments`, "Verify domain", "verification instructions"],
    [`${base}/projects/${p.id}/environments`, "Add test account", "test account dialog"],
    [`${base}/projects/${p.id}/api-keys`, "New API key", "API key dialog"],
    [`${base}/members`, "Invite member", "invite dialog"],
    [`${base}/projects/${p.id}/api-keys`, "Revoke CI", "confirm dialog"],
  ];
  for (const [url, button, what] of dialogs) {
    await page.goto(url);
    await page.getByRole("button", { name: button }).click();
    await page.waitForTimeout(200);
    await axe(page, what);
  }

  await page.goto(`${base}/projects/${p.id}/runs`);
  await page.locator("table tbody tr").first().getByRole("link").first().click();
  await page.locator("tbody tr.clickable").first().click();
  await axe(page, "run detail with an open finding");

  await page.goto(`${base}/projects/${p.id}/issues`);
  await page.locator("table tbody tr").first().getByRole("link").first().click();
  await expect(page.getByRole("complementary", { name: "Issue details" })).toBeVisible();
  await page.getByRole("button", { name: "Accept for now" }).click();
  await axe(page, "issue panel with the accept form");

  await page.emulateMedia({ colorScheme: "dark" });
  for (const [url, what] of [[base, "overview (dark)"], [`${base}/projects/${p.id}/issues`, "issues (dark)"], [`${base}/projects/${p.id}/environments`, "environments (dark)"], [`${base}/members`, "members (dark)"]]) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    await axe(page, what);
  }
});
