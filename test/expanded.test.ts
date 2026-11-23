import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/core/config.js";
import { AuthProvider } from "../src/core/auth.js";
import { HttpClient, readBoundedResponse } from "../src/core/http.js";
import type { RunContext } from "../src/core/context.js";
import type { QaPlugin, Finding } from "../src/core/types.js";
import { runPlugins } from "../src/core/runner.js";
import { gate } from "../src/core/triage.js";
import { importOpenApi, importPostman, readDocument } from "../src/discovery/import.js";
import { loadPlugins } from "../src/core/plugin-sdk.js";
import { EXPANDED_PLUGINS } from "../src/plugins/expanded/index.js";
import { PLUGINS } from "../src/plugins/index.js";
import { redactText } from "../src/core/redact.js";
import { uploadArtifacts } from "../src/core/upload.js";
import type { RunSummary } from "../src/core/report.js";
import { discoverRoutes } from "../src/discovery/express-routes.js";

test("Express discovery respects named, aliased, default and nested router bindings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "veriq-router-bindings-"));
  try {
    fs.writeFileSync(path.join(root, "index.ts"), `import Def, { Public as P, Private as R } from './routes.js'; const apiRoutes = [{path:'/public',route:P},{path:'/private',route:R},{path:'/default',route:Def}];`);
    fs.writeFileSync(path.join(root, "routes.ts"), `import {Router} from 'express'; import {Child as Nested} from './child.js'; const publicRouter=Router(); const privateRouter=Router(); publicRouter.post('/event', handler); privateRouter.route('/settings').get(auth(), handler).patch(auth(), handler); privateRouter.use('/nested',Nested); export {publicRouter as Public}; export const Private=privateRouter; export default privateRouter;`);
    fs.writeFileSync(path.join(root, "child.ts"), `import {Router} from 'express'; export const Child=Router(); export const Unmounted=Router(); Child.get('/child',handler); Unmounted.get('/wrong',handler);`);
    const result = discoverRoutes({ backendDir: root, routesIndex: "index.ts", apiPrefix: "/api" });
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.routes.map((r) => `${r.method} ${r.path}`).sort(), [
      "POST /api/public/event", "GET /api/private/settings", "PATCH /api/private/settings", "GET /api/private/nested/child",
      "GET /api/default/settings", "PATCH /api/default/settings", "GET /api/default/nested/child",
    ].sort());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veriq-checks-"));
const plugins = new Map(EXPANDED_PLUGINS.map((p) => [p.name, p]));
const jwtHead = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
const jwtBody = Buffer.from(JSON.stringify({ sub: "qa", exp: 9999999999 })).toString("base64url");
const token = `${jwtHead}.${jwtBody}.${createHmac("sha256", "test-secret").update(`${jwtHead}.${jwtBody}`).digest("base64url")}`;
let url = "", hits = 0, loginHits = 0, balance = 0, loggedOut = false, base: RunContext;
const uploadedEvidence: unknown[] = [];
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
  const u = new URL(req.url!, "http://test");
  const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (u.pathname === "/api/v1/runner/runs/fixture/artifacts") { uploadedEvidence.push(JSON.parse(Buffer.concat(chunks).toString())); return send(201, { id: "artifact" }); }
  if (u.pathname === "/login") { loginHits++; loggedOut = false; res.setHeader("set-cookie", ["session=fixture-session; HttpOnly; Path=/", "analytics=unused; Path=/"]); return send(200, { token, challenge: "fixture-challenge" }); }
  if (u.pathname === "/otp") return send(200, { token });
  if (u.pathname === "/logout") { loggedOut = true; return send(200, {}); }
  if (u.pathname === "/protected") return send(!loggedOut && req.headers.authorization === `Bearer ${token}` ? 200 : 401, { id: "qa" });
  if (u.pathname === "/bad-session") return send(200, { id: "qa" });
  if (u.pathname === "/cookie") return send(req.headers.cookie === "session=fixture-session" ? 200 : 401, {});
  if (u.pathname === "/key") return send(req.headers["x-api-key"] === "fixture-key" ? 200 : 401, {});
  if (u.pathname === "/leak") return send(200, { data: [{ passwordHash: "fixture-password-hash", refreshToken: "fixture-refresh-token" }] });
  if (u.pathname === "/safe") return send(200, { data: [{ id: "qa", password: "[redacted]" }] });
  if (u.pathname === "/reject") return send(403, {});
  if (u.pathname === "/accept") return send(200, {});
  if (u.pathname === "/rate") return send(++hits >= 3 ? 429 : 401, {});
  if (u.pathname === "/drop") { hits++; req.socket.destroy(); return; }
  if (u.pathname === "/write") { balance++; return send(200, {}); }
  if (u.pathname === "/state") return send(200, { balance });
  if (u.pathname === "/graphql-safe") return send(200, { errors: [{ message: "Denied" }] });
  if (u.pathname === "/graphql-bad") return send(200, { data: { secret: "fixture" }, errors: [{ message: "partial" }] });
  return send(404, {});
});
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { config } = await loadConfig("test/fixture.config.ts", {});
  config.target = { ...config.target, baseUrl: url, requestsPerMinute: 600000, timeoutMs: 1000 };
  config.accounts = { qa: { identifier: "qa", password: "fixture-password", device: "", role: "USER" } };
  config.login = { path: "/login", tokenPath: "token" };
  base = { config, configDir: dir, outDir: dir, suite: "local", routes: [], targetRoutes: [], selectedPlugins: [], changedFiles: null, updateVisual: false,
    log: { info() {}, warn() {}, debug() {} } };
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); });
function context(settings: Record<string, unknown> = {}, active = false): RunContext {
  const config = structuredClone(base.config); config.pluginSettings = settings; config.allowMutations = active; config.disposable = active;
  const client = new HttpClient(url, 600000, 1000);
  return { ...base, config, http: client, auth: new AuthProvider(config, client) };
}
async function run(name: string, value: unknown, active = false) {
  const result = (await runPlugins([plugins.get(name)!], context({ [name]: value }, active)))[0];
  return result;
}
function write(file: string, value: unknown) { fs.writeFileSync(path.join(dir, file), typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("54 distinct plugins; every configured adapter skips with an honest prerequisite", async () => {
  assert.equal(PLUGINS.length, 54); assert.equal(new Set(PLUGINS.map((p) => p.name)).size, 54);
  for (const plugin of EXPANDED_PLUGINS.filter((p) => p.skipReason)) assert.match(plugin.skipReason!(context())!, /Configure/);
});
test("HTTP: mutations are not retried after an ambiguous connection failure", async () => {
  hits = 0; const result = await new HttpClient(url, 600000, 1000).send({ method: "POST", path: "/drop", json: {} });
  assert.ok(result.networkError); assert.equal(hits, 1);
});
test("HTTP: cross-origin credentials and URL credentials are refused before fetch", async () => {
  const client = new HttpClient(url, 600000, 1000);
  await assert.rejects(() => client.send({ method: "GET", path: "https://example.com/private", headers: { authorization: "secret" } }), /origin/);
  assert.throws(() => client.url(url.replace("http://", "http://user:pass@")), /credentials/);
});

test("Response size limit applies without trusting Content-Length", async () => {
  assert.equal(await readBoundedResponse(new Response("small"), 5), "small");
  await assert.rejects(() => readBoundedResponse(new Response("oversized"), 5), /exceeds/);
});

test("CLI evidence upload sends linked files and refuses traversal and symlink escapes", async () => {
  const out = path.join(dir, "evidence"); fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, "screenshot.png"), "fixture-image");
  const summary = (image: string) => ({ results: [{ findings: [{ evidence: { image } }] }] } as RunSummary);
  const options = { url, apiKey: "fixture-key" };
  assert.equal(await uploadArtifacts(summary("screenshot.png"), out, "fixture", options), 1);
  assert.equal(uploadedEvidence.length, 1);
  assert.equal((uploadedEvidence[0] as { data: string }).data, Buffer.from("fixture-image").toString("base64"));
  await assert.rejects(() => uploadArtifacts(summary("../private.png"), out, "fixture", options), /Unsafe/);
  const outside = path.join(dir, "outside-evidence"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "private.png"), "private-fixture");
  const link = path.join(out, "escape"); fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  try { await assert.rejects(() => uploadArtifacts(summary("escape/private.png"), out, "fixture", options), /escapes/); }
  finally { fs.unlinkSync(link); }
  assert.equal(uploadedEvidence.length, 1, "No unsafe file may reach the upload endpoint");
});
test("Cookie strategy sends only allowlisted cookies; API-key strategy authenticates", async () => {
  const ctx = context(); ctx.config.login.strategy = "cookie"; ctx.config.login.cookieNames = ["session"];
  const header = await ctx.auth!.header("qa"); assert.equal(header?.cookie, "session=fixture-session");
  assert.ok(ctx.auth!.secretValues().includes("fixture-session"));
  assert.equal((await ctx.http!.send({ method: "GET", path: "/cookie", headers: header })).status, 200);
  const keyCtx = context(); keyCtx.config.login.strategy = "api-key"; keyCtx.config.accounts.qa.apiKey = "fixture-key";
  assert.equal((await keyCtx.http!.send({ method: "GET", path: "/key", headers: await keyCtx.auth!.header("qa") })).status, 200);
});
test("Concurrent probes reuse one login, avoiding single-session invalidation", async () => {
  const ctx = context(); loginHits = 0;
  const headers = await Promise.all(Array.from({ length: 8 }, () => ctx.auth!.header("qa")));
  assert.equal(loginHits, 1); assert.ok(headers.every((h) => h?.authorization === `Bearer ${token}`));
});

test("OAuth uses explicit HTTPS credentials and never exposes malformed provider response bodies", async () => {
  const fetchOriginal = globalThis.fetch;
  process.env.VERIQ_FIXTURE_CLIENT = "fixture-client"; process.env.VERIQ_FIXTURE_SECRET = "fixture-oauth-secret";
  const oauth = () => {
    const ctx = context(); ctx.config.login = { ...ctx.config.login, strategy: "oauth2", oauth: {
      tokenUrl: "https://identity.example.test/token", clientIdEnv: "VERIQ_FIXTURE_CLIENT", clientSecretEnv: "VERIQ_FIXTURE_SECRET",
    } }; return ctx;
  };
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://identity.example.test/token"); assert.equal(init?.redirect, "error");
      const body = init?.body as URLSearchParams;
      assert.equal(body.get("grant_type"), "client_credentials"); assert.equal(body.get("client_secret"), "fixture-oauth-secret");
      return Response.json({ access_token: "fixture-oauth-token", token_type: "Bearer" });
    };
    assert.equal((await oauth().auth!.header("qa"))?.authorization, "Bearer fixture-oauth-token");
    globalThis.fetch = async () => new Response("private-provider-response-with-secret", { status: 502 });
    const bad = oauth(); assert.equal(await bad.auth!.header("qa"), undefined);
    assert.match(bad.auth!.loginError("qa")!, /invalid JSON/);
    assert.ok(!bad.auth!.loginError("qa")!.includes("private-provider"));
    const insecure = oauth(); insecure.config.login.oauth!.tokenUrl = "http://identity.example.test/token";
    await assert.rejects(() => insecure.auth!.header("qa"), /HTTPS/);
  } finally {
    globalThis.fetch = fetchOriginal; delete process.env.VERIQ_FIXTURE_CLIENT; delete process.env.VERIQ_FIXTURE_SECRET;
  }
});
test("OTP and trusted custom authentication work; header injection is rejected", async () => {
  const ctx = context(); ctx.config.login.otp = { path: "/otp", codeEnv: "VERIQ_FIXTURE_OTP", challengePath: "challenge" };
  process.env.VERIQ_FIXTURE_OTP = "123456";
  try { assert.equal((await ctx.auth!.header("qa"))?.authorization, `Bearer ${token}`); }
  finally { delete process.env.VERIQ_FIXTURE_OTP; }
  const custom = context(); custom.config.login.strategy = "custom";
  custom.config.login.customScript = path.join(dir, write("auth.mjs", "export default async () => ({'x-api-key':'fixture-key'})"));
  assert.equal((await custom.auth!.header("qa"))?.["x-api-key"], "fixture-key");
  const unsafe = context(); unsafe.config.login.strategy = "custom";
  unsafe.config.login.customScript = path.join(dir, write("unsafe-auth.mjs", "export default async () => ({host:'attacker.invalid'})"));
  await assert.rejects(() => unsafe.auth!.header("qa"), /unsafe headers/);
});

test("Custom login retains accounts without passwords and deduplicates concurrent sessions", async () => {
  write("custom-config.mjs", "export default {backend:false, login:{strategy:'custom',customScript:'./concurrent-auth.mjs'}, accounts:{qa:{role:'USER',device:''}}}");
  write("concurrent-auth.mjs", "let count=0; export default async () => { const value=String(++count); await new Promise(r=>setTimeout(r,20)); return {'x-session':value}; }");
  const { config } = await loadConfig(path.join(dir, "custom-config.mjs"), {});
  const auth = new AuthProvider(config, new HttpClient(url, 600000, 1000));
  assert.deepEqual(auth.accountNames, ["qa"]);
  const headers = await Promise.all(Array.from({ length: 8 }, () => auth.header("qa")));
  assert.ok(headers.every((h) => h?.["x-session"] === "1"));
  assert.equal(await auth.header("unknown"), undefined);
});
test("OpenAPI imports local refs, security alternatives and schemas without source", () => {
  const doc = { openapi: "3.1.0", components: { pathItems: { item: { get: { security: [{ bearer: [] }], "x-veriq-roles": ["ADMIN"] } } } },
    paths: { "/items/{id}": { $ref: "#/components/pathItems/item" }, "/public": { get: { security: [{}, { bearer: [] }] } } } };
  const routes = importOpenApi(doc); assert.equal(routes[0].path, "/items/:id"); assert.equal(routes[0].authRequired, true); assert.equal(routes[1].authRequired, false);
  assert.throws(() => importOpenApi({ openapi: "3.0.0", paths: { "/": { $ref: "https://example.com/spec" } } }), /local/);
  assert.throws(() => importOpenApi({ openapi: "3.0.0", paths: { "/": { $ref: "#/paths/~1" } } }), /Cyclic/);
  assert.throws(() => importOpenApi({ openapi: "3.1.0", paths: { "/": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "file:///private/schema.json" } } } } } } } } }), /local/);
  assert.throws(() => importOpenApi({ openapi: "3.1.0", paths: {}, components: { schemas: { nested: { items: { $ref: "https://example.com/schema" } } } } }), /local/);
});
test("Postman inherits auth but respects noauth and variables", () => {
  const routes = importPostman({ info: { schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, auth: { type: "bearer" }, item: [
    { request: { method: "GET", url: "{{baseUrl}}/users/{{id}}" } }, { request: { method: "GET", auth: { type: "noauth" }, url: "{{baseUrl}}/health" } },
  ] });
  assert.equal(routes[0].path, "/users/:id"); assert.equal(routes[0].authRequired, true); assert.equal(routes[1].authRequired, false);
});
test("YAML import rejects duplicate keys", () => {
  write("bad.yaml", "openapi: 3.0.0\nopenapi: 3.1.0\n"); assert.throws(() => readDocument(path.join(dir, "bad.yaml")), /Invalid/);
});
test("SDK rejects duplicate/version-invalid plugins and invalid output fails gate", async () => {
  write("bad.mjs", "export default { name: 'external', apiVersion: 2, run() {} }");
  await assert.rejects(loadPlugins([], ["./bad.mjs"], dir, {}), /Invalid/);
  const plugin: QaPlugin = { name: "broken", layer: "api", description: "fixture", async run() { return [{ plugin: "other" }] as Finding[]; } };
  const results = await runPlugins([plugin], context()); assert.equal(results[0].status, "errored"); assert.equal(gate(results, "high").errors.length, 1);
});

test("Imported static reports work without backend source; prerequisite errors fail closed", async () => {
  write("imported-tests.xml", '<testsuites><testsuite><testcase name="ok"/></testsuite></testsuites>');
  const ctx = context({ "test-results": { junit: "imported-tests.xml" } }); ctx.config.backend.none = true;
  const [result] = await runPlugins([plugins.get("test-results")!], ctx);
  assert.equal(result.status, "passed");
  const broken: QaPlugin = { name: "broken-prerequisite", layer: "static", description: "fixture", skipReason() { throw new Error("Invalid prerequisite"); }, async run() { return []; } };
  assert.equal((await runPlugins([broken], ctx))[0].status, "errored");
});
test("Evidence redacts secrets in responses, bearer tokens and URL params", () => {
  const result = redactText('{"passwordHash":"abc","accessToken":"xyz"} Bearer abc.def.ghi ?token=foo&x=ok', []);
  for (const secret of ["abc", "xyz", "abc.def.ghi", "foo"]) assert.ok(!result.includes(secret));
  assert.ok(result.includes("x=ok"));
});
test("Authorization matrix compares expected policy and blocks writes without disposable consent", async () => {
  const denied = { cases: [{ method: "GET", path: "/reject", expectedStatuses: [403] }] };
  assert.equal((await run("authz-matrix", denied)).status, "passed");
  assert.equal((await run("authz-matrix", { cases: [{ method: "GET", path: "/accept", expectedStatuses: [403] }] })).findings.length, 1);
  assert.equal((await run("authz-matrix", { cases: [{ method: "POST", path: "/accept", expectedStatuses: [403] }] })).status, "skipped");
});
test("Data exposure detects nested secrets without leaking values, clean response is clean", async () => {
  for (const p of ["/leak", "/safe"]) {
    const ctx = context(); ctx.targetRoutes = importOpenApi({ openapi: "3.0.0", paths: { [p]: { get: {} } } });
    const result = (await runPlugins([plugins.get("data-exposure")!], ctx))[0];
    assert.equal(result.findings.length, p === "/leak" ? 2 : 0); assert.ok(!JSON.stringify(result).includes("fixture-password-hash"));
  }
});
test("JWT checks detect bad sessions and weak secrets without mistaking invalid signatures for expiry", async () => {
  const safe = await run("auth-session", { account: "qa", protectedPath: "/protected", logoutPath: "/logout", weakSecrets: ["not-the-key"] }, true);
  assert.equal(safe.status, "passed");
  const bad = await run("auth-session", { account: "qa", protectedPath: "/bad-session", weakSecrets: ["test-secret"] }, true);
  assert.equal(bad.findings.length, 3);
});
test("Rate checks see 429 directly, report absent expected limits, reject impossible windows", async () => {
  hits = 0; assert.equal((await run("rate-limit", { cases: [{ path: "/rate" }], attempts: 4, maxWindowMs: 1000 }, true)).status, "passed");
  assert.equal((await run("rate-limit", { cases: [{ path: "/accept" }], attempts: 3, maxWindowMs: 1000 }, true)).findings.length, 1);
  assert.equal((await run("rate-limit", { cases: [{ path: "/accept" }], attempts: 3, maxWindowMs: 1000 })).status, "skipped");
});
test("Webhook unsigned/invalid probes distinguish acceptance and rejection", async () => {
  for (const p of ["/reject", "/accept"]) assert.equal((await run("webhook-security", { cases: [{ method: "POST", path: p, signatureHeader: "x-signature" }] }, true)).findings.length, p === "/reject" ? 0 : 2);
});
test("Race check reads application invariant rather than counting successful responses", async () => {
  const c = { request: { method: "POST", path: "/write" }, concurrency: 3, verify: { path: "/state" }, valuePath: "balance", expectedValue: 1 };
  balance = 0; assert.equal((await run("race-conditions", c, true)).findings.length, 1);
  balance = 0; assert.equal((await run("race-conditions", { ...c, expectedValue: 3 }, true)).status, "passed");
});
test("Upload policy probes require disposable data and report accepted invalid uploads", async () => {
  const c = { path: "/accept", account: "qa", field: "file", maxAcceptedBytes: 20 };
  assert.equal((await run("file-upload", c)).status, "skipped");
  assert.equal((await run("file-upload", c, true)).findings.length, 3);
});
test("GraphQL partial data is still exposure; errors without data are rejected", async () => {
  assert.equal((await run("graphql", { path: "/graphql-safe" }, true)).status, "passed");
  assert.equal((await run("graphql", { path: "/graphql-bad" }, true)).findings.length, 1);
});
test("Validation coverage distinguishes explicit schema middleware", async () => {
  const ctx = context(); ctx.targetRoutes = importOpenApi({ openapi: "3.0.0", paths: { "/unsafe": { post: {} }, "/safe": { post: { requestBody: { content: { "application/json": { schema: { type: "object" } } } } } } } });
  const result = (await runPlugins([plugins.get("validation-coverage")!], ctx))[0]; assert.equal(result.findings.length, 1); assert.match(result.findings[0].target, /unsafe/);
});
test("API contracts detect removed response fields and new required parameters", async () => {
  const base = { openapi: "3.0.0", paths: { "/items": { get: { responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } } } } } } } };
  write("base.json", base); write("head.json", base);
  assert.equal((await run("api-contract", { baseline: "base.json", current: "head.json" })).status, "passed");
  write("head.json", { openapi: "3.0.0", paths: { "/items": { get: { parameters: [{ name: "limit", in: "query", required: true }], responses: {} } } } });
  assert.equal((await run("api-contract", { baseline: "base.json", current: "head.json" })).findings.length, 2);
});
test("Explicit project execution collects fresh reports and rejects exit/report mismatch and timeouts", async () => {
  const script = path.join(dir, 'project-runner.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; const [report,mode]=process.argv.slice(2); if(mode==='hang') setInterval(()=>{},1000); else { if(mode!=='missing') fs.writeFileSync(report, '<testsuite><testcase name="example">'+(mode==='fail'?'<failure/>':'')+'</testcase></testsuite>'); process.exitCode=mode==='fail'||mode==='mismatch'?1:0; }`);
  const options = (mode: string, timeoutMs = 5000) => ({ junit: 'old-junit.xml', execution: { command: process.execPath, args: [script, '{junit}', mode], timeoutMs } });
  fs.writeFileSync(path.join(dir, 'old-junit.xml'), '<testsuite><testcase name="stale"/></testsuite>');
  assert.equal((await run('test-results', options('pass'))).status, 'passed');
  assert.equal((await run('test-results', options('fail'))).status, 'failed');
  assert.equal((await run('test-results', options('mismatch'))).status, 'errored');
  assert.equal((await run('test-results', options('missing'))).status, 'errored');
  assert.equal((await run('test-results', options('hang', 200))).status, 'errored');
  assert.ok(fs.readFileSync(path.join(dir, 'old-junit.xml'), 'utf8').includes('stale'));
});

test("JUnit failures, flaky retries and coverage use the original outcomes; DTDs rejected", async () => {
  write("junit.xml", '<testsuites><testsuite><testcase name="broken"><failure>secret output</failure></testcase><testcase name="retry"><flakyFailure/></testcase><testcase name="ok"/></testsuite></testsuites>');
  write("coverage.json", { total: { lines: { pct: 50 } } });
  const result = await run("test-results", { junit: "junit.xml", coverage: "coverage.json", minLinePercent: 80 });
  assert.equal(result.findings.length, 3); assert.equal(gate([result], "medium").blocking.length, 2); assert.ok(!JSON.stringify(result).includes("secret output"));
  write("junit.xml", '<!DOCTYPE a [<!ENTITY b SYSTEM "file:///private">]><testsuite/>');
  assert.equal((await run("test-results", { junit: "junit.xml" })).status, "errored");
});
test("SARIF findings, baselines, failed invocations and malformed reports", async () => {
  const report = { version: "2.1.0", runs: [{ tool: { driver: { name: "fixture" } }, results: [{ ruleId: "unsafe", level: "error", message: { text: "secret snippet" }, locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 2 } } }] }] }] };
  write("scanner.json", report);
  for (const name of ["sast", "container-iac"]) {
    const r = await run(name, { report: "scanner.json" }); assert.equal(r.findings.length, 1); assert.ok(!JSON.stringify(r).includes("secret snippet"));
    const known = await run(name, { report: "scanner.json", baseline: "scanner.json" }); assert.equal(gate([known], "high").blocking.length, 0);
    assert.equal((await run(name, { report: write("invalid.json", {}) })).status, "errored");
  }
});
test("MobSF adapter validates schema and imports code and manifest defects", async () => {
  write("mobile.json", { code_analysis: { findings: { unsafe: { metadata: { severity: "high" } } } }, manifest_analysis: { manifest_findings: [{ rule: "debug", severity: "warning" }] } });
  assert.equal((await run("mobile-static", { report: "mobile.json" })).findings.length, 2);
  assert.equal((await run("mobile-static", { report: "invalid.json" })).status, "errored");
});
test("SBOM uses explicit license policy and flags unknown licenses", async () => {
  write("bom.json", { bomFormat: "CycloneDX", specVersion: "1.6", components: [{ name: "safe", licenses: [{ license: { id: "MIT" } }] }, { name: "unknown" }] });
  const r = await run("license-sbom", { file: "bom.json", allowedLicenses: ["MIT"] }); assert.equal(r.findings.length, 1); assert.match(r.findings[0].target, /unknown/);
});
test("Bundle budget catches growth and rejects empty builds", async () => {
  fs.mkdirSync(path.join(dir, "build")); write("build/app.js", "console.log('hello');");
  assert.equal((await run("bundle-budget", { directory: "build", maxBytes: 1000, maxGzipBytes: 1000 })).status, "passed");
  assert.equal((await run("bundle-budget", { directory: "build", maxBytes: 1, maxGzipBytes: 1 })).findings.length, 1);
});
test("Uptime reports actual HTTP outcomes and observation ratio without inventing continuous coverage", async () => {
  write("history.json", [{ at: "2026-11-01T00:00:00.000Z", available: true }, { at: "2026-11-01T00:05:00.000Z", available: false }]);
  const r = await run("uptime", { requests: [{ path: "/accept" }, { path: "/reject" }], history: "history.json" });
  assert.equal(r.findings.length, 1); assert.equal(r.stats?.observedAvailabilityPercent, 50);
});
test("Post-deploy adapter normalizes window lengths and rejects wrong release", async () => {
  write("errors-base.json", { release: "old", durationSeconds: 60, complete: true, errors: [{ fingerprint: "existing", count: 10 }] });
  write("errors-head.json", { release: "new", durationSeconds: 120, complete: true, errors: [{ fingerprint: "existing", count: 20 }, { fingerprint: "new", count: 2 }] });
  const c = { baseline: "errors-base.json", current: "errors-head.json", release: "new" };
  assert.equal((await run("post-deploy-errors", c)).findings.length, 1);
  assert.equal((await run("post-deploy-errors", { ...c, release: "wrong" })).status, "errored");
});
test("k6 adapter rejects empty reports and enforces load metrics", async () => {
  write("k6.json", { metrics: { http_reqs: { values: { count: 100 } }, http_req_duration: { values: { "p(95)": 500 } }, http_req_failed: { values: { rate: 0 } } } });
  assert.equal((await run("load-stress", { report: "k6.json", maxP95Ms: 1000, maxErrorRate: 0.01 })).status, "passed");
  assert.equal((await run("load-stress", { report: "k6.json", maxP95Ms: 100, maxErrorRate: 0.01 })).findings.length, 1);
  assert.equal((await run("load-stress", { report: "invalid.json", maxP95Ms: 100, maxErrorRate: 0.01 })).status, "errored");
});
test("Translation keys are checked without browser dependencies", async () => {
  write("en.json", { greeting: "Hello", menu: { exit: "Exit" } }); write("ur.json", { greeting: "Salam" });
  const r = await run("i18n-rtl", { baseFile: "en.json", translations: ["ur.json"] }); assert.equal(r.findings.length, 1); assert.match(r.findings[0].detail!, /menu.exit/);
});
test("TLS settings reject malformed host before opening a network connection", async () => {
  assert.equal((await run("tls-dns-mail", { host: "https://bad/path" })).status, "errored");
});
