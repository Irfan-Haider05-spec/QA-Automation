/**
 * Account emails: confirm the address (banner, resend, link), and reset a
 * forgotten password through the email link.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { SMTPServer } from "smtp-server";
import { PASSWORD, signupUi, watchErrors } from "./helpers";

test.describe.configure({ mode: "serial" });

const SMTP_PORT = 4125; // the test API's SMTP_URL
const mails: Array<{ to: string[]; data: string }> = [];
let smtp: SMTPServer;
let page: Page;
const email = `acct-${Date.now()}@acme.test`;

const linkIn = async (path: "verify-email" | "reset-password", from: number) => {
  for (let i = 0; i < 60; i++) {
    const m = mails.slice(from).find((x) => x.to.includes(email) && x.data.includes(`/${path}?token=`));
    if (m) {
      const flat = m.data.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
      return new URL(flat.match(new RegExp(`https?://[^\\s"<>]+/${path}\\?token=[A-Za-z0-9_%-]+`))![0]);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${path} email`);
};
async function axe(what: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect.soft(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`), `accessibility on ${what}`).toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  smtp = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], onData(s, session, cb) { let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => { mails.push({ to: session.envelope.rcptTo.map((r) => r.address), data: d }); cb(); }); } });
  await new Promise<void>((r) => smtp.listen(SMTP_PORT, "127.0.0.1", () => r()));
  page = await (await browser.newContext()).newPage();
  watchErrors(page);
});
test.afterAll(async () => {
  await page?.context().close();
  await new Promise<void>((r) => smtp.close(() => r()));
});

test("after sign-up a banner asks to confirm the email; resend works", async () => {
  await signupUi(page, "Account Tester", email, "Acct Co");
  const banner = page.getByRole("status").filter({ hasText: "Confirm" });
  await expect(banner).toContainText(email);
  await axe("dashboard with the confirmation banner");
  const before = mails.length;
  await banner.getByRole("button", { name: "Send the link again" }).click();
  await expect(banner).toContainText("New link sent.");
  await linkIn("verify-email", before);
});

test("the emailed link confirms the address and the banner goes away", async () => {
  const link = await linkIn("verify-email", 0);
  await page.goto(link.pathname + link.search);
  await expect(page.getByRole("status").filter({ hasText: "is confirmed" })).toContainText(`${email} is confirmed`);
  await axe("email confirmed");
  await page.getByRole("link", { name: "Go to the dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await expect(page.getByText("Send the link again")).toHaveCount(0);
  // the link works once
  await page.goto(link.pathname + link.search);
  await expect(page.getByRole("alert")).toContainText("not valid or has expired");
});

test("forgot password: request a link, choose a new password, log in with it", async () => {
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await axe("forgot password");
  const before = mails.length;
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "If an account exists" })).toContainText(`If an account exists for ${email}`);

  const link = await linkIn("reset-password", before);
  await page.goto(link.pathname + link.search);
  await axe("choose a new password");
  await page.getByLabel("New password", { exact: true }).fill("a-fresh-password-99");
  await page.getByLabel("Repeat the new password").fill("a-fresh-password-98");
  await expect(page.getByText("The passwords don't match")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change password" })).toBeDisabled();
  await page.getByLabel("Repeat the new password").fill("a-fresh-password-99");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Password changed" })).toBeVisible();

  await page.getByRole("link", { name: "Log in" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toContainText("incorrect");
  await page.getByLabel("Password", { exact: true }).fill("a-fresh-password-99");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/o\//);
});

test("an old or broken reset link explains what to do", async () => {
  await page.goto("/reset-password");
  await expect(page.getByRole("alert")).toContainText("has no reset token");
  await page.goto("/reset-password?token=not-a-real-token-0123456789");
  await page.getByLabel("New password", { exact: true }).fill("whatever-password-1");
  await page.getByLabel("Repeat the new password").fill("whatever-password-1");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("alert")).toContainText("not valid or has expired");
  await expect(page.getByRole("link", { name: "Ask for a new link" })).toBeVisible();
});

test("account page: rename, change password (this device stays signed in), and the menu entry", async () => {
  await page.goto("/");
  await page.getByRole("button", { name: /Account Tester/ }).click();
  await page.getByRole("menuitem", { name: "Your account" }).click();
  await expect(page.getByRole("heading", { name: "Your account", exact: true })).toBeVisible();
  await axe("account page");
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await expect(page.getByText("Confirmed")).toBeVisible();

  await page.getByLabel("Your name").fill("Account Renamed");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("button", { name: /Account Renamed/ })).toBeVisible();

  await page.getByLabel("Current password").fill("wrong-current-pass");
  await page.getByLabel("New password", { exact: true }).fill("third-password-777");
  await page.getByLabel("Repeat the new password").fill("third-password-777");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("alert")).toContainText("current password isn't right");
  await page.getByLabel("Current password").fill("a-fresh-password-99");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.locator(".toasts .toast").filter({ hasText: "Password changed" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your account", exact: true })).toBeVisible(); // still signed in with the new tokens
});

test("delete account: the only owner is told to hand over first", async () => {
  await page.getByRole("button", { name: "Delete my account" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Your password").fill("third-password-777");
  await d.getByRole("button", { name: "Delete my account" }).click();
  await expect(d.getByRole("alert")).toContainText("only owner of Acct Co");
  await d.getByRole("button", { name: "Keep my account" }).click();
  await expect(d).toHaveCount(0);
});

test("terms and privacy pages are linked from sign-up and readable", async () => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "Privacy notice" })).toBeVisible();
  await axe("privacy");
  await page.getByRole("navigation", { name: "Legal" }).getByRole("link", { name: "Terms" }).click();
  await expect(page.getByRole("heading", { name: "Terms of use" })).toBeVisible();
  await axe("terms");
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await page.goto("/signup");
  await expect(page.getByRole("link", { name: "terms of use" })).toHaveAttribute("href", "/terms");
  await expect(page.getByRole("link", { name: "privacy notice" })).toHaveAttribute("href", "/privacy");
});
