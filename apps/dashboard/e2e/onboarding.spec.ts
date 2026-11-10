/** The getting-started checklist on the overview */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { API, PASSWORD, signupUi } from "./helpers";

test("checklist: progress follows setup, links to the next step, can be hidden", async ({ page, request }) => {
  const email = `onb-${Date.now()}@acme.test`;
  await signupUi(page, "Onboarding Owner", email, "Onboard Co");
  const list = page.getByRole("region", { name: "Getting started" });
  await expect(list).toContainText("0 of 8 done");
  await expect(list.getByRole("link", { name: "Create a project" })).toBeVisible();
  const axe = await new AxeBuilder({ page }).include(".onboarding").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);

  // set up a project and environment through the API, then come back
  const login = await (await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } })).json();
  const auth = { authorization: `Bearer ${login.tokens.accessToken}` };
  const orgId = new URL(page.url()).pathname.split("/")[2];
  const p = (await (await request.post(`${API}/orgs/${orgId}/projects`, { headers: auth, data: { name: "Shop API" } })).json()).project;
  await request.post(`${API}/orgs/${orgId}/projects/${p.id}/environments`, { headers: auth, data: { name: "staging", apiBaseUrl: "http://127.0.0.1:4199/api" } });
  await page.reload();
  await expect(list).toContainText("2 of 8 done");
  await expect(list.getByText("Create a project (done)")).toHaveCount(1); // read out with its state
  await expect(list.locator("li.done")).toHaveCount(2);
  const next = list.getByRole("link", { name: "Verify the staging domain" });
  await expect(next).toHaveAttribute("href", `/o/${orgId}/projects/${p.id}/environments`);
  await next.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.id}/environments$`));

  await page.goBack();
  await list.getByRole("button", { name: "Hide checklist" }).click();
  await expect(list).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Onboard Co" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Getting started" })).toHaveCount(0);
});
