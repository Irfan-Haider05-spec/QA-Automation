import { test } from "node:test";
import assert from "node:assert/strict";
import { runnerSettings } from "../src/settings.js";
import { chromiumLaunchOptions } from "../../../src/web/browser-options.js";

test("explicit browser sandbox cannot be silently disabled by conflicting flags", () => {
  assert.equal(chromiumLaunchOptions({ QA_CHROMIUM_SANDBOX: "true" }).chromiumSandbox, true);
  assert.equal(chromiumLaunchOptions({}).chromiumSandbox, undefined);
  assert.throws(() => chromiumLaunchOptions({ QA_CHROMIUM_SANDBOX: "yes" }), /must be exactly/);
  assert.throws(() => chromiumLaunchOptions({ QA_CHROMIUM_SANDBOX: "true", QA_CHROMIUM_ARGS: "--no-sandbox --disable-dev-shm-usage" }), /conflicts/);
  assert.throws(() => chromiumLaunchOptions({ QA_CHROMIUM_SANDBOX: "true", QA_CHROMIUM_ARGS: "--no-sandbox=true" }), /conflicts/);
});

test("runner settings use safe defaults and parse bounded worker count", () => {
  assert.deepEqual(runnerSettings({}), { pollMs: 5000, timeoutMs: 20 * 60_000, maxJobs: Number.POSITIVE_INFINITY });
  assert.deepEqual(runnerSettings({ QA_RUNNER_POLL_MS: "250", QA_JOB_TIMEOUT_MIN: "1", QA_RUNNER_MAX_JOBS: "1" }), { pollMs: 250, timeoutMs: 60_000, maxJobs: 1 });
});

test("runner settings reject malformed and out-of-range poll, timeout and max-job inputs", () => {
  for (const [name, value] of [
    ["QA_RUNNER_POLL_MS", "0"], ["QA_RUNNER_POLL_MS", "nope"], ["QA_RUNNER_POLL_MS", "300001"],
    ["QA_JOB_TIMEOUT_MIN", "0"], ["QA_JOB_TIMEOUT_MIN", "1.5"], ["QA_JOB_TIMEOUT_MIN", "1441"],
    ["QA_RUNNER_MAX_JOBS", "0"], ["QA_RUNNER_MAX_JOBS", "1.5"], ["QA_RUNNER_MAX_JOBS", "1001"],
  ]) assert.throws(() => runnerSettings({ [name]: value }), new RegExp(name));
});
