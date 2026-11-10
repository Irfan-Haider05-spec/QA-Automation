/**
 * The scheduler: every SCHEDULER_INTERVAL_MS it
 *  1. tidies the job queue (retries jobs whose runner went silent, closes cancelled ones)
 *  2. turns due schedules into queued jobs and moves their next run forward
 *
 * Safe with several API instances: a schedule is only advanced by the instance
 * whose conditional update wins (next_run_at must still be the value it read).
 * Compared at millisecond precision: Postgres keeps microseconds, JS Dates don't,
 * and an exact comparison silently never matched on real Postgres.
 */
import type { Db } from "../db/index.js";
import { withContext } from "../db/index.js";
import type { Config } from "../config.js";
import { nextRun } from "./schedule.js";

export interface TickResult { enqueued: number; skipped: number; requeued: number; failed: number; cancelled: number }

export async function schedulerTick(db: Db, config: Pick<Config, "JOB_STALE_SECONDS">, now = new Date()): Promise<TickResult> {
  const [m] = await withContext(db, {}, (q) => q<{ requeued: number; failed: number; cancelled: number }>("select * from qa_maintain_jobs($1)", [config.JOB_STALE_SECONDS]));
  const due = await withContext(db, {}, (q) => q<{ id: string; org_id: string; cron: string; timezone: string; next_run_at: Date }>("select * from qa_due_schedules(100)"));
  let enqueued = 0;
  let skipped = 0;
  for (const s of due) {
    let next: Date | null;
    try { next = nextRun(s.cron, s.timezone, now); } catch { next = null; }
    await withContext(db, { orgId: s.org_id }, async (q) => {
      const [won] = await q<{ project_id: string; environment_id: string; suite: string; last_job_id: string | null }>(
        `update schedules set next_run_at = $1, last_run_at = now(), updated_at = now(), enabled = enabled and $1::timestamptz is not null
         where id = $2 and date_trunc('milliseconds', next_run_at) = date_trunc('milliseconds', $3::timestamptz) and enabled
         returning project_id, environment_id, suite, last_job_id`,
        [next, s.id, s.next_run_at],
      );
      if (!won) return; // another instance took it
      // Don't pile up: skip while this schedule's previous job is still waiting or running
      const [busy] = await q("select 1 from run_jobs where schedule_id = $1 and status in ('queued', 'running') limit 1", [s.id]);
      if (busy) {
        skipped++;
        await q("update schedules set last_error = 'Skipped: the previous run had not finished' where id = $1", [s.id]);
        return;
      }
      const [env] = await q<{ verified_at: Date | null }>("select verified_at from environments where id = $1", [won.environment_id]);
      if (!env?.verified_at) {
        skipped++;
        await q("update schedules set last_error = 'Skipped: the environment''s domain is not verified' where id = $1", [s.id]);
        return;
      }
      const [job] = await q<{ id: string }>(
        `insert into run_jobs (org_id, project_id, environment_id, schedule_id, suite, trigger_type) values (app_org(), $1, $2, $3, $4, 'schedule') returning id`,
        [won.project_id, won.environment_id, s.id, won.suite],
      );
      await q("update schedules set last_job_id = $1, last_error = null where id = $2", [job.id, s.id]);
      enqueued++;
    });
  }
  return { enqueued, skipped, requeued: m.requeued, failed: m.failed, cancelled: m.cancelled };
}

export function startScheduler(db: Db, config: Config, log: (msg: string) => void = console.log) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await schedulerTick(db, config);
      if (r.enqueued || r.requeued || r.failed) log(`scheduler: ${r.enqueued} queued, ${r.skipped} skipped, ${r.requeued} retried, ${r.failed} failed`);
    } catch (e: any) {
      log(`scheduler error: ${e?.message ?? e}`);
    } finally {
      running = false;
    }
  }, config.SCHEDULER_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
