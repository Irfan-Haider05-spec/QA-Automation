import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogCollector, pluginsFor, runJob, type ClaimPayload } from "../src/job.js";
import { buildProfile } from "../../../src/core/profile.js";
import { ProjectProfileSchema } from "@qa/shared";

const profile = {
  version: 1 as const, apiPrefix: "/api", healthPath: "/health", login: { path: "/login", tokenPath: "token" },
  accounts: {}, publicRoutes: [], privilegedPrefixes: [], tenantIsolation: { owner: "owner", attacker: "attacker", sharedResources: [], pairs: [], maxIdsPerRoute: 3 },
  cors: { allowedOrigins: [], probeOrigin: "https://invalid.example" }, pathParams: {}, gateFailOn: "high" as const,
  web: { slowMs: 3000, ignoreConsole: [], apps: [] }, routes: [],
};
const payload: ClaimPayload = {
  job: { id: "00000000-0000-4000-8000-000000000010", suite: "staging", trigger: "manual", attempts: 1 },
  project: { id: "p", name: "P" },
  environment: { id: "e", name: "staging", apiBaseUrl: "https://invalid.example", webApps: [], disposable: false, domain: "invalid.example" },
  profile, checks: { api: true, web: false }, accounts: [],
};
const profileConfig = (changes: Record<string, unknown> = {}) => ({
  project: "safe profile", backend: { dir: ".", routesIndex: "routes", apiPrefix: "/api", healthPath: "/health", envExample: ".env", modulesDir: "." },
  login: { path: "/login", tokenPath: "token", bodyTemplate: { email: "{{identifier}}", password: "{{password}}" } },
  accounts: { owner: { identifier: "person@example.test", password: "literal-secret-123", role: "owner", device: "web" } },
  publicRoutes: [], privilegedPrefixes: [], tenantIsolation: { owner: "owner", attacker: "owner", sharedResources: [], pairs: [], maxIdsPerRoute: 3 },
  cors: { allowedOrigins: [], probeOrigin: "https://invalid.example" }, target: { pathParams: {} }, gate: { failOn: "high" },
  web: { slowMs: 3000, ignoreConsole: [], apps: [] }, pluginSettings: {}, ...changes,
}) as any;

test("runner rejects unsafe or unsupported profiles before constructing engine settings", () => {
  assert.throws(() => pluginsFor({ ...payload, profile: { ...profile, hostedSettings: { "links-seo": { pages: [{ app: "admin", path: "../secret" }] } } } as any }), /invalid or unsafe/i);
  assert.throws(() => pluginsFor({ ...payload, profile: { ...profile, hostedUnsupportedReason: "Custom login is unsupported" } }), /Custom login/);
  assert.deepEqual(pluginsFor({ ...payload, profile: null, checks: { api: false, web: false } }), []);
});

test("profile publication excludes literal credentials and safely blocks unportable CLI plugin settings", () => {
  const secret = buildProfile(profileConfig({ login: { path: "/login", tokenPath: "token", bodyTemplate: { password: "literal-secret-123" } } }), []);
  assert.equal(secret.login.bodyTemplate, undefined);
  assert.match(secret.hostedUnsupportedReason ?? "", /literal credential/i);
  assert.equal(JSON.stringify(secret).includes("literal-secret-123"), false);
  assert.equal(ProjectProfileSchema.safeParse({ ...secret, login: { ...secret.login, bodyTemplate: { password: "literal-secret-123" } } }).success, false);

  const defaultMethod = buildProfile(profileConfig({ pluginSettings: { "authz-matrix": { cases: [{ path: "/api/orders", expectedStatuses: [401] }] } } }), []);
  assert.equal(defaultMethod.hostedSettings["authz-matrix"]?.cases[0].method, "GET");
  assert.equal(defaultMethod.hostedUnsupportedReason, undefined);
  const localWriteCase = buildProfile(profileConfig({ pluginSettings: { "authz-matrix": { cases: [{ method: "PATCH", path: "/api/orders", json: { status: "bad" }, expectedStatuses: [403] }] } } }), []);
  assert.deepEqual(localWriteCase.hostedSettings, {});
  assert.match(localWriteCase.hostedUnsupportedReason ?? "", /plugin settings/i);
});

test("runner redacts credentials split across chunks and bounds long log lines", () => {
  const lines: string[] = [];
  const log = createLogCollector(["super-secret-value"], lines);
  log.push(Buffer.from("prefix super-sec"));
  log.push(Buffer.from("ret-value suffix\n"));
  log.push(Buffer.from("x".repeat(30000)));
  log.flush();
  const text = lines.join("\n");
  assert.equal(text.includes("super-secret-value"), false);
  assert.match(text, /\*\*\*/);
  assert.ok(lines.every((line) => line.length <= 8192));
  assert.ok(lines.length <= 300);
});

test("log masking handles repetitive secret prefixes and split UTF-8 without retaining the whole stream", () => {
  const lines: string[] = [];
  const log = createLogCollector(["aaa", "sécret"], lines);
  log.push(Buffer.from("a".repeat(30000) + "\nsafe message\n"));
  assert.ok(lines.length > 0, "Repetitive prefixes must drain before end-of-stream");
  const unicode = Buffer.from("sécret\n");
  log.push(unicode.subarray(0, 2)); log.push(unicode.subarray(2)); log.flush();
  assert.equal(lines.join("\n").includes("aaa"), false);
  assert.equal(lines.join("\n").includes("sécret"), false);
  assert.equal(lines.join("\n").includes("�"), false);
});

test("spawn failures reach the result callback and still clean the temporary job directory", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-spawn-error-"));
  let callback: { log: string; outDir: string } | undefined;
  try {
    const outcome = await runJob(payload, {
      engineDir: path.join(workDir, "missing-engine"), workDir, timeoutMs: 10000,
      onResult: async (result, outDir) => { callback = { log: result.log, outDir }; },
    });
    assert.equal(outcome.exitCode, null);
    assert.match(outcome.log, /Could not start engine/);
    assert.match(callback?.log ?? "", /Could not start engine/);
    assert.equal(fs.existsSync(callback!.outDir), false);
    assert.deepEqual(fs.readdirSync(workDir), []);
  } finally { fs.rmSync(workDir, { recursive: true, force: true }); }
});
