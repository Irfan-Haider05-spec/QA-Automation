/**
 * One hosted job: turn the platform's claim payload into an engine config,
 * run the engine in a throwaway folder, report the result.
 *
 * Secrets: test-account passwords reach the engine only through environment
 * variables of its child process. The files written to the job folder hold no
 * secrets, and the folder is deleted afterwards.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOSTED_PLUGINS, type HostedSuite, type ProjectProfile } from "@qa/shared";

export interface ClaimPayload {
  job: { id: string; suite: HostedSuite; trigger: "manual" | "schedule" | "deploy"; attempts: number };
  project: { id: string; name: string };
  environment: { id: string; name: string; apiBaseUrl: string | null; webApps: Array<{ name: string; baseUrl: string; loginPath: string }>; disposable: boolean; domain: string | null };
  profile: ProjectProfile | null;
  checks: { api: boolean; web: boolean };
  accounts: Array<{ name: string; role: string; identifier: string; device: string | null; secret: string }>;
}

/** Hosted runs stay gentle on customer environments whatever the profile says */
export const MAX_REQUESTS_PER_MINUTE = 120;

export function pluginsFor(p: ClaimPayload): string[] {
  const set = HOSTED_PLUGINS[p.job.suite];
  const api = p.checks.api && p.profile ? set.api : [];
  const web = p.checks.web ? set.web : [];
  return [...api, ...web, ...(api.length || web.length ? set.any : [])];
}

/** Engine config (no secrets) + the env vars that carry the account logins */
export function buildConfig(p: ClaimPayload, dir: string) {
  const prof = p.profile;
  const plugins = pluginsFor(p);
  const env: Record<string, string> = {};
  const accounts: Record<string, { identifierEnv: string; passwordEnv: string; role: string; device: string }> = {};
  p.accounts.forEach((a, i) => {
    env[`QA_HOSTED_${i}_ID`] = a.identifier;
    env[`QA_HOSTED_${i}_PASS`] = a.secret;
    accounts[a.name] = { identifierEnv: `QA_HOSTED_${i}_ID`, passwordEnv: `QA_HOSTED_${i}_PASS`, role: a.role, device: a.device ?? prof?.accounts[a.name]?.device ?? "" };
  });
  const names = Object.keys(accounts);
  // Owner/attacker from the profile if those accounts exist here; else the first two accounts
  const ti = prof?.tenantIsolation;
  const owner = ti && accounts[ti.owner] ? ti.owner : names[0] ?? "owner";
  const attacker = ti && accounts[ti.attacker] ? ti.attacker : names.find((n) => n !== owner) ?? "attacker";
  const profApps = new Map((prof?.web.apps ?? []).map((a) => [a.name, a]));
  const config = {
    project: p.project.name,
    backend: { dir, routesIndex: "(profile)", apiPrefix: prof?.apiPrefix ?? "", healthPath: prof?.healthPath ?? "/health", envExample: ".env.example", modulesDir: "." },
    target: {
      baseUrl: p.environment.apiBaseUrl ?? undefined,
      requestsPerMinute: MAX_REQUESTS_PER_MINUTE,
      timeoutMs: 15000,
      slowMs: 2000,
      pathParams: prof?.pathParams ?? {},
    },
    ...(prof ? { login: prof.login } : {}),
    accounts,
    publicRoutes: prof?.publicRoutes ?? [],
    privilegedPrefixes: prof?.privilegedPrefixes ?? [],
    tenantIsolation: { sharedResources: [], pairs: [], maxIdsPerRoute: 3, ...(ti ?? {}), owner, attacker },
    ...(prof ? { cors: prof.cors } : {}),
    suites: { pr: [], local: [], staging: plugins, nightly: plugins },
    gate: { failOn: prof?.gateFailOn ?? "high" },
    // Write requests only where the customer marked the database as disposable
    allowMutations: p.environment.disposable,
    knownIssuesFile: path.join(dir, "known-issues.json"),
    // Load smoke stays within the hosted request budget (120/min = 2 requests/s)
    load: { vus: 2, durationSec: 30, rampSec: 0, maxRps: MAX_REQUESTS_PER_MINUTE / 60, maxRoutes: 8 },
    // Built-in passive rules only on hosted runners (no ZAP install, no Docker)
    zap: { engine: "builtin" },
    lighthouse: { maxPages: 2 },
    web: {
      slowMs: prof?.web.slowMs ?? 3000,
      ignoreConsole: prof?.web.ignoreConsole ?? [],
      apps: p.environment.webApps.map((w) => {
        const pa = profApps.get(w.name);
        return {
          name: w.name,
          baseUrl: w.baseUrl,
          loginPath: w.loginPath || pa?.loginPath || "/login",
          account: pa && accounts[pa.account] ? pa.account : names[0] ?? "",
          seedRoutes: pa?.seedRoutes ?? ["/"],
          excludePaths: pa?.excludePaths ?? ["*logout*", "*delete*", "*remove*"],
          maxPages: Math.min(pa?.maxPages ?? 40, 60),
          ...(pa?.selectors ? { selectors: pa.selectors } : {}),
        };
      }),
    },
  };
  return { config, env, plugins };
}

/** Loader the engine imports: reads the JSON config and fills logins from env vars */
const CONFIG_MODULE = `import fs from "node:fs";
const c = JSON.parse(fs.readFileSync(new URL("./hosted.json", import.meta.url), "utf8"));
for (const a of Object.values(c.accounts)) {
  a.identifier = process.env[a.identifierEnv];
  a.password = process.env[a.passwordEnv];
  delete a.identifierEnv;
  delete a.passwordEnv;
}
export default c;
`;

export interface RunOutcome {
  /** The engine's report.json, when it produced one */
  report: unknown | null;
  exitCode: number | null;
  /** Last lines of the engine's output (secrets masked), for errors */
  log: string;
  cancelled: boolean;
}

export interface RunJobOptions {
  engineDir: string;
  workDir: string;
  timeoutMs: number;
  /** Polled while the engine runs; return "cancel" or "lost" to stop it */
  onTick?: () => Promise<"ok" | "cancel" | "lost">;
  tickMs?: number;
  extraEnv?: Record<string, string>;
}

export async function runJob(p: ClaimPayload, o: RunJobOptions): Promise<RunOutcome> {
  fs.mkdirSync(o.workDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(o.workDir, `job-${p.job.id.slice(0, 8)}-`));
  try {
    const { config, env, plugins } = buildConfig(p, dir);
    if (!plugins.length) return { report: null, exitCode: null, log: "Nothing to test on this environment", cancelled: false };
    fs.writeFileSync(path.join(dir, "hosted.json"), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(dir, "qa.config.mjs"), CONFIG_MODULE);
    fs.writeFileSync(path.join(dir, "routes.json"), JSON.stringify(p.profile?.routes ?? []));
    const out = path.join(dir, "out");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(o.engineDir, "src/cli.ts"), "run", "-c", path.join(dir, "qa.config.mjs"), "--suite", p.job.suite, "--out", out, "--routes-file", path.join(dir, "routes.json")],
      {
        cwd: o.engineDir,
        // A clean environment: nothing from the runner host leaks into the engine except what it needs
        env: {
          PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir, NODE_ENV: "production",
          ...(process.env.QA_CHROMIUM_PATH ? { QA_CHROMIUM_PATH: process.env.QA_CHROMIUM_PATH } : {}),
          ...(process.env.QA_CHROMIUM_ARGS ? { QA_CHROMIUM_ARGS: process.env.QA_CHROMIUM_ARGS } : {}),
          ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
          ...o.extraEnv,
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const secrets = p.accounts.map((a) => a.secret).filter((s) => s.length >= 3);
    const lines: string[] = [];
    const collect = (d: Buffer) => {
      let text = d.toString();
      for (const s of secrets) text = text.split(s).join("***");
      lines.push(...text.split("\n").filter(Boolean));
      if (lines.length > 300) lines.splice(0, lines.length - 300);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let cancelled = false;
    let stopReason = "";
    const stop = (why: string) => {
      if (stopReason) return;
      stopReason = why;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000).unref();
    };
    const timeout = setTimeout(() => stop(`Stopped after ${Math.round(o.timeoutMs / 60000)} min (job time limit)`), o.timeoutMs);
    const ticker = o.onTick
      ? setInterval(async () => {
          try {
            const t = await o.onTick!();
            if (t === "cancel") { cancelled = true; stop("Cancelled"); }
            if (t === "lost") stop("The platform reassigned this job");
          } catch { /* a missed heartbeat is retried on the next tick */ }
        }, o.tickMs ?? 15000)
      : undefined;
    const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
    clearTimeout(timeout);
    if (ticker) clearInterval(ticker);

    const reportFile = path.join(out, "report.json");
    const report = !stopReason && fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : null;
    if (stopReason) lines.push(stopReason);
    return { report, exitCode, log: lines.slice(-40).join("\n"), cancelled };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const defaultWorkDir = () => path.join(os.tmpdir(), "qa-runner");
