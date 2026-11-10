/**
 * Dogfooding: start a throwaway platform API (in-memory Postgres), create two
 * orgs and a viewer, then run the QA engine against the platform and upload the
 * result to the platform itself.
 *
 *   npm run dogfood -w @qa/api
 */
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { openDb, migrate } from "../src/db/index.js";
import { createApp } from "../src/app.js";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(apiDir, "../..");

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
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const call = async (method: string, p: string, body?: unknown, token?: string) => {
  const r = await fetch(`${base}/api/v1${p}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const pw = "dogfood-password-123";
const mk = async (label: string) => {
  const email = `${label}@dogfood.invalid`;
  const j = await call("POST", "/auth/signup", { name: label, email, password: pw, orgName: `${label} org` });
  return { email, token: j.tokens.accessToken as string, orgId: j.org.id as string };
};

try {
  const a = await mk("owner-a");
  const b = await mk("owner-b");
  const viewer = await mk("viewer-a");
  const inv = await call("POST", `/orgs/${a.orgId}/invites`, { email: viewer.email, role: "viewer" }, a.token);
  await call("POST", "/invites/accept", { token: inv.token }, viewer.token);
  const project = (await call("POST", `/orgs/${a.orgId}/projects`, { name: "Platform API (dogfood)" }, a.token)).project;
  const env = (await call("POST", `/orgs/${a.orgId}/projects/${project.id}/environments`, { name: "local", apiBaseUrl: base }, a.token)).environment;
  const key = (await call("POST", `/orgs/${a.orgId}/projects/${project.id}/api-keys`, { name: "dogfood" }, a.token)).key;

  console.log(`Platform API on ${base} · org ${a.orgId} · project ${project.id}`);
  const out = path.join(repoRoot, "qa-out-dogfood");
  // Async spawn: this process also serves the API, so it must not block while the engine runs
  const child = spawn(process.execPath, ["--import", "tsx", path.join(repoRoot, "src/cli.ts"), "run", "-c", path.join(apiDir, "qa.config.ts"), "--suite", "local", "--out", out, "--upload"], {
    cwd: apiDir,
    stdio: "inherit",
    env: {
      ...process.env,
      QA_BASE_URL: base,
      QA_OWNER_A_ID: a.email, QA_OWNER_A_PASS: pw,
      QA_OWNER_B_ID: b.email, QA_OWNER_B_PASS: pw,
      QA_VIEWER_A_ID: viewer.email, QA_VIEWER_A_PASS: pw,
      QA_PARAM_ORGID: a.orgId, QA_PARAM_PROJECTID: project.id, QA_PARAM_ENVIRONMENTID: env.id,
      QA_PLATFORM_URL: base, QA_PLATFORM_API_KEY: key, QA_PLATFORM_ENV: env.id,
    },
  });
  const code: number = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  // Show what the platform recorded about itself
  const runs = (await call("GET", `/orgs/${a.orgId}/projects/${project.id}/runs`, undefined, a.token)).runs;
  const issues = (await call("GET", `/orgs/${a.orgId}/projects/${project.id}/issues?status=all`, undefined, a.token)).issues;
  console.log(`\nPlatform now holds ${runs.length} run(s) for itself; latest status: ${runs[0]?.status ?? "none"}; issues: ${issues.length}`);
  for (const i of issues) console.log(`  - [${i.severity}] ${i.title} · ${i.target} (${i.status})`);
  console.log(`Report: ${path.join(out, "report.html")}`);
  process.exitCode = code;
} finally {
  server.close();
  await db.close();
}
