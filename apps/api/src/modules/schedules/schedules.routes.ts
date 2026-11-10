/**
 * Schedules: run a suite against an environment on a cron, in a time zone.
 *
 *   GET    …/projects/:projectId/schedules
 *   POST   …/projects/:projectId/schedules                  { environmentId, suite, cron, timezone, enabled }
 *   PATCH  …/projects/:projectId/schedules/:scheduleId
 *   DELETE …/projects/:projectId/schedules/:scheduleId
 *
 * The scheduler (lib/scheduler.ts) turns due schedules into jobs.
 */
import { Router } from "express";
import { z } from "zod";
import { HOSTED_SUITES } from "@qa/shared";
import { auth } from "../../middleware/auth.js";
import { conflict, handle, notFound, unprocessable, validate } from "../../lib/http.js";
import { audit, deps, loadEnvironment, loadProject, scoped } from "../../lib/context.js";
import { checkSchedule } from "../../lib/schedule.js";
import { readiness } from "../jobs/readiness.js";

export const SchedulesRouter = Router({ mergeParams: true });

const MAX_PER_PROJECT = 10;
const COLUMNS = `s.id, s.environment_id as "environmentId", e.name as "environmentName", s.suite, s.cron, s.timezone, s.enabled,
  s.next_run_at as "nextRunAt", s.last_run_at as "lastRunAt", s.last_error as "lastError", s.created_at as "createdAt",
  (select json_build_object('id', j.id, 'status', j.status, 'runId', j.run_id, 'runStatus', r.status, 'createdAt', j.created_at)
     from run_jobs j left join runs r on r.id = j.run_id where j.id = s.last_job_id) as "lastJob"`;
const FROM = "from schedules s join environments e on e.id = s.environment_id";

const zCron = z.string().trim().min(9).max(100);
const zTz = z.string().trim().min(1).max(64);

SchedulesRouter.get(
  "/",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const schedules = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      return q(`select ${COLUMNS} ${FROM} where s.project_id = $1 order by s.created_at`, [req.params.projectId]);
    });
    res.json({ schedules });
  }),
);

SchedulesRouter.post(
  "/",
  auth("owner", "admin", "developer"),
  validate({ body: z.object({ environmentId: z.string().uuid(), suite: z.enum(HOSTED_SUITES), cron: zCron, timezone: zTz.default("UTC"), enabled: z.boolean().default(true) }) }),
  handle(async (req, res) => {
    const b = req.body;
    const next = checkSchedule(b.cron, b.timezone, deps(req).config.SCHEDULE_MIN_INTERVAL_MINUTES);
    const schedule = await scoped(req, async (q) => {
      const env = await loadEnvironment(q, req, req.params.projectId, b.environmentId);
      const r = await readiness(q, req.params.projectId, env);
      if (!r.canRun) throw unprocessable(r.reasons.join(" "));
      const [{ n }] = await q<{ n: number }>("select count(*)::int as n from schedules where project_id = $1", [req.params.projectId]);
      if (n >= MAX_PER_PROJECT) throw conflict(`A project can have at most ${MAX_PER_PROJECT} schedules`);
      const [{ id }] = await q<{ id: string }>(
        `insert into schedules (org_id, project_id, environment_id, suite, cron, timezone, enabled, next_run_at, created_by)
         values (app_org(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [req.params.projectId, b.environmentId, b.suite, b.cron, b.timezone, b.enabled, b.enabled ? next : null, req.user!.id],
      );
      await audit(q, req, "schedule.created", "schedule", id, { environment: env.name, suite: b.suite, cron: b.cron, timezone: b.timezone });
      const [row] = await q(`select ${COLUMNS} ${FROM} where s.id = $1`, [id]);
      return row;
    });
    res.status(201).json({ schedule });
  }),
);

SchedulesRouter.patch(
  "/:scheduleId",
  auth("owner", "admin", "developer"),
  validate({ body: z.object({ suite: z.enum(HOSTED_SUITES).optional(), cron: zCron.optional(), timezone: zTz.optional(), enabled: z.boolean().optional() }).refine((b) => Object.keys(b).length > 0, "Nothing to change") }),
  handle(async (req, res) => {
    const schedule = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      const [cur] = await q<any>("select * from schedules where id = $1 and project_id = $2", [req.params.scheduleId, req.params.projectId]);
      if (!cur) throw notFound("Schedule");
      const v = { suite: req.body.suite ?? cur.suite, cron: req.body.cron ?? cur.cron, timezone: req.body.timezone ?? cur.timezone, enabled: req.body.enabled ?? cur.enabled };
      const next = checkSchedule(v.cron, v.timezone, deps(req).config.SCHEDULE_MIN_INTERVAL_MINUTES);
      await q(
        "update schedules set suite = $1, cron = $2, timezone = $3, enabled = $4, next_run_at = $5, last_error = case when $4 then last_error else null end, updated_at = now() where id = $6",
        [v.suite, v.cron, v.timezone, v.enabled, v.enabled ? next : null, cur.id],
      );
      await audit(q, req, "schedule.updated", "schedule", cur.id, req.body);
      const [row] = await q(`select ${COLUMNS} ${FROM} where s.id = $1`, [cur.id]);
      return row;
    });
    res.json({ schedule });
  }),
);

SchedulesRouter.delete(
  "/:scheduleId",
  auth("owner", "admin", "developer"),
  validate({}),
  handle(async (req, res) => {
    await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      const [d] = await q<{ id: string; cron: string }>("delete from schedules where id = $1 and project_id = $2 returning id, cron", [req.params.scheduleId, req.params.projectId]);
      if (!d) throw notFound("Schedule");
      await audit(q, req, "schedule.deleted", "schedule", d.id, { cron: d.cron });
    });
    res.status(204).end();
  }),
);
