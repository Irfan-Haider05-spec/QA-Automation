export interface RunnerSettings {
  pollMs: number;
  timeoutMs: number;
  maxJobs: number;
}

function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function runnerSettings(env: NodeJS.ProcessEnv = process.env): RunnerSettings {
  const maxJobs = env.QA_RUNNER_MAX_JOBS === undefined
    ? Number.POSITIVE_INFINITY
    : integerEnv(env, "QA_RUNNER_MAX_JOBS", 1, 1, 1000);
  return {
    pollMs: integerEnv(env, "QA_RUNNER_POLL_MS", 5000, 250, 300000),
    timeoutMs: integerEnv(env, "QA_JOB_TIMEOUT_MIN", 20, 1, 1440) * 60_000,
    maxJobs,
  };
}
