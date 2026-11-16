/** Claim one job, run it, report it. Returns false when the queue was empty. */
import type { PlatformClient } from "./platform.js";
import { runJob, type RunJobOptions } from "./job.js";
import { sendArtifacts } from "../../../src/core/upload.js";
import type { RunSummary } from "../../../src/core/report.js";

export async function processOne(client: PlatformClient, opts: Omit<RunJobOptions, "onTick">, log: (m: string) => void = () => {}): Promise<boolean> {
  const p = await client.claim();
  if (!p) return false;
  log(`job ${p.job.id}: ${p.job.suite} on ${p.project.name} / ${p.environment.name} (attempt ${p.job.attempts})`);
  let lost = false;
  let completed = false;
  const outcome = await runJob(p, {
    ...opts,
    onResult: async (outcome, outDir) => {
      if (lost || !outcome.report || outcome.cancelled) return;
      const result = await client.complete(p.job.id, { run: outcome.report });
      completed = true;
      log(`job ${p.job.id}: ${result.status}${result.runId ? ` (run ${result.runId})` : ""}`);
      if (result.runId) {
        try {
          const count = await sendArtifacts(outcome.report as RunSummary, outDir, (payload) => client.uploadArtifact(p.job.id, payload));
          await client.setEvidenceStatus(p.job.id, "complete");
          if (count) log(`job ${p.job.id}: ${count} evidence files uploaded`);
        } catch (error) {
          log(`job ${p.job.id}: evidence upload failed: ${error instanceof Error ? error.message : "unknown error"}`);
          try { await client.setEvidenceStatus(p.job.id, "failed"); }
          catch (statusError) { log(`job ${p.job.id}: evidence failure status could not be saved: ${statusError instanceof Error ? statusError.message : "unknown error"}`); }
        }
      }
    },
    onTick: async () => {
      const h = await client.heartbeat(p.job.id);
      if (h === "lost") lost = true;
      return h;
    },
  });
  if (completed) return true;
  if (lost) {
    log(`job ${p.job.id}: reassigned by the platform, result dropped`);
    return true;
  }
  const body = outcome.report && !outcome.cancelled ? { run: outcome.report } : { error: outcome.cancelled ? "Cancelled" : outcome.log || `Engine exited with code ${outcome.exitCode}` };
  const r = await client.complete(p.job.id, body);
  log(`job ${p.job.id}: ${r.status}${r.runId ? ` (run ${r.runId})` : ""}`);
  return true;
}
