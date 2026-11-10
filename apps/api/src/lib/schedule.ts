/**
 * Cron schedules: validation and next-run computation, in the schedule's time zone.
 */
import { CronExpressionParser } from "cron-parser";
import { badRequest } from "./http.js";

export function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Next run after `from`. Throws 400 with a readable message for bad input. */
export function nextRun(cron: string, timezone: string, from = new Date()): Date {
  return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone }).next().toDate();
}

/** Validates a schedule and returns its next run; refuses schedules that run more often than minMinutes */
export function checkSchedule(cron: string, timezone: string, minMinutes: number, from = new Date()): Date {
  if (!validTimezone(timezone)) throw badRequest(`Unknown time zone "${timezone}"`);
  if (cron.trim().split(/\s+/).length !== 5) throw badRequest("Use a 5-field cron expression: minute hour day-of-month month day-of-week");
  let it;
  try {
    it = CronExpressionParser.parse(cron, { currentDate: from, tz: timezone });
  } catch (e: any) {
    throw badRequest(`Invalid cron expression: ${e?.message ?? e}`);
  }
  const times = Array.from({ length: 24 }, () => it.next().toDate().getTime());
  const gap = Math.min(...times.slice(1).map((t, i) => t - times[i]));
  if (gap < minMinutes * 60_000) throw badRequest(`Runs can't be closer together than ${minMinutes} minutes (this schedule runs every ${Math.round(gap / 60_000)} min)`);
  return new Date(times[0]);
}
