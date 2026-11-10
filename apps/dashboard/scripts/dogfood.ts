/**
 * Dogfooding the dashboard: start a throwaway API (in-memory Postgres) and the
 * built dashboard, fill it with realistic data, then let the QA engine crawl
 * every page it can reach (broken pages, console errors, failed requests,
 * accessibility).
 *
 *   npm run build -w @qa/dashboard && npm run dogfood -w @qa/dashboard
 */
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../api/src/config.js";
import { openDb, migrate } from "../../api/src/db/index.js";
import { createApp } from "../../api/src/app.js";

const dashDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(dashDir, "../..");
const WEB_PORT = Number(process.env.DOGFOOD_WEB_PORT ?? 4184);

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "pglite://memory",
  JWT_SECRET: crypto.randomBytes(32).toString("hex"),
  VAULT_MASTER_KEY: crypto.randomBytes(32).toString("base64"),
});
const db = await openDb(config.DATABASE_URL);
await migrate(db);
const server = createApp(db, config).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const call = async (method: string, p: string, body?: unknown, token?: string) => {
  const r = await fetch(`${api}/api/v1${p}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`);
  return j;
};

const preview = spawn(process.execPath, [path.join(repoRoot, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], {
  cwd: dashDir, env: { ...process.env, VITE_API_PROXY: api }, stdio: ["ignore", "pipe", "inherit"],
});
const web = `http://127.0.0.1:${WEB_PORT}`;

try {
  for (let i = 0; ; i++) {
    if (await fetch(`${web}/login`).then((r) => r.ok).catch(() => false)) break;
    if (i > 60) throw new Error("vite preview didn't start (did you run the build?)");
    await new Promise((r) => setTimeout(r, 500));
  }
  const pw = "dogfood-password-123";
  const email = "owner@dogfood.invalid";
  const s = await call("POST", "/auth/signup", { name: "Dogfood Owner", email, password: pw, orgName: "Dogfood Org" });
  const t = s.tokens.accessToken as string;
  const o = s.org.id as string;
  const client = (await call("POST", `/orgs/${o}/clients`, { name: "Contoso" }, t)).client;
  for (const [i, name] of ["Loyalty API", "Payments"].entries()) {
    const p = (await call("POST", `/orgs/${o}/projects`, { name, clientId: i ? client.id : null }, t)).project;
    const e = (await call("POST", `/orgs/${o}/projects/${p.id}/environments`, { name: "staging", apiBaseUrl: "https://staging.dogfood.invalid" }, t)).environment;
    await call("POST", `/orgs/${o}/projects/${p.id}/environments/${e.id}/credentials`, { name: "merchantA", role: "MERCHANT", identifier: "a@shop.invalid", secret: "x" }, t);
    const key = (await call("POST", `/orgs/${o}/projects/${p.id}/api-keys`, { name: "CI" }, t)).key;
    for (const fps of [["dogfood-crit", "dogfood-high"], ["dogfood-crit"], []]) {
      const findings = fps.map((fp, j) => ({ plugin: "api-auth", severity: j ? "high" : "critical", title: `Finding ${fp}`, target: `GET /x/${fp}`, category: "security", fingerprint: fp, evidence: { status: 200, curl: "curl -i https://staging.dogfood.invalid/x" } }));
      const r = await fetch(`${api}/api/v1/runner/runs`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ project: name, suite: "staging", startedAt: new Date().toISOString(), durationMs: 1000, routesTotal: 5, routesSelected: 5, selectionReason: "all routes", requests: 10, environmentId: e.id,
          results: [{ plugin: "api-auth", status: findings.length ? "failed" : "passed", durationMs: 100, findings }], gate: { failOn: "high", passed: !findings.length, blocking: findings.length } }),
      });
      if (!r.ok) throw new Error(`upload → ${r.status} ${await r.text()}`);
    }
  }
  const inv = await call("POST", `/orgs/${o}/invites`, { email: "pending@dogfood.invalid", role: "developer" }, t);
  void inv;

  console.log(`Dashboard on ${web} · API on ${api}`);
  const out = path.join(repoRoot, "qa-out-dashboard");
  const child = spawn(process.execPath, ["--import", "tsx", path.join(repoRoot, "src/cli.ts"), "run", "-c", path.join(dashDir, "qa.config.ts"), "--suite", "local", "--out", out], {
    cwd: dashDir, stdio: "inherit",
    env: { ...process.env, QA_BASE_URL: api, QA_WEB_URL: web, QA_OWNER_ID: email, QA_OWNER_PASS: pw },
  });
  process.exitCode = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  console.log(`Report: ${path.join(out, "report.html")}`);
} finally {
  preview.kill();
  server.close();
  await db.close();
}
