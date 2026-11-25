/** The welcome hero, the integration guide page, and the product tour */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signupUi } from "./helpers";

test("empty overview shows a welcome hero, distinct from Projects", async ({ page }) => {
  await signupUi(page, "Hero Owner", `hero-${Date.now()}@acme.test`, "Hero Co");
  // Overview: the welcome hero, not the bare "No projects yet" of the Projects list.
  const hero = page.getByRole("region", { name: "Welcome to VeriQ" });
  await expect(hero).toBeVisible();
  await expect(hero.getByRole("link", { name: "Create your first project" })).toBeVisible();
  await expect(hero.getByRole("link", { name: "Integration guide" })).toBeVisible();

  // Projects page is the plain list, with its own empty copy.
  await page.getByRole("navigation").getByRole("link", { name: "Projects" }).click();
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await expect(page.getByText("No projects yet")).toBeVisible();
  await expect(page.getByRole("region", { name: "Welcome to VeriQ" })).toHaveCount(0);
});

test("integration guide opens from the sidebar and is accessible", async ({ page }) => {
  await signupUi(page, "Guide Owner", `guide-${Date.now()}@acme.test`, "Guide Co");
  await page.locator(".rail-help").getByRole("link", { name: "Integration guide" }).click();
  await expect(page).toHaveURL(/\/guide$/);
  await expect(page.getByRole("heading", { name: "Integration guide", level: 1 })).toBeVisible();
  await expect(page.getByText("qa init", { exact: false }).first()).toBeVisible();
  const axe = await new AxeBuilder({ page }).include(".guide").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
});

test("the tour steps through the tabs and closes", async ({ page }) => {
  await signupUi(page, "Tour Owner", `tour-${Date.now()}@acme.test`, "Tour Co");
  await page.locator(".rail-tour").click();
  const dlg = page.getByRole("dialog", { name: /Welcome to VeriQ|Overview|Projects/ });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("Welcome to VeriQ");
  await expect(dlg).toContainText("1 / 9");

  await dlg.getByRole("button", { name: "Next" }).click();
  await expect(dlg).toContainText("Overview");
  await expect(dlg).toContainText("2 / 9");

  await dlg.getByRole("button", { name: "Back" }).click();
  await expect(dlg).toContainText("1 / 9");

  await dlg.getByRole("button", { name: "Close tour" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
