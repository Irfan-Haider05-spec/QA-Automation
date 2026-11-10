/**
 * Screenshots of the main screens on desktop and phone widths, for design
 * review. Off by default:  SCREENSHOTS=1 npm run e2e -w @qa/dashboard -- screens
 */
import { test, expect } from "@playwright/test";
import { API, PASSWORD, sampleRun, uploadRun } from "./helpers";

test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to capture screens");

test("capture screens", async ({ page, request }) => {
  test.setTimeout(180_000);
  const email = `shots-${Date.now()}@acme.test`;
  const su = await (await request.post(`${API}/auth/signup`, { data: { name: "Sana Malik", email, password: PASSWORD, orgName: "Northwind Digital" } })).json();
  const auth = { authorization: `Bearer ${su.tokens.accessToken}` };
  const orgId = su.org.id;
  const client = await (await request.post(`${API}/orgs/${orgId}/clients`, { headers: auth, data: { name: "Contoso Retail" } })).json();
  const names = ["Loyalty API", "Merchant dashboard", "Payments service", "Mobile backend"];
  const projects: string[] = [];
  for (const [i, name] of names.entries()) {
    const p = await (await request.post(`${API}/orgs/${orgId}/projects`, { headers: auth, data: { name, clientId: i % 2 ? client.client.id : null, stack: "node-express" } })).json();
    projects.push(p.project.id);
  }
  const env = await (await request.post(`${API}/orgs/${orgId}/projects/${projects[0]}/environments`, { headers: auth, data: { name: "staging", apiBaseUrl: "https://staging-api.northwind.test", webApps: [{ name: "admin", baseUrl: "https://staging-api.northwind.test/admin", loginPath: "/login" }] } })).json();
  await request.post(`${API}/orgs/${orgId}/projects/${projects[0]}/environments/${env.environment.id}/credentials`, { headers: auth, data: { name: "merchantA", role: "MERCHANT", identifier: "a@shop.test", device: "merchant", secret: "x-secret-1" } });
  for (const [i, pid] of projects.entries()) {
    const key = (await (await request.post(`${API}/orgs/${orgId}/projects/${pid}/api-keys`, { headers: auth, data: { name: "CI" } })).json()).key;
    const runs = 3 + i * 3;
    for (let r = 0; r < runs; r++) {
      const bad = (r + i) % 3 === 0;
      const extra = i === 0 ? { trigger: r % 2 ? "pr" : "push", git: { sha: `abc${r}def0123`, ref: r % 2 ? "feature/checkout" : "main", pr: r % 2 ? String(40 + r) : undefined, repo: "northwind/loyalty-api" } } : {};
      const res = await uploadRun(request, key, { ...extra, ...sampleRun(i === 0 ? env.environment.id : undefined, bad ? [{ fp: `crit-00${i}`, severity: "critical" }, { fp: `high-00${i}` }, { fp: `med-000${i}`, severity: "medium", plugin: "api-smoke" }] : i === 3 ? [{ fp: "low-0001", severity: "low" }] : []), ...extra });
      expect(res.status(), await res.text()).toBe(201);
    }
  }
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${orgId}`));

  const base = `/o/${orgId}`;
  const shots: Array<[string, string]> = [
    ["overview", base],
    ["projects", `${base}/projects`],
    ["project-runs", `${base}/projects/${projects[0]}/runs`],
    ["project-issues", `${base}/projects/${projects[0]}/issues`],
    ["project-envs", `${base}/projects/${projects[0]}/environments`],
    ["project-ci", `${base}/projects/${projects[0]}/ci`],
    ["project-schedules", `${base}/projects/${projects[0]}/schedules`],
    ["members", `${base}/members`],
    ["audit", `${base}/audit`],
    ["reports", `${base}/reports`],
    ["notifications", `${base}/notifications`],
  ];
  for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "phone"]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const [name, url] of shots) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      // Nothing may force sideways scrolling
      // (elements inside a horizontally scrolling box, like wide tables, are fine)
      const wide = await page.evaluate((vw) => {
        const scrolls = (e: Element | null): boolean => !!e && e !== document.body && (["auto", "scroll", "hidden"].includes(getComputedStyle(e).overflowX) || scrolls(e.parentElement));
        return [...document.querySelectorAll("body *")]
          .filter((e) => e.getBoundingClientRect().right > vw + 1 && !scrolls(e.parentElement))
          .slice(0, 5)
          .map((e) => `${e.tagName.toLowerCase()}.${String(e.className)} → ${Math.round(e.getBoundingClientRect().right)}px`);
      }, w);
      expect.soft(wide, `${tag} ${name}: elements wider than the screen`).toEqual([]);
      await page.screenshot({ path: `e2e-results/screens/${tag}-${name}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/projects/${projects[0]}/runs`);
  await page.locator("table tbody tr").first().getByRole("link").first().click();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "e2e-results/screens/desktop-run-detail.png", fullPage: true });
  await page.goto(`${base}/projects/${projects[0]}/issues`);
  await page.getByRole("group", { name: "Filter by status" }).getByRole("button", { name: /All/ }).click();
  await page.locator("table tbody tr").first().getByRole("link").first().click();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "e2e-results/screens/desktop-issue-panel.png", fullPage: true });
  await page.goto(`${base}/projects/${projects[0]}/runs`);
  await page.getByRole("button", { name: "Run now" }).click();
  await page.getByTestId("readiness").waitFor();
  await page.screenshot({ path: "e2e-results/screens/desktop-run-now.png" });
  await page.keyboard.press("Escape");
  await page.goto(`${base}/reports`);
  await page.getByLabel("Report for", { exact: true }).selectOption({ label: "Loyalty API" });
  await page.getByRole("article").waitFor();
  await page.emulateMedia({ media: "print" });
  await page.screenshot({ path: "e2e-results/screens/print-report.png", fullPage: true });
  await page.emulateMedia({ media: "screen" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${base}/projects/${projects[0]}/runs`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "e2e-results/screens/desktop-dark-runs.png", fullPage: true });
  await page.goto("/signup");
  await page.context().clearCookies();
});
