/**
 * Tests the GitHub Action (action.yml + action/run.sh) outside GitHub:
 * builds a throwaway "customer repository" (git, a PR branch, a plain-object
 * qa.config.ts), fakes the GitHub REST API and the QA platform, and runs the
 * action's "Run QA agent" step with exactly the environment GitHub would give it.
 *
 *   npm run test:action
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { parse } from "yaml";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE_PORT = 4013;
let failed = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed++;
};

// ── action.yml is internally consistent ──────────────────────────────────────
const action = parse(fs.readFileSync(path.join(root, "action.yml"), "utf8"));
const declared = new Set(Object.keys(action.inputs));
const yamlText = fs.readFileSync(path.join(root, "action.yml"), "utf8");
const used = [...yamlText.matchAll(/inputs\.([a-z0-9-]+)/g)].map((m) => m[1]);
check(used.every((u) => declared.has(u)), `every inputs.* used in action.yml is declared (${[...new Set(used)].filter((u) => !declared.has(u)).join(", ") || "ok"})`);
const stepIds = new Set(action.runs.steps.map((s: any) => s.id).filter(Boolean));
const outRefs = Object.values<any>(action.outputs).map((o) => /steps\.([a-z0-9-]+)\.outputs/.exec(o.value)?.[1]);
check(outRefs.every((id) => id && stepIds.has(id)), "every output reads a step that exists");
const runStep = action.runs.steps.find((s: any) => s.id === "qa");
check(runStep?.run?.includes("action/run.sh"), "the Run step calls action/run.sh");
const runSh = fs.readFileSync(path.join(root, "action/run.sh"), "utf8");
for (const v of ["SUITE", "CONFIG", "BACKEND_DIR", "BASE_URL", "CHANGED_FROM", "PLATFORM_ACCOUNTS", "AFTER_DEPLOY", "OUT_DIR"]) {
  check(runStep.env[v] !== undefined && runSh.includes(v), `run.sh input ${v} is passed by action.yml`);
}

/** The Run step's env with ${{ inputs.x }} / ${{ github.workspace }} resolved like GitHub does */
function stepEnv(inputs: Record<string, string>, workspace: string) {
  const vals: Record<string, string> = Object.fromEntries(Object.entries<any>(action.inputs).map(([k, v]) => [k, String(v.default ?? "")]));
  Object.assign(vals, inputs);
  vals["github-token"] = inputs["github-token"] ?? "ghs_fake_token";
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries<string>(runStep.env)) {
    env[k] = String(v).replace(/\$\{\{\s*inputs\.([a-z0-9-]+)\s*\}\}/g, (_, n) => vals[n] ?? "").replace(/\$\{\{\s*github\.workspace\s*\}\}/g, workspace);
  }
  return env;
}

// ── fakes ────────────────────────────────────────────────────────────────────
interface Req { method: string; url: string; auth?: string; body: any }
function fakeServer(handler: (r: Req, res: http.ServerResponse) => void) {
  const log: Req[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const r: Req = { method: req.method!, url: req.url!, auth: req.headers.authorization, body: data ? JSON.parse(data) : undefined };
      log.push(r);
      handler(r, res);
    });
  });
  return new Promise<{ url: string; log: Req[]; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log, close: () => server.close() })),
  );
}
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

const comments: Array<{ id: number; body: string }> = [{ id: 1, body: "Looks good to me" }];
let statusCode = 201;
const github = await fakeServer((r, res) => {
  if (r.auth !== "Bearer ghs_fake_token") return json(res, 401, { message: "Bad credentials" });
  if (r.method === "GET" && /\/issues\/7\/comments/.test(r.url)) return json(res, 200, comments);
  if (r.method === "POST" && /\/issues\/7\/comments$/.test(r.url)) { comments.push({ id: comments.length + 1, body: r.body.body }); return json(res, 201, {}); }
  const m = /\/issues\/comments\/(\d+)$/.exec(r.url);
  if (r.method === "PATCH" && m) { comments.find((c) => c.id === Number(m[1]))!.body = r.body.body; return json(res, 200, {}); }
  if (r.method === "POST" && /\/statuses\//.test(r.url)) return json(res, statusCode, statusCode < 300 ? {} : { message: "Resource not accessible by integration" });
  json(res, 404, { message: "Not Found" });
});

const KEY = "qak_test_key";
const ENV_ID = "11111111-1111-4111-8111-111111111111";
const platform = await fakeServer((r, res) => {
  if (r.auth !== `Bearer ${KEY}`) return json(res, 401, { error: { message: "Invalid or revoked API key" } });
  if (r.method === "GET" && r.url === `/api/v1/runner/environments/${ENV_ID}/credentials`) {
    return json(res, 200, { credentials: [
      { name: "merchantA", role: "MERCHANT", identifier: "merchant-a@qa.test", device: "merchant", secret: "QaPass#1" },
      { name: "merchantB", role: "MERCHANT", identifier: "merchant-b@qa.test", device: "merchant", secret: "QaPass#2" },
      { name: "admin", role: "SUPER_ADMIN", identifier: "admin@qa.test", device: "admin", secret: "QaPass#4" },
    ] });
  }
  if (r.method === "POST" && r.url === "/api/v1/runner/deployments") return json(res, 201, { deployment: { id: "22222222-2222-4222-8222-222222222222" } });
  if (r.method === "POST" && r.url === "/api/v1/runner/runs") return json(res, 201, { runId: "33333333-3333-4333-8333-333333333333", status: r.body.gate.passed ? "passed" : "failed", newIssues: 2, fixedIssues: 0, reopenedIssues: 0, orgId: "o", projectId: "p", runUrl: "https://qa.example.com/o/o/projects/p/runs/33333333" });
  json(res, 404, { error: { message: "no route" } });
});

// ── the customer's repository ────────────────────────────────────────────────
const ws = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-action-ws-"));
const git = (...args: string[]) => spawnSync("git", ["-C", ws, ...args], { encoding: "utf8" });
fs.cpSync(path.join(root, "test/fixture-api"), path.join(ws, "backend"), { recursive: true });
// A plain object: customers can't import the agent's defineConfig from their repo
fs.writeFileSync(path.join(ws, "qa.config.ts"), `export default {
  project: "Shop API",
  backend: { dir: "backend", routesIndex: "src/app/routes/index.ts", appFile: "src/app.ts", apiPrefix: "/api/v1", healthPath: "/health", envExample: ".env.example", modulesDir: "src/app/modules" },
  target: { requestsPerMinute: 1200, timeoutMs: 8000 },
  accounts: {
    merchantA: { identifier: process.env.QA_MERCHANT_A_ID, password: process.env.QA_MERCHANT_A_PASS, role: "MERCHANT", device: "merchant" },
    merchantB: { identifier: process.env.QA_MERCHANT_B_ID, password: process.env.QA_MERCHANT_B_PASS, role: "MERCHANT", device: "merchant" },
  },
  publicRoutes: ["GET /health", "POST /auth/login"],
  privilegedPrefixes: ["/admin", "/report-analytics"],
  globalPaths: ["src/app.ts"],
  suites: { pr: ["route-auth", "api-auth"], staging: ["api-auth"], nightly: ["route-auth"], local: ["route-auth"] },
  knownIssuesFile: "qa-known-issues.json",
};
`);
git("init", "-q", "-b", "main");
git("config", "user.email", "ci@example.com");
git("config", "user.name", "CI");
git("add", "-A");
git("commit", "-q", "-m", "initial");
git("checkout", "-q", "-b", "feature/admin");
const touched = fs.readdirSync(path.join(ws, "backend/src/app/modules"), { recursive: true }).map(String).find((f) => /^admin\/.*route/i.test(f.replace(/\\/g, "/")));
const touchedPath = path.join(ws, "backend/src/app/modules", touched!);
fs.appendFileSync(touchedPath, "\n// changed in this PR\n");
git("commit", "-qam", "change admin routes");
// GitHub's "origin/<base>" ref, as checkout with fetch-depth: 0 provides it
git("update-ref", "refs/remotes/origin/main", "main");

// ── run the step ─────────────────────────────────────────────────────────────
interface StepRun { code: number | null; stdout: string; outputs: Record<string, string>; summary: string }
// Async on purpose: the fake GitHub and platform servers live in this process and must keep answering
async function runStep_(inputs: Record<string, string>, event: { name: string; payload: unknown; sha: string; baseRef?: string; headRef?: string }): Promise<StepRun> {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-action-run-"));
  const files = { out: path.join(tmp, "output"), summary: path.join(tmp, "summary"), event: path.join(tmp, "event.json") };
  fs.writeFileSync(files.out, "");
  fs.writeFileSync(files.event, JSON.stringify(event.payload));
  const env: Record<string, string> = {
    PATH: process.env.PATH!, HOME: process.env.HOME ?? tmp,
    GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/shop", GITHUB_EVENT_NAME: event.name, GITHUB_EVENT_PATH: files.event,
    GITHUB_SHA: event.sha, GITHUB_REF_NAME: event.headRef ?? "main", GITHUB_HEAD_REF: event.headRef ?? "", GITHUB_BASE_REF: event.baseRef ?? "",
    GITHUB_RUN_ID: "987", GITHUB_SERVER_URL: "https://github.com", GITHUB_API_URL: github.url,
    GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: files.out, GITHUB_STEP_SUMMARY: files.summary, GITHUB_ACTION_PATH: root,
    ...stepEnv(inputs, ws),
  };
  const child = spawn("bash", [path.join(root, "action/run.sh")], { cwd: root, env });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const outputs = Object.fromEntries(fs.readFileSync(files.out, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { code, stdout, outputs, summary: fs.existsSync(files.summary) ? fs.readFileSync(files.summary, "utf8") : "" };
}
const gateFails = (o: Record<string, string>, inputs: Record<string, string>) => (inputs["fail-on-gate"] ?? "true") === "true" && o.code !== "0";

const fixture = spawn(process.execPath, ["--import", "tsx", path.join(root, "test/fixture-api/src/server.ts")], { env: { ...process.env, PORT: String(FIXTURE_PORT), CLIENT_URL: "http://localhost:5173" }, stdio: "ignore" });
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${FIXTURE_PORT}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const base = { "base-url": `http://127.0.0.1:${FIXTURE_PORT}`, "platform-url": platform.url, "platform-api-key": KEY, "platform-environment": ENV_ID, "platform-accounts": "true" };
  const pr = { name: "pull_request", payload: { pull_request: { number: 7, head: { sha: "headsha1234567" }, base: { ref: "main" } } }, sha: "mergesha999", baseRef: "main", headRef: "feature/admin" };

  // 1. Pull request
  const r1 = await runStep_(base, pr);
  if (r1.outputs.code !== "1") console.log(r1.stdout.slice(-3000));
  check(r1.code === 0, "run.sh itself always exits 0 (the Quality gate step decides)");
  check(r1.outputs.code === "1", `PR run: gate fails on the fixture's planted bugs (code=${r1.outputs.code})`);
  check(gateFails(r1.outputs, base), "PR run: the Quality gate step would fail the job");
  check(r1.outputs["report-dir"] === path.join(ws, "qa-out") && fs.existsSync(path.join(ws, "qa-out/report.html")), "PR run: report written to the workspace and exposed as report-dir");
  check(r1.outputs["run-url"] === "https://qa.example.com/o/o/projects/p/runs/33333333", "PR run: run-url output from the platform");
  check(/--changed-from origin\/main/.test(r1.stdout), "PR run: diffs against the PR's base branch");
  const up1 = platform.log.find((x) => x.url === "/api/v1/runner/runs")!.body;
  check(up1.trigger === "pr" && up1.git.pr === "7" && up1.git.sha === "headsha1234567" && up1.git.repo === "acme/shop" && up1.git.ciUrl === "https://github.com/acme/shop/actions/runs/987", "PR run: upload carries trigger, PR, head commit, repo and job link");
  check(up1.environmentId === ENV_ID && up1.source === "ci", "PR run: upload linked to the environment, source ci");
  check(up1.routesSelected < up1.routesTotal, `PR run: only the routes the PR touches (${up1.routesSelected}/${up1.routesTotal})`);
  check(platform.log.some((x) => x.url.endsWith("/credentials")), "PR run: test accounts fetched from the platform");
  check(r1.stdout.includes("::add-mask::QaPass#1") && r1.stdout.split("QaPass#1").length === 2, "PR run: fetched passwords are masked and never printed otherwise");
  check(/Test accounts from the platform: merchantA, merchantB, admin/.test(r1.stdout), "PR run: platform accounts filled the config");
  check(/::error file=backend\/src\/[^,]+,line=\d+,title=QA /.test(r1.stdout), "PR run: inline annotations point at files relative to the repo root");
  check(r1.summary.includes("<!-- qa-agent-report -->") && r1.summary.includes("Open this run on the QA platform"), "PR run: job summary with a link to the platform");
  const mine = comments.filter((c) => c.body.includes("<!-- qa-agent-report -->"));
  check(mine.length === 1 && mine[0].body.includes("https://qa.example.com/o/o/projects/p/runs/33333333"), "PR run: one PR comment, linking to the run");
  const st = github.log.find((x) => x.url.includes("/statuses/"))!;
  check(st.url.endsWith("/statuses/headsha1234567") && st.body.state === "failure" && st.body.context === "QA gate" && st.body.target_url.includes("qa.example.com"), "PR run: QA gate status on the PR's head commit, linking to the run");

  // 2. Next push to the same PR updates the comment instead of adding one
  github.log.length = 0;
  await runStep_(base, pr);
  check(comments.filter((c) => c.body.includes("<!-- qa-agent-report -->")).length === 1 && github.log.some((x) => x.method === "PATCH"), "second PR run: the same comment is updated");

  // 3. After a staging deploy
  platform.log.length = 0;
  github.log.length = 0;
  const deployInputs = { ...base, suite: "staging", "after-deploy": "true", "deploy-version": "v2.0.1" };
  const r3 = await runStep_(deployInputs, { name: "push", payload: {}, sha: "deploysha42", headRef: "staging" });
  const dep = platform.log.find((x) => x.url === "/api/v1/runner/deployments");
  const up3 = platform.log.find((x) => x.url === "/api/v1/runner/runs")?.body;
  check(dep?.body.version === "v2.0.1" && dep.body.sha === "deploysha42" && dep.body.environmentId === ENV_ID, "deploy run: deployment reported with version, commit and environment");
  check(platform.log.indexOf(dep!) < platform.log.findIndex((x) => x.url === "/api/v1/runner/runs"), "deploy run: deployment reported before the run");
  check(up3?.trigger === "deploy" && up3.deploymentId === "22222222-2222-4222-8222-222222222222", "deploy run: run linked to the deployment, trigger deploy");
  check(!github.log.some((x) => x.url.includes("/comments")), "deploy run: no PR, no comment");
  check(github.log.some((x) => x.url.endsWith("/statuses/deploysha42")), "deploy run: status on the deployed commit");
  check(!/--changed-from/.test(r3.stdout), "deploy run: no diff outside a PR (all routes)");

  // 4. Comment and status switched off; GitHub's 403 on status is a warning only
  github.log.length = 0;
  await runStep_({ ...base, comment: "false", "commit-status": "false" }, pr);
  check(github.log.length === 0, "comment=false, commit-status=false: no GitHub API calls");
  statusCode = 403;
  const r5 = await runStep_({ ...base, comment: "false" }, pr);
  check(r5.outputs.code === "1" && /Commit status failed: .*403.*permission/.test(r5.stdout), "missing statuses permission: warning, exit code unchanged");
  statusCode = 201;

  // 5. Usage problems
  const r6 = await runStep_({ ...base, config: "missing.config.ts" }, pr);
  check(r6.outputs.code === "2" && /::error title=QA Agent::Config not found/.test(r6.stdout), "missing config: code 2 with an error annotation");
  const r7 = await runStep_({ "base-url": base["base-url"], "platform-url": platform.url }, pr);
  check(/Set both platform-url and platform-api-key/.test(r7.stdout) && r7.outputs.code === "1", "URL without key: warning, run still happens, nothing uploaded");
  const r8 = await runStep_({ ...base, "changed-from": "origin/does-not-exist" }, pr);
  check(/Couldn't diff against origin\/does-not-exist/.test(r8.stdout) && r8.outputs.code === "1", "unknown diff base: warning, falls back to all routes");
  const r9 = await runStep_({ ...base, "fail-on-gate": "false" }, pr);
  check(r9.outputs.code === "1" && !gateFails(r9.outputs, { "fail-on-gate": "false" }), "fail-on-gate=false: job doesn't fail");
  const r10 = await runStep_({ ...base, "platform-api-key": "qak_wrong" }, pr);
  check(/Test accounts|platform answered 401/.test(r10.stdout) && r10.outputs.code === "2", "wrong API key with platform-accounts: stops with a clear 401 (code 2)");

  // 6. The files the dashboard's CI setup tab generates are valid
  const ci = await import("../apps/dashboard/src/lib/ci.js");
  const genDir = path.join(ws, "generated");
  fs.mkdirSync(path.join(genDir, ".github/workflows"), { recursive: true });
  fs.cpSync(path.join(root, "test/fixture-api"), genDir, { recursive: true });
  fs.writeFileSync(path.join(genDir, "qa.config.ts"), ci.configTs({ projectName: "Generated", stack: "node-express", accounts: [{ name: "merchantA", role: "MERCHANT" }, { name: "merchantB", role: "MERCHANT" }] }));
  const gen = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "src/cli.ts"), "run", "-c", path.join(genDir, "qa.config.ts"), "--suite", "local", "--out", path.join(genDir, "qa-out")], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" } });
  const found = Number((gen.stdout + gen.stderr).match(/(\d+) routes discovered/)?.[1] ?? 0);
  check(gen.status === 1 && found >= 19, `generated qa.config.ts loads and finds the routes (exit ${gen.status}, ${found} routes)`);
  for (const [name, opts] of [["full", { environmentId: ENV_ID, stagingBranch: "release/staging", platformAccounts: true }], ["pr-only", { environmentId: null, stagingBranch: "staging", platformAccounts: false }]] as const) {
    const y = ci.workflowYaml({ platformUrl: "https://qa.example.com", actionRef: "acme/qa-agent@v1", ...opts });
    const doc = parse(y);
    check(doc.jobs.pr && (name === "full" ? doc.jobs.staging && doc.on.push.branches[0] === "release/staging" : !doc.jobs.staging), `generated workflow (${name}) has the right jobs`);
    const withs = Object.values<any>(doc.jobs).flatMap((j) => j.steps.filter((st: any) => st.uses === "acme/qa-agent@v1").map((st: any) => st.with));
    check(withs.length && withs.every((w) => Object.keys(w).every((k) => declared.has(k))), `generated workflow (${name}) only uses inputs the action declares`);
    const actionlint = process.env.ACTIONLINT;
    if (actionlint && fs.existsSync(actionlint)) {
      const f = path.join(genDir, ".github/workflows", `qa-${name}.yml`);
      fs.writeFileSync(f, y);
      const lint = spawnSync(actionlint, [f], { encoding: "utf8" });
      check(lint.status === 0, `generated workflow (${name}) passes actionlint ${lint.stdout.trim()}`);
    }
  }

  // ── The MLITech integration kit (integrations/mlitech) ──
  const kit = path.join(root, "integrations/mlitech");
  const kitDoc = parse(fs.readFileSync(path.join(kit, "qa.yml"), "utf8"));
  const kitWiths = Object.values<any>(kitDoc.jobs).flatMap((j) => j.steps.filter((st: any) => st.uses === "./.qa-agent").map((st: any) => st.with));
  check(kitWiths.length === 2 && kitWiths.every((w) => Object.keys(w).every((k) => declared.has(k))), "MLITech workflow uses the action in both jobs, only with declared inputs");
  check(kitDoc.jobs.pr.env.QA_ALLOW_MUTATIONS === "true" && !kitDoc.jobs.staging.env?.QA_ALLOW_MUTATIONS, "MLITech workflow allows write requests only on the throwaway PR backend");
  check(kitWiths[1]["platform-accounts"] === "true" && !JSON.stringify(kitDoc.jobs.staging).includes("_PASS"), "MLITech staging takes passwords from the platform, none from GitHub");
  const kitCfg = (await import(path.join(kit, "qa.config.ts"))).default;
  check(kitCfg.backend.dir === "." && kitCfg.allowMutations === false && ["merchantA", "merchantB", "customer", "admin"].every((a) => a in kitCfg.accounts), "MLITech qa.config.ts: repo-root backend, read-only by default, the four account names");
  const actionlintKit = process.env.ACTIONLINT;
  if (actionlintKit && fs.existsSync(actionlintKit)) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qa-kit-"));
    fs.mkdirSync(path.join(repo, ".github/workflows"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".qa-agent"));
    fs.copyFileSync(path.join(kit, "qa.yml"), path.join(repo, ".github/workflows/qa.yml"));
    fs.copyFileSync(path.join(root, "action.yml"), path.join(repo, ".qa-agent/action.yml"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const lint = spawnSync(actionlintKit, [], { cwd: repo, encoding: "utf8" });
    check(lint.status === 0, `MLITech workflow passes actionlint (with the action's inputs) ${lint.stdout.trim()}`);
    fs.rmSync(repo, { recursive: true, force: true });
  }
} finally {
  fixture.kill();
  github.close();
  platform.close();
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} action check(s) failed` : "\nAll action checks passed");
process.exit(failed ? 1 : 0);
