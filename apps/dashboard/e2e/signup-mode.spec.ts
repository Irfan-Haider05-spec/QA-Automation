/**
 * Invite-only platforms (SIGNUP_MODE=invite): the screens people see. The API
 * rules themselves are covered by apps/api/test/signup-mode.test.ts; here the
 * API's answer to /auth/options is replaced so the open-mode test API can stay.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { API, PASSWORD } from "./helpers";

const inviteOnly = (page: Page) =>
  page.route("**/api/v1/auth/options", (r) => r.fulfill({ json: { signupOpen: false } }));

test("invite-only: login hides sign-up and says how to get in", async ({ page }) => {
  await inviteOnly(page);
  await page.goto("/login");
  await expect(page.getByText("New here? Ask an admin of your team for an invite link.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign up" })).toHaveCount(0);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(r.violations.map((v) => v.id)).toEqual([]);
});

test("invite-only: the sign-up page explains instead of showing a form", async ({ page }) => {
  await inviteOnly(page);
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Accounts are by invitation" })).toBeVisible();
  await expect(page.getByLabel("Work email")).toHaveCount(0);
  await page.getByRole("link", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("invite-only: an invite link still leads to sign-up and joins the team", async ({ page, request }) => {
  // an organization that invites someone (set up through the API)
  const owner = await (await request.post(`${API}/auth/signup`, { data: { name: "Owner", email: `inv-owner-${Date.now()}@acme.test`, password: PASSWORD, orgName: "Invite Only Co" } })).json();
  const email = `invitee-${Date.now()}@acme.test`;
  const inv = await (await request.post(`${API}/orgs/${owner.org.id}/invites`, { headers: { authorization: `Bearer ${owner.tokens.accessToken}` }, data: { email, role: "developer" } })).json();

  await inviteOnly(page);
  let sent: any = null;
  page.on("request", (req) => { if (req.url().endsWith("/auth/signup")) sent = req.postDataJSON(); });
  await page.goto(`/invite?token=${encodeURIComponent(inv.token)}`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole("link", { name: "Sign up" })).toBeVisible();
  await page.getByRole("link", { name: "Sign up" }).click();
  await page.getByLabel("Your name").fill("Invitee");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await expect(page.getByLabel("Organization name")).toHaveCount(0);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: /Join|Accept/ }).click();
  await expect(page.getByText("Invite Only Co").first()).toBeVisible();
  expect(sent?.inviteToken).toBe(inv.token);
  expect(sent?.createOrg).toBe(false);
});
