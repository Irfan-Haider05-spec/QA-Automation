/** Claim one job, run it, report it. Returns false when the queue was empty. */
import type { PlatformClient } from "./platform.js";
import { runJob, type RunJobOptions } from "./job.js";

export async function processOne(client: PlatformClient, opts: Omit<RunJobOptions, "onTick">, log: (m: string) => void = () => {}): Promise<boolean> {
  const p = await client.claim();
  if (!p) return false;
  log(`job ${p.job.id}: ${p.job.suite} on ${p.project.name} / ${p.environment.name} (attempt ${p.job.attempts})`);
  let lost = false;
  const outcome = await runJob(p, {
    ...opts,
    onTick: async () => {
      const h = await client.heartbeat(p.job.id);
      if (h === "lost") lost = true;
      return h;
    },
  });
  if (lost) {
    log(`job ${p.job.id}: reassigned by the platform, result dropped`);
    return true;
  }
  const body = outcome.report && !outcome.cancelled ? { run: outcome.report } : { error: outcome.cancelled ? "Cancelled" : outcome.log || `Engine exited with code ${outcome.exitCode}` };
  const r = await client.complete(p.job.id, body);
  log(`job ${p.job.id}: ${r.status}${r.runId ? ` (run ${r.runId})` : ""}`);
  return true;
}
