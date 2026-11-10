/**
 * Notifications and client reports in the dashboard: channels (Slack, signed
 * webhook, email) with real delivery to local receivers, test messages,
 * failures shown; reports with chart, CSV, print, and share links opened
 * without an account.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import crypto from "node:crypto";
import http from "node:http";
import { SMTPServer } from "smtp-server";
import { API, PASSWORD, dialog, sampleRun, toast, uploadRun, watchErrors } from "./helpers";

test.describe.configure({ mode: "serial" });

const RECV_PORT = 4126;
const SMTP_PORT = 4125;
const hits: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
const mails: Array<{ to: string[]; data: string }> = [];
let receiver: http.Server;
let smtp: SMTPServer;
let owner: { token: string; orgId: string; email: string };
let clientId = "";
let pShop = "";
let keyShop = "";
let page: Page;
let errors: string[];
let signingSecret = "";
let shareUrl = "";

const axe = async (p: Page) => (await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);

test.beforeAll(async ({ browser, request }) => {
  receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { hits.push({ path: req.url!, headers: req.headers, body }); res.writeHead(req.url === "/down" ? 503 : 200); res.end(req.url === "/down" ? "maintenance" : "ok"); });
  });
  await new Promise<void>((r) => receiver.listen(RECV_PORT, "127.0.0.1", () => r()));
  smtp = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], onData(s, session, cb) { let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => { mails.push({ to: session.envelope.rcptTo.map((r) => r.address), data: d }); cb(); }); } });
  await new Promise<void>((r) => smtp.listen(SMTP_PORT, "127.0.0.1", () => r()));

  const email = `nr-${Date.now()}@acme.test`;
  const s = await (await request.post(`${API}/auth/signup`, { data: { name: "Nadia", email, password: PASSWORD, orgName: "Northwind Digital" } })).json();
  owner = { token: s.tokens.accessToken, orgId: s.org.id, email };
  const auth = { authorization: `Bearer ${owner.token}` };
  clientId = (await (await request.post(`${API}/orgs/${owner.orgId}/clients`, { headers: auth, data: { name: "Contoso" } })).json()).client.id;
  pShop = (await (await request.post(`${API}/orgs/${owner.orgId}/projects`, { headers: auth, data: { name: "Contoso Shop", clientId } })).json()).project.id;
  await request.post(`${API}/orgs/${owner.orgId}/projects`, { headers: auth, data: { name: "Internal wiki" } });
  keyShop = (await (await request.post(`${API}/orgs/${owner.orgId}/projects/${pShop}/api-keys`, { headers: auth, data: { name: "ci" } })).json()).key;

  page = await (await browser.newContext()).newPage();
  errors = watchErrors(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/o\//);
});
test.afterAll(async () => {
  receiver?.close();
  await new Promise<void>((r) => smtp ? smtp.close(() => r()) : r());
  await page?.context().close();
});
test.afterEach(() => { expect(errors.splice(0)).toEqual([]); });

const notifications = () => page.goto(`/o/${owner.orgId}/notifications`);
const channel = (name: string) => page.getByRole("region", { name: `Channel ${name}` });

test("Slack channel: create, send a test message", async () => {
  await notifications();
  await expect(page.getByRole("heading", { name: "No channels" })).toBeVisible();
  await page.getByRole("button", { name: "New channel" }).click();
  const d = dialog(page);
  await d.getByLabel("Name").fill("#qa-alerts");
  await d.getByLabel("Slack incoming-webhook URL").fill(`http://127.0.0.1:${RECV_PORT}/slack/T01/B02/xyz789`);
  await expect(d.getByLabel(/Quality gate failed/)).toBeChecked();
  await d.getByRole("button", { name: "Create channel" }).click();
  await toast(page, 'Channel "#qa-alerts" created');
  const c = channel("#qa-alerts");
  await expect(c).toContainText("Slack");
  await expect(c).toContainText("127.0.0.1:4126/…z789");
  await expect(c).toContainText("Quality gate failed · Passing again · Fixed issue came back");
  await expect(c).toContainText("All projects");
  await expect(page.locator("body")).not.toContainText("/slack/T01/B02/xyz789");

  const n = hits.length;
  await c.getByRole("button", { name: "Send test" }).click();
  await toast(page, "Test message sent to #qa-alerts");
  expect(JSON.parse(hits[n].body).text).toMatch(/^\[Test\] QA gate failed: Sample project/);
});

test("webhook channel for one project: signing secret shown once", async () => {
  await page.getByRole("button", { name: "New channel" }).click();
  const d = dialog(page);
  await d.getByRole("button", { name: "Webhook" }).click();
  await d.getByLabel("Name").fill("Ops pager");
  await d.getByLabel("Webhook URL").fill(`http://127.0.0.1:${RECV_PORT}/hook`);
  await d.getByLabel(/Passing again/).uncheck();
  await d.getByLabel("Only some projects").check();
  await expect(d.getByRole("button", { name: "Create channel" })).toBeDisabled();
  await d.getByLabel("Contoso Shop").check();
  await d.getByRole("button", { name: "Create channel" }).click();
  await toast(page, 'Channel "Ops pager" created');
  signingSecret = (await d.getByLabel("Signing secret").textContent())!.trim();
  expect(signingSecret).toMatch(/^whsec_/);
  await d.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("body")).not.toContainText(signingSecret);
  await expect(channel("Ops pager")).toContainText("Contoso Shop");
});

test("email channel", async () => {
  await page.getByRole("button", { name: "New channel" }).click();
  const d = dialog(page);
  await d.getByRole("button", { name: "Email" }).click();
  await d.getByLabel("Name").fill("Client PM");
  await d.getByLabel("Email addresses").fill("pm@contoso.test, cto@contoso.test");
  await d.getByLabel(/Fixed issue came back/).uncheck();
  await d.getByLabel(/Passing again/).uncheck();
  await d.getByRole("button", { name: "Create channel" }).click();
  await toast(page, 'Channel "Client PM" created');
  await expect(channel("Client PM")).toContainText("pm@contoso.test, cto@contoso.test");
});

test("a failed run reaches Slack, the webhook (signed) and email; the history shows it", async ({ request }) => {
  const n = hits.length;
  const m = mails.length;
  expect((await uploadRun(request, keyShop, sampleRun(undefined, [{ fp: "nr-crit-1", severity: "critical" }, { fp: "nr-high-1" }]))).status()).toBe(201);
  await expect.poll(() => hits.length - n, { timeout: 10_000 }).toBe(2);
  await expect.poll(() => mails.length - m, { timeout: 10_000 }).toBe(1);
  const slack = JSON.parse(hits.slice(n).find((h) => h.path.startsWith("/slack"))!.body);
  expect(slack.text).toContain("QA gate failed: Contoso Shop");
  const runUrl = slack.blocks.at(-1).elements[0].url as string;
  expect(runUrl).toMatch(new RegExp(`/o/${owner.orgId}/projects/${pShop}/runs/`));
  const hook = hits.slice(n).find((h) => h.path === "/hook")!;
  expect(hook.headers["x-qa-signature"]).toBe(`sha256=${crypto.createHmac("sha256", signingSecret).update(`${hook.headers["x-qa-timestamp"]}.${hook.body}`).digest("hex")}`);
  expect(mails.at(-1)!.to.sort()).toEqual(["cto@contoso.test", "pm@contoso.test"]);
  expect(mails.at(-1)!.data).toContain("Subject: QA gate failed: Contoso Shop");

  // The link in the message opens the run
  await page.goto(new URL(runUrl).pathname);
  await expect(page.getByRole("region", { name: "Findings" })).toContainText("2");

  await notifications();
  await channel("#qa-alerts").getByRole("button", { name: "Show recent messages" }).click();
  const rows = channel("#qa-alerts").getByTestId("delivery-row");
  await expect(rows.first()).toContainText("Quality gate failed · Contoso Shop");
  await expect(rows.first()).toContainText("Delivered");
});

test("a broken endpoint: the test fails with the reason, retries are visible", async ({ request }) => {
  await page.getByRole("button", { name: "New channel" }).click();
  const d = dialog(page);
  await d.getByRole("button", { name: "Webhook" }).click();
  await d.getByLabel("Name").fill("Broken receiver");
  await d.getByLabel("Webhook URL").fill(`http://127.0.0.1:${RECV_PORT}/down`);
  await d.getByRole("button", { name: "Create channel" }).click();
  await d.getByRole("button", { name: "Done" }).click();
  const c = channel("Broken receiver");
  await c.getByRole("button", { name: "Send test" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The test message wasn't delivered: Answered 503: maintenance" }).first()).toBeVisible();
  await expect(c.getByRole("alert")).toContainText("Last delivery failed: Answered 503");

  await uploadRun(request, keyShop, sampleRun(undefined, [{ fp: "nr-high-2" }]));
  await c.getByRole("button", { name: "Show recent messages" }).click();
  await expect(c.getByTestId("delivery-row").first()).toContainText("Waiting to retry", { timeout: 10_000 });
  await expect(c.getByTestId("delivery-row").first()).toContainText("Answered 503");
});

test("edit keeps the hidden URL; turn off, turn on, delete", async () => {
  await notifications();
  const c = channel("#qa-alerts");
  await c.getByRole("button", { name: "Edit" }).click();
  const d = dialog(page);
  await expect(d.getByText("Current: 127.0.0.1:4126/…z789. Leave empty to keep it.")).toBeVisible();
  await d.getByLabel("Name").fill("#qa-alerts-v2");
  await d.getByLabel(/Environment unreachable/).check();
  await d.getByRole("button", { name: "Save channel" }).click();
  await toast(page, "Channel saved");
  const c2 = channel("#qa-alerts-v2");
  await expect(c2).toContainText("127.0.0.1:4126/…z789");
  await expect(c2).toContainText("Environment unreachable");
  await c2.getByRole("button", { name: "Turn off" }).click();
  await toast(page, "#qa-alerts-v2 turned off");
  await expect(c2.locator("h2")).toContainText("Off");
  await c2.getByRole("button", { name: "Turn on" }).click();
  await toast(page, "#qa-alerts-v2 turned on");
  await channel("Broken receiver").getByRole("button", { name: "Delete" }).click();
  await dialog(page).getByRole("button", { name: "Delete channel" }).click();
  await toast(page, "Channel deleted");
  await expect(channel("Broken receiver")).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
});

test("reports: client report with chart, table view, CSV and print", async ({ request }) => {
  // A passing full run fixes the critical/high issues
  await uploadRun(request, keyShop, sampleRun(undefined, []));
  await page.goto(`/o/${owner.orgId}/reports`);
  await expect(page.getByLabel("Report for", { exact: true })).toHaveValue(`client:${clientId}`);
  await page.getByLabel("Period", { exact: true }).selectOption("7");
  const report = page.getByRole("article", { name: "Quality report for Contoso" });
  await expect(report.getByRole("heading", { level: 1 })).toHaveText("Contoso: quality report");
  await expect(report.getByTestId("pass-rate")).toHaveText("33%");
  await expect(report).toContainText("of 3 test runs passed the quality gate");
  await expect(report.getByRole("img", { name: /Runs per day/ })).toBeVisible();
  await report.getByText("Show as a table").click();
  await expect(report.locator("details table tbody tr")).toHaveCount(1);
  await expect(report.getByRole("heading", { name: "Fixed in this period" })).toBeVisible();
  await expect(report).not.toContainText("curl");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Issues as CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^Contoso-issues-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = Buffer.concat(await (await download.createReadStream()).toArray()).toString("utf8");
  expect(csv.split("\r\n")[0]).toBe("Status,Severity,Project,Issue,Where,Since or fixed,Note");
  expect(csv).toContain("Fixed,critical,Contoso Shop");

  await page.evaluate(() => { (window as any).__printed = 0; window.print = () => { (window as any).__printed++; }; });
  await page.getByRole("button", { name: "Download PDF" }).click();
  expect(await page.evaluate(() => (window as any).__printed)).toBe(1);
  // Print layout: only the report
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".rail")).toBeHidden();
  await expect(page.getByRole("button", { name: "Share link" })).toBeHidden();
  await expect(report).toBeVisible();
  await page.emulateMedia({ media: "screen" });

  await page.getByLabel("Period", { exact: true }).selectOption("custom");
  await page.getByLabel("From", { exact: true }).fill("2025-01-01");
  await page.getByLabel("To", { exact: true }).fill("2025-01-31");
  await expect(report.getByTestId("pass-rate")).toHaveText("No runs");
  expect(await axe(page)).toEqual([]);
});

test("share link: opens without an account, counts views, can be turned off", async ({ browser }) => {
  await page.getByLabel("Period", { exact: true }).selectOption("30");
  await page.getByRole("button", { name: "Share link" }).click();
  const d = dialog(page);
  await d.getByLabel("Link works for").selectOption("14");
  await d.getByRole("button", { name: "Create link" }).click();
  await toast(page, "Share link created");
  shareUrl = (await d.getByLabel("Report link").textContent())!.trim();
  expect(shareUrl).toMatch(/\/r\/qar_/);
  await d.getByRole("button", { name: "Done" }).click();

  const ctx = await browser.newContext();
  const pub = await ctx.newPage();
  const pubErrors = watchErrors(pub);
  await pub.goto(shareUrl);
  await expect(pub.getByRole("article", { name: "Quality report for Contoso" })).toBeVisible();
  await expect(pub.getByText(/Shared report · link works until/)).toBeVisible();
  await expect(pub.locator(".rail")).toHaveCount(0);
  await expect(pub).toHaveTitle("Contoso: quality report");
  expect(await axe(pub)).toEqual([]);

  await page.reload();
  const row = page.getByTestId("share-row");
  await expect(row).toContainText("Contoso");
  await expect(row.locator("td.num")).toHaveText("1");
  await row.getByRole("button", { name: "Turn off the Contoso link" }).click();
  await dialog(page).getByRole("button", { name: "Turn off link" }).click();
  await toast(page, "Link turned off");
  await expect(page.getByTestId("share-row")).toHaveCount(0);

  await pub.reload();
  await expect(pub.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  await pub.goto("/r/qar_not-a-real-token-at-all-000");
  await expect(pub.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  expect(pubErrors).toEqual([]);
  await ctx.close();
});

test("developers can't change channels or share reports", async ({ browser, request }) => {
  const auth = { authorization: `Bearer ${owner.token}` };
  const email = `dev-${Date.now()}@acme.test`;
  const u = await (await request.post(`${API}/auth/signup`, { data: { name: "Dev", email, password: PASSWORD, createOrg: false } })).json();
  const inv = await (await request.post(`${API}/orgs/${owner.orgId}/invites`, { headers: auth, data: { email, role: "developer" } })).json();
  await request.post(`${API}/invites/accept`, { headers: { authorization: `Bearer ${u.tokens.accessToken}` }, data: { token: inv.token } });
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto("/login");
  await p.getByLabel("Email").fill(email);
  await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Log in" }).click();
  await expect(p).toHaveURL(/\/o\//);
  await p.goto(`/o/${owner.orgId}/notifications`);
  await expect(p.getByRole("region", { name: "Channel #qa-alerts-v2" })).toBeVisible();
  await expect(p.getByRole("button", { name: "New channel" })).toHaveCount(0);
  await expect(p.getByRole("button", { name: "Send test" })).toHaveCount(0);
  await p.goto(`/o/${owner.orgId}/reports`);
  await expect(p.getByRole("article")).toBeVisible();
  await expect(p.getByRole("button", { name: "Share link" })).toHaveCount(0);
  await expect(p.getByRole("button", { name: "Download PDF" })).toBeVisible();
  await ctx.close();
});
