import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Secret, TOTP } from "otpauth";
import { API, PASSWORD, watchErrors } from "./helpers";

const screenshotDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../qa-out/saas-screens");

test("MFA sign-in, billing disabled state, and revoke all sessions work in the dashboard", async ({ browser, request }) => {
  const email = `security-${Date.now()}@acme.test`;
  const signup = await request.post(`${API}/auth/signup`, { data: { name: "Security Tester", email, password: PASSWORD, orgName: "Security Org" } });
  expect(signup.status()).toBe(201);
  const created = await signup.json();
  const auth = { authorization: `Bearer ${created.tokens.accessToken}` };
  const setupResponse = await request.post(`${API}/auth/mfa/setup`, { headers: auth, data: { password: PASSWORD } });
  expect(setupResponse.status()).toBe(200);
  const { secret } = await setupResponse.json();
  const authenticator = new TOTP({ secret: Secret.fromBase32(secret) });
  const enabledResponse = await request.post(`${API}/auth/mfa/enable`, { headers: auth, data: { password: PASSWORD, code: authenticator.generate() } });
  expect(enabledResponse.status()).toBe(200);
  const enabled = await enabledResponse.json();

  const loginPage = await browser.newPage();
  const errors = watchErrors(loginPage);
  await loginPage.goto("/login");
  await loginPage.getByLabel("Email").fill(email);
  await loginPage.getByLabel("Password").fill(PASSWORD);
  await loginPage.getByRole("button", { name: "Log in" }).click();
  await expect(loginPage.getByLabel("Authentication code")).toBeVisible();
  await loginPage.getByLabel("Authentication code").fill(enabled.recoveryCodes[0]);
  await loginPage.getByRole("button", { name: "Log in" }).click();
  await expect(loginPage).toHaveURL(/\/o\//);

  await loginPage.goto(`/o/${created.org.id}/settings`);
  await expect(loginPage.getByRole("heading", { name: "Plan and usage" })).toBeVisible();
  await expect(loginPage.getByText("Payments are not enabled.")).toBeVisible();
  await expect(loginPage.getByRole("button", { name: "Manage subscription" })).toHaveCount(0);
  mkdirSync(screenshotDir, { recursive: true });
  await loginPage.screenshot({ path: resolve(screenshotDir, "billing-disabled.png"), fullPage: true });

  await loginPage.goto(`/o/${created.org.id}/account`);
  await expect(loginPage.getByRole("heading", { name: "Sign out everywhere" })).toBeVisible();
  await loginPage.screenshot({ path: resolve(screenshotDir, "account-revoke-sessions.png"), fullPage: true });
  await loginPage.getByLabel("Password", { exact: true }).last().fill(PASSWORD);
  // Enrollment already consumed that time-step's TOTP; use another unused factor.
  await loginPage.getByLabel("Authenticator or recovery code").last().fill(enabled.recoveryCodes[1]);
  await loginPage.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(loginPage).toHaveURL(/\/login$/);
  await expect(loginPage.getByLabel("Email")).toBeVisible();
  expect(errors).toEqual([]);
  await loginPage.context().close();
});
