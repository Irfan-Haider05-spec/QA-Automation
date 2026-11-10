/**
 * Self-test: boots the fixture API (which has planted bugs), runs the agent
 * against it, and checks that every planted bug is reported and that the
 * correctly-scoped routes are NOT reported. Run with: npm run selftest
 * Set SELFTEST_FUZZ=1 to include the Schemathesis plugin (needs schemathesis or uvx).
 * Set SELFTEST_PART=main, visual, socket, load, zap, lighthouse, flows or mobile to run only one part (default: all).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4011;
const out = path.join(root, "qa-out-selftest");

const expected: Array<[plugin: string, title: string, target: string]> = [
  ["route-auth", "Privileged route has no auth middleware", "POST /admin/create-admin"],
  ["route-auth", "Privileged route has no auth middleware", "GET /report-analytics/customer/export"],
  ["route-auth", "checks login but not role", "GET /admin/merchants"],
  ["route-auth", "shadowed by an earlier parameter route", "GET /product/featured"],
  ["route-auth", "without any handler", "POST /product/test"],
  ["env-drift", "code reads DATABASE_URL, .env.example documents MONGODB_URI", "DATABASE_URL"],
  ["secrets", "Hard-coded secret value", "src/config/legacy.ts:2"],
  ["health-cors", "X-Powered-By", "header x-powered-by"],
  ["health-cors", "disallowed origin gets HTTP 500", "CORS /api/v1/auth/login"],
  ["api-auth", "answers without any token", "GET /report-analytics/customer/export"],
  ["api-auth", "Role bypass", "GET /system/merchant-only"],
  ["api-smoke", "Server error 500", "GET /system/crash"],
  ["api-smoke", "Slow response", "GET /system/slow"],
  ["tenant-isolation", "Cross-tenant read", "GET /promotion/:id"],
  ["web-crawl", "Uncaught JavaScript error", "business /insights.html"],
  ["web-crawl", "returned 500 while loading the page", "business /reports.html"],
  ["web-crawl", "Console error: planted", "business /settings.html"],
  ["web-crawl", "Page renders blank", "business /beta.html"],
  ["web-crawl", "asset(s) failed to load", "business /promotions.html"],
  ["web-a11y", "Images must have alternative text", "business a11y:image-alt"],
];
const mustNotFlag: Array<[plugin: string, target: string]> = [
  ["tenant-isolation", "GET /customer/:id"], // correctly scoped by merchant
  ["api-auth", "GET /admin/stats"],          // correct role check
  ["health-cors", "CORS http://localhost:5173"], // allowed origin works
  ["web-crawl", "business /index.html"],          // healthy page
  ["web-crawl", "business /logout.html"],         // must never be visited
];
if (process.env.SELFTEST_FUZZ === "1") {
  expected.push(["api-fuzz", "Server error", "GET /promotion/search"]);
}

async function startServer(extraEnv: Record<string, string> = {}, port = PORT) {
  const server = spawn(process.execPath, ["--import", "tsx", path.join(root, "test/fixture-api/src/server.ts")], {
    env: { ...process.env, PORT: String(port), CLIENT_URL: "http://localhost:5173", ...extraEnv },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return server;
}

const agent = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", "tsx", path.join(root, "src/cli.ts"), "run", "-c", path.join(root, "test/fixture.config.ts"), ...args], {
    env: { ...process.env, QA_BASE_URL: `http://127.0.0.1:${PORT}`, ...env },
    encoding: "utf8",
  });

/** Approve baselines, check an unchanged run is clean, then change the theme and expect diffs */
async function visualCycle(): Promise<number> {
  let failed = 0;
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-visual-"));
  const env = { QA_VISUAL_DIR: dir };
  const outV = path.join(root, "qa-out-selftest-visual");
  const read = () => JSON.parse(fs.readFileSync(path.join(outV, "report.json"), "utf8")).results.find((r: any) => r.plugin === "web-visual");
  let server = await startServer();
  try {
    agent(["--only", "web-crawl,web-visual", "--update-visual", "--out", outV], env);
    agent(["--only", "web-crawl,web-visual", "--out", outV], env);
    const same = read();
    const ok1 = same.stats.compared > 0 && same.findings.length === 0;
    console.log(`${ok1 ? "PASS" : "FAIL"}  visual: unchanged pages match their baselines (${same.stats.compared} compared)`);
    if (!ok1) failed++;
  } finally { server.kill(); }
  await new Promise((r) => setTimeout(r, 500));
  server = await startServer({ FIXTURE_THEME: "shifted" });
  try {
    agent(["--only", "web-crawl,web-visual", "--out", outV], env);
    const changed = read();
    const hit = changed.findings.some((f: any) => f.target === "business /index.html" && f.title.startsWith("Visual change"));
    const noise = changed.findings.some((f: any) => f.target === "business /beta.html");
    console.log(`${hit ? "PASS" : "FAIL"}  visual: theme change detected on business /index.html`);
    console.log(`${noise ? "FAIL" : "PASS"}  visual: unaffected page business /beta.html not flagged`);
    if (!hit) failed++;
    if (noise) failed++;
  } finally {
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}

/** Mobile: a stand-in maestro (results + screenshot), a run with no device, and no maestro at all */
async function mobileCycle(): Promise<number> {
  let failed = 0;
  const outM = path.join(root, "qa-out-selftest-mobile");
  const check = (ok: boolean, msg: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failed++; };
  const read = () => JSON.parse(fs.readFileSync(path.join(outM, "report.json"), "utf8")).results.find((x: any) => x.plugin === "mobile");
  const bin = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-maestro-"));
  const fake = path.join(bin, "maestro");
  const argsFile = path.join(bin, "args.json");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("1.40.0"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(a));
if (process.env.FAKE_MAESTRO_NO_DEVICE) { console.error("No connected devices found. Please start an emulator."); process.exit(1); }
const out = a[a.indexOf("--output") + 1], dbg = a[a.indexOf("--debug-output") + 1];
fs.mkdirSync(path.join(dbg, "run1"), { recursive: true });
fs.writeFileSync(path.join(dbg, "run1", "screenshot-❌-1731080000-(redeem-reward).png"), Buffer.from("89504e470d0a1a0a", "hex"));
fs.writeFileSync(out, '<?xml version="1.0"?><testsuites><testsuite name="Test Suite" tests="2" failures="1">' +
  '<testcase id="login" name="login" classname="login" time="12.5"/>' +
  '<testcase id="redeem-reward" name="redeem-reward" classname="redeem-reward" time="20.1"><failure message="Assertion is false: &quot;Reward redeemed&quot; is visible"></failure></testcase>' +
  '</testsuite></testsuites>');
process.exit(1);
`, { mode: 0o755 });
  try {
    agent(["--only", "mobile", "--out", outM], { QA_MAESTRO: fake });
    let r = read();
    const f = r.findings.find((x: any) => x.target === "mobile redeem-reward");
    check(r.status === "failed" && r.stats.flows === 2 && r.stats.passed === 1, `mobile: Maestro results read (${r.status}; ${JSON.stringify(r.stats)})`);
    check(f?.severity === "high" && f.title === 'Mobile flow "redeem-reward" failed: Assertion is false: "Reward redeemed" is visible', `detects mobile: failed flow with Maestro's message (${f?.title})`);
    check(!!f?.evidence?.image && fs.existsSync(path.join(outM, f.evidence.image)), "mobile: the failure screenshot is attached");
    check(!r.findings.some((x: any) => x.target === "mobile login"), "no false positive mobile: passing flow");
    const args: string[] = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    check(args.includes("EMAIL=merchant-a@qa.test") && args.includes("APP_ID=com.mlitech.qa") && args.includes("junit"), "mobile: account logins and the app id reach the flows as variables");
    agent(["--only", "mobile", "--out", outM], { QA_MAESTRO: fake, FAKE_MAESTRO_NO_DEVICE: "1" });
    r = read();
    check(r.status === "skipped" && /no device/.test(r.reason), `mobile: no device → skipped, not failed (${r.status}: ${r.reason})`);
    agent(["--only", "mobile", "--out", outM], { QA_MAESTRO: path.join(bin, "not-installed") });
    r = read();
    check(r.status === "skipped" && /Maestro isn't installed/.test(r.reason), "mobile: without Maestro → skipped with how to install");
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
  return failed;
}

/** Business flows: a passing flow, a planted failure, a writing flow skipped, a broken file */
async function flowsCycle(): Promise<number> {
  let failed = 0;
  const outF = path.join(root, "qa-out-selftest-flows");
  const check = (ok: boolean, msg: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failed++; };
  const read = () => JSON.parse(fs.readFileSync(path.join(outF, "report.json"), "utf8")).results.find((x: any) => x.plugin === "flows");
  const server = await startServer();
  try {
    agent(["--only", "flows", "--out", outF]);
    let r = read();
    const fail = r.findings.find((f: any) => f.target === "flow Export customer report");
    check(r.status !== "errored", `flows: ran (${r.status}${r.reason ? `: ${r.reason}` : ""}; ${JSON.stringify(r.stats)})`);
    check(fail?.severity === "high" && fail.title === 'Flow "Export customer report" failed at step "Wait for the report"', `detects flows: failing flow names the step (${fail?.title})`);
    check(/system\/crash → 500/.test(fail?.detail ?? "") && !!fail?.evidence?.image && fs.existsSync(path.join(outF, fail.evidence.image)), "flows: the failure carries the server error and a screenshot");
    check(String(r.stats["View promotions"]).startsWith("passed") && !r.findings.some((f: any) => f.target.startsWith("flow View promotions")), "no false positive flows: a working flow passes");
    check(String(r.stats["Create a promotion"]).includes("allowMutations is off"), "flows: a flow that changes data is skipped without allowMutations");
    check(r.findings.some((f: any) => f.target === "flow fixture-flows/04-broken.ts" && f.title.startsWith("Flow file can't be loaded")), "flows: a broken flow file is reported, not a crash");
    agent(["--only", "flows", "--out", outF], { QA_ALLOW_MUTATIONS: "true" });
    r = read();
    check(String(r.stats["Create a promotion"]).startsWith("passed"), "flows: with allowMutations the writing flow runs");
  } finally {
    server.kill();
  }
  return failed;
}

/** Lighthouse: logged in, a page with long main-thread tasks is slow, a light one isn't */
async function lighthouseCycle(): Promise<number> {
  let failed = 0;
  const outH = path.join(root, "qa-out-selftest-lighthouse");
  const check = (ok: boolean, msg: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failed++; };
  const server = await startServer();
  try {
    agent(["--only", "lighthouse", "--out", outH]);
    const r = JSON.parse(fs.readFileSync(path.join(outH, "report.json"), "utf8")).results.find((x: any) => x.plugin === "lighthouse");
    check(r.status !== "errored", `lighthouse: ran (${r.status}${r.reason ? `: ${r.reason}` : ""}; ${JSON.stringify(r.stats)})`);
    check(r.findings.some((f: any) => f.target === "business /heavy.html" && f.title.startsWith("Slow page") && /TBT/.test(f.title)), "detects lighthouse: slow page (long tasks) @ business /heavy.html");
    check(!r.findings.some((f: any) => f.target.startsWith("business /index.html")), "no false positive lighthouse @ business /index.html");
    check(!r.findings.some((f: any) => f.title.includes("login page")), "lighthouse: measured the logged-in pages (not bounced to login)");
    check(fs.existsSync(path.join(outH, "lighthouse", "business-heavy_html.html")), "lighthouse: keeps an HTML report per page");
  } finally {
    server.kill();
  }
  return failed;
}

/** Passive security scan: built-in rules on the fixture, then a stand-in zap-baseline.py on PATH */
async function zapCycle(): Promise<number> {
  let failed = 0;
  const outZ = path.join(root, "qa-out-selftest-zap");
  const check = (ok: boolean, msg: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failed++; };
  const read = () => JSON.parse(fs.readFileSync(path.join(outZ, "report.json"), "utf8")).results.find((x: any) => x.plugin === "zap-baseline");
  const host = `127.0.0.1:${PORT}`;
  const server = await startServer();
  const bin = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-zapbin-"));
  try {
    agent(["--only", "zap-baseline", "--out", outZ], { QA_ZAP_ENGINE: "builtin" });
    let r = read();
    const has = (sev: string, title: string, target: string) => r.findings.some((f: any) => f.severity === sev && f.title.startsWith(title) && f.target === target);
    check(r.status !== "errored" && r.stats.engine === "built-in", `zap: built-in rules ran (${r.status}; ${JSON.stringify(r.stats)})`);
    const want: Array<[string, string, string]> = [
      ["critical", "Environment file (.env) is publicly readable", `${host} /.env`],
      ["medium", "Directory listing is on at /uploads/", `${host} /uploads/`],
      ["low", "Server header reveals the version", `${host} header server`],
      ["medium", "Error response reveals", `${host} error malformed JSON body`],
      ["medium", 'Login cookie "refreshToken" is missing HttpOnly, SameSite', `${host} cookie refreshToken`],
      ["medium", 'Dashboard "business" is missing security headers', "business headers"],
      ["low", 'Dashboard "business" serves source maps', "business source maps"],
    ];
    for (const [sev, title, target] of want) check(has(sev, title, target), `detects zap-baseline: ${title} @ ${target}`);
    for (const t of [`${host} /.git/HEAD`, `${host} error unknown route`, `${host} error operator object in a login field`, `${host} http`]) {
      check(!r.findings.some((f: any) => f.target === t), `no false positive zap-baseline @ ${t}`);
    }

    // A stand-in for OWASP ZAP: answers -h and writes a ZAP-format JSON report
    const report = { site: [{ "@name": `http://${host}`, alerts: [
      { pluginid: "10038", alert: "Content Security Policy (CSP) Header Not Set", riskcode: "2", desc: "<p>CSP is missing.</p>", solution: "<p>Set it.</p>", cweid: "693", instances: [{ uri: `http://${host}/web/index.html`, method: "GET" }, { uri: `http://${host}/web/login.html`, method: "GET" }, { uri: `http://${host}/web/beta.html`, method: "GET" }] },
      { pluginid: "10096", alert: "Timestamp Disclosure - Unix", riskcode: "0", instances: [{ uri: `http://${host}/health` }] },
      { pluginid: "40012", alert: "Cross Site Scripting (Reflected)", riskcode: "3", instances: [{ uri: `http://${host}/web/search`, param: "q", evidence: "<script>alert(1)</script>" }] },
    ] }] };
    fs.writeFileSync(path.join(bin, "zap-baseline.py"), `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a.includes("-h")) process.exit(0);
const j = a[a.indexOf("-J") + 1];
require("fs").writeFileSync(j, ${JSON.stringify(JSON.stringify(report))});
`, { mode: 0o755 });
    agent(["--only", "zap-baseline", "--out", outZ], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    r = read();
    check(r.stats.engine === "zap", `zap: uses OWASP ZAP when zap-baseline.py is installed (${JSON.stringify(r.stats)})`);
    check(r.findings.some((f: any) => f.severity === "medium" && f.title === "Content Security Policy (CSP) Header Not Set (3 places)" && /Fix: Set it/.test(f.detail)), "zap: ZAP alerts become findings with places and the fix");
    check(r.findings.some((f: any) => f.severity === "high" && f.title.startsWith("Cross Site Scripting")), "zap: ZAP high risk maps to high severity");
    check(!r.findings.some((f: any) => f.title.startsWith("Timestamp Disclosure")), "zap: ignored ZAP rule ids are dropped");
  } finally {
    server.kill();
    fs.rmSync(bin, { recursive: true, force: true });
  }
  return failed;
}

/** Load smoke: errors, slowness, the limiter, and a healthy route under a short burst */
async function loadCycle(): Promise<number> {
  let failed = 0;
  const outL = path.join(root, "qa-out-selftest-load");
  const check = (ok: boolean, msg: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failed++; };
  const server = await startServer();
  try {
    agent(["--only", "load-smoke", "--out", outL]);
    const r = JSON.parse(fs.readFileSync(path.join(outL, "report.json"), "utf8")).results.find((x: any) => x.plugin === "load-smoke");
    const has = (title: string, target: string) => r.findings.some((f: any) => f.title.startsWith(title) && f.target === target);
    check(r.status !== "errored", `load: plugin ran (${r.status}${r.reason ? `: ${r.reason}` : ""}; ${JSON.stringify(r.stats)})`);
    check(has("Errors under load", "GET /system/crash"), "detects load-smoke: errors under load @ GET /system/crash");
    check(has("Slow under load", "GET /system/slow"), "detects load-smoke: slow under load @ GET /system/slow");
    check(has("Rate limiter answered", "load rate limiter") && r.stats.rateLimited > 0, "load: 429s are reported separately, not as errors");
    check(!r.findings.some((f: any) => f.target === "GET /admin/stats" || f.target === "GET /system/limited"), "no false positive load-smoke: healthy and rate-limited routes");
    check(r.stats.skipped === 1, "load: route without path params is skipped with a reason");
    agent(["--only", "load-smoke", "--out", outL], { QA_LOAD_ROUTES: "GET /admin/stats" });
    const fast = JSON.parse(fs.readFileSync(path.join(outL, "report.json"), "utf8")).results.find((x: any) => x.plugin === "load-smoke");
    check(fast.stats.rps > 15 && fast.stats.rps <= 25 * 1.1 && fast.findings.length === 0, `load: a fast route is driven close to the cap but never over it (${fast.stats.rps} req/s, cap 25)`);
  } finally {
    server.kill();
  }
  return failed;
}

/** Realtime: two fixture processes without a shared adapter, then one process twice */
async function socketCycle(): Promise<number> {
  let failed = 0;
  const outS = path.join(root, "qa-out-selftest-socket");
  const a = await startServer();
  const b = await startServer({}, PORT + 1);
  const check = (ok: boolean, msg: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failed++; };
  const res = () => JSON.parse(fs.readFileSync(path.join(outS, "report.json"), "utf8")).results.find((r: any) => r.plugin === "socket-fanout");
  try {
    const urlA = `http://127.0.0.1:${PORT}`, urlB = `http://127.0.0.1:${PORT + 1}`;
    agent(["--only", "socket-fanout", "--out", outS], { QA_ALLOW_MUTATIONS: "true", QA_SOCKET_URLS: `${urlA},${urlB}` });
    let r = res();
    const has = (title: string, target?: string) => r.findings.some((f: any) => f.title.includes(title) && (!target || f.target === target));
    check(r.status !== "errored", `socket: plugin ran (${r.status}${r.reason ? `: ${r.reason}` : ""})`);
    check(has("didn't reach the socket on another instance", `socket event newNotification @ 127.0.0.1:${PORT + 1}`), "detects socket-fanout: event not shared between instances");
    check(has("sockets of one user stay open (cap 2)"), "detects socket-fanout: per-user connection cap not enforced");
    check(!has("without a token") && !has("tampered token"), "no false positive socket-fanout: token checks pass on a server that verifies tokens");
    check(r.stats.connectedInstances === 2, `socket: both instances accept the user (${r.stats.connectedInstances}; ${r.stats.fanoutChecked})`);
    check(has("Realtime event for merchantA also reached merchantB", "socket event salesActivation::* isolation"), "detects socket-fanout: event broadcast to every connection reaches another tenant");
    check(!r.findings.some((f: any) => f.target === "socket event newNotification isolation"), "no false positive socket-fanout: a per-user event doesn't count as a leak");

    agent(["--only", "socket-fanout", "--out", outS], { QA_ALLOW_MUTATIONS: "true", QA_SOCKET_URLS: `${urlA},${urlA}` });
    r = res();
    check(!r.findings.some((f: any) => f.title.includes("Event \"newNotification\"")), `no false positive socket-fanout: one instance delivers to every connection (${r.stats.fanoutChecked})`);

    agent(["--only", "socket-fanout", "--out", outS], { QA_SOCKET_URLS: `${urlA},${urlB}` });
    r = res();
    check(String(r.stats.fanoutChecked).includes("skipped") && !r.findings.some((f: any) => f.title.includes("Event")), "socket: a writing trigger is skipped without allowMutations");
  } finally {
    a.kill();
    b.kill();
  }
  await new Promise((r) => setTimeout(r, 300));
  const open = await startServer({ FIXTURE_SOCKET_OPEN: "1" });
  try {
    agent(["--only", "socket-fanout", "--out", outS], { QA_SOCKET_URLS: `http://127.0.0.1:${PORT}` });
    const r = res();
    const t = r.findings.map((f: any) => f.title);
    check(t.includes("Socket stays connected without a token") && t.includes("Socket stays connected with a tampered token"), "detects socket-fanout: server that doesn't check socket tokens");
  } finally {
    open.kill();
  }
  return failed;
}

async function main() {
  const part = process.env.SELFTEST_PART ?? "all";
  let failed = 0;
  const parts: Record<string, () => Promise<number>> = { socket: socketCycle, load: loadCycle, zap: zapCycle, lighthouse: lighthouseCycle, flows: flowsCycle, mobile: mobileCycle };
  if (parts[part]) {
    failed += await parts[part]();
    console.log(failed ? `\n${failed} self-test check(s) failed` : "\nAll self-test checks passed");
    process.exitCode = failed ? 1 : 0;
    return;
  }
  if (part === "visual") {
    failed += await visualCycle();
    console.log(failed ? `\n${failed} self-test check(s) failed` : "\nAll self-test checks passed");
    process.exitCode = failed ? 1 : 0;
    return;
  }
  const server = await startServer();
  try {
    const only = ["route-auth", "env-drift", "secrets", "health-cors", "api-auth", "api-smoke", "tenant-isolation", "web-crawl", "web-a11y", ...(process.env.SELFTEST_FUZZ === "1" ? ["api-fuzz"] : [])];
    const run = agent(["--suite", "local", "--only", only.join(","), "--out", out]);
    if (run.status === 2) throw new Error(`agent crashed:\n${run.stderr || run.stdout}`);
    const report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
    const findings: any[] = report.results.flatMap((r: any) => r.findings);
    for (const [plugin, title, target] of expected) {
      const ok = findings.some((f) => f.plugin === plugin && f.title.includes(title) && f.target === target);
      console.log(`${ok ? "PASS" : "FAIL"}  detects ${plugin}: ${title} @ ${target}`);
      if (!ok) failed++;
    }
    for (const [plugin, target] of mustNotFlag) {
      const bad = findings.find((f) => f.plugin === plugin && f.target === target);
      console.log(`${bad ? "FAIL" : "PASS"}  no false positive ${plugin} @ ${target}${bad ? ` (got: ${bad.title})` : ""}`);
      if (bad) failed++;
    }
    const errored = report.results.filter((r: any) => r.status === "errored");
    for (const e of errored) { console.log(`FAIL  plugin errored: ${e.plugin}: ${e.reason}`); failed++; }
    if (run.status !== 1) { console.log(`FAIL  gate should fail on the fixture (exit ${run.status})`); failed++; }
    else console.log("PASS  gate fails on planted critical bugs (exit 1)");
  } finally {
    server.kill();
  }
  if (part === "all") {
    await new Promise((r) => setTimeout(r, 500));
    failed += await visualCycle();
    await new Promise((r) => setTimeout(r, 500));
    failed += await socketCycle();
    await new Promise((r) => setTimeout(r, 500));
    failed += await loadCycle();
    await new Promise((r) => setTimeout(r, 500));
    failed += await zapCycle();
    await new Promise((r) => setTimeout(r, 500));
    failed += await lighthouseCycle();
    await new Promise((r) => setTimeout(r, 500));
    failed += await flowsCycle();
    failed += await mobileCycle();
  }
  console.log(failed ? `\n${failed} self-test check(s) failed` : "\nAll self-test checks passed");
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
