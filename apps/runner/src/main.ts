/**
 * Hosted runner: claims jobs from the QA platform and runs them, one at a time.
 * Run several processes (or machines) to run jobs in parallel; the platform
 * never gives two runners the same environment at once.
 *
 *   QA_PLATFORM_URL=https://qa.example.com QA_RUNNER_TOKEN=… npm start -w @qa/runner
 *
 * Env: QA_PLATFORM_URL, QA_RUNNER_TOKEN (the API's RUNNER_TOKEN), QA_RUNNER_ID
 * (default host-pid), QA_RUNNER_POLL_MS (5000), QA_JOB_TIMEOUT_MIN (20),
 * QA_RUNNER_WORKDIR, QA_CHROMIUM_PATH / QA_CHROMIUM_ARGS for the dashboard checks.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlatformClient } from "./platform.js";
import { processOne } from "./loop.js";
import { defaultWorkDir } from "./job.js";

const url = process.env.QA_PLATFORM_URL;
const token = process.env.QA_RUNNER_TOKEN;
if (!url || !token) {
  console.error("Set QA_PLATFORM_URL and QA_RUNNER_TOKEN");
  process.exit(2);
}
const id = process.env.QA_RUNNER_ID ?? `${os.hostname()}-${process.pid}`.replace(/[^\w.:-]/g, "-").slice(0, 100);
const pollMs = Number(process.env.QA_RUNNER_POLL_MS ?? 5000);
const opts = {
  engineDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  workDir: process.env.QA_RUNNER_WORKDIR ?? defaultWorkDir(),
  timeoutMs: Number(process.env.QA_JOB_TIMEOUT_MIN ?? 20) * 60_000,
};
const client = new PlatformClient(url, token, id);
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

let stopping = false;
process.on("SIGTERM", () => { stopping = true; log("stopping after the current job"); });
process.on("SIGINT", () => { stopping = true; log("stopping after the current job"); });

log(`runner ${id} polling ${url}`);
while (!stopping) {
  try {
    const did = await processOne(client, opts, log);
    if (!did) await new Promise((r) => setTimeout(r, pollMs));
  } catch (e: any) {
    log(`error: ${e?.message ?? e}`);
    await new Promise((r) => setTimeout(r, pollMs * 2));
  }
}
