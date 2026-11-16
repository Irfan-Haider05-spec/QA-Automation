/**
 * Hosted runner: claims jobs from the QA platform and runs them, one at a time.
 * Run several processes (or machines) to run jobs in parallel; the platform
 * never gives two runners the same environment at once.
 *
 *   QA_PLATFORM_URL=https://qa.example.com QA_RUNNER_TOKEN=… npm start -w @qa/runner
 *
 * Env: QA_PLATFORM_URL, QA_RUNNER_TOKEN (the API's RUNNER_TOKEN), QA_RUNNER_ID
 * (default host-pid), QA_RUNNER_POLL_MS (5000), QA_JOB_TIMEOUT_MIN (20),
 * QA_RUNNER_WORKDIR, QA_RUNNER_MAX_JOBS (optional ephemeral-worker limit),
 * QA_CHROMIUM_PATH / QA_CHROMIUM_ARGS / QA_CHROMIUM_SANDBOX for dashboard checks.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlatformClient } from "./platform.js";
import { processOne } from "./loop.js";
import { defaultWorkDir } from "./job.js";
import { runnerSettings } from "./settings.js";

const url = process.env.QA_PLATFORM_URL;
const token = process.env.QA_RUNNER_TOKEN;
if (!url || !token) {
  console.error("Set QA_PLATFORM_URL and QA_RUNNER_TOKEN");
  process.exit(2);
}
const id = process.env.QA_RUNNER_ID ?? `${os.hostname()}-${process.pid}`.replace(/[^\w.:-]/g, "-").slice(0, 100);
let settings;
try { settings = runnerSettings(); }
catch (error) { console.error((error as Error).message); process.exit(2); }
const opts = {
  engineDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  workDir: process.env.QA_RUNNER_WORKDIR ?? defaultWorkDir(),
  timeoutMs: settings.timeoutMs,
};
const client = new PlatformClient(url, token, id);
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

let stopping = false;
process.on("SIGTERM", () => { stopping = true; log("stopping after the current job"); });
process.on("SIGINT", () => { stopping = true; log("stopping after the current job"); });

log(`runner ${id} polling ${url}`);
if (Number.isFinite(settings.maxJobs)) log(`worker will exit after ${settings.maxJobs} claimed job(s)`);
let completedJobs = 0;
while (!stopping) {
  try {
    const did = await processOne(client, opts, log);
    if (did) {
      completedJobs++;
      if (completedJobs >= settings.maxJobs) { stopping = true; log(`processed ${completedJobs} job(s); exiting`); }
    }
    if (!did) await new Promise((r) => setTimeout(r, settings.pollMs));
  } catch (e: any) {
    log(`error: ${e?.message ?? e}`);
    if (Number.isFinite(settings.maxJobs)) { stopping = true; log("bounded worker exiting after an uncertain job attempt"); }
    else await new Promise((r) => setTimeout(r, settings.pollMs * 2));
  }
}
