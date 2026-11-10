/**
 * Issues inbox: one issue per fingerprint across runs. Triage = assign, accept as
 * known (optionally until a date), ignore with a reason, or reopen.
 * "fixed" is set by runs, not by people.
 */
import { Router } from "express";
import { z } from "zod";
import { SeveritySchema } from "@qa/shared";
import { auth } from "../../middleware/auth.js";
import { badRequest, handle, notFound, query, validate } from "../../lib/http.js";
import { audit, loadProject, scoped } from "../../lib/context.js";

export const IssuesRouter = Router({ mergeParams: true });

const ISSUE_COLUMNS = `i.id, i.fingerprint, i.plugin, i.severity, i.category, i.title, i.target, i.status, i.status_reason as "statusReason", i.status_until as "statusUntil",
  i.assignee_id as "assigneeId", u.name as "assigneeName", i.first_seen_at as "firstSeenAt", i.last_seen_at as "lastSeenAt", i.occurrences,
  i.first_seen_run_id as "firstSeenRunId", i.last_seen_run_id as "lastSeenRunId"`;

IssuesRouter.get(
  "/",
  auth(),
  validate({
    query: z.object({
      status: z.enum(["open", "known", "ignored", "fixed", "all"]).default("open"),
      severity: SeveritySchema.optional(),
      plugin: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  }),
  handle(async (req, res) => {
    const f = query<{ status: string; severity?: string; plugin?: string; limit: number }>(req);
    const out = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      const issues = await q(
        `select ${ISSUE_COLUMNS} from issues i left join users u on u.id = i.assignee_id
         where i.project_id = $1 and ($2 = 'all' or i.status = $2) and ($3::text is null or i.severity = $3) and ($4::text is null or i.plugin = $4)
         order by array_position(array['critical','high','medium','low','info'], i.severity), i.last_seen_at desc limit $5`,
        [req.params.projectId, f.status, f.severity ?? null, f.plugin ?? null, f.limit],
      );
      const counts = await q(`select status, severity, count(*)::int as n from issues where project_id = $1 group by status, severity`, [req.params.projectId]);
      return { issues, counts };
    });
    res.json(out);
  }),
);

IssuesRouter.get(
  "/:issueId",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const issue = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      const [i] = await q(`select ${ISSUE_COLUMNS} from issues i left join users u on u.id = i.assignee_id where i.id = $1 and i.project_id = $2`, [req.params.issueId, req.params.projectId]);
      if (!i) throw notFound("Issue");
      const history = await q(
        `select f.id, f.run_id as "runId", r.created_at as "runAt", r.suite, f.detail, f.evidence from findings f join runs r on r.id = f.run_id where f.issue_id = $1 order by r.created_at desc limit 20`,
        [i.id],
      );
      return { ...i, history };
    });
    res.json({ issue });
  }),
);

IssuesRouter.patch(
  "/:issueId",
  auth("owner", "admin", "developer"),
  validate({
    body: z
      .object({
        status: z.enum(["open", "known", "ignored"]).optional(),
        reason: z.string().trim().min(3).max(1000).optional(),
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        assigneeId: z.string().uuid().nullable().optional(),
      })
      .refine((b) => Object.keys(b).length > 0, "Nothing to update"),
  }),
  handle(async (req, res) => {
    const b = req.body;
    if ((b.status === "known" || b.status === "ignored") && !b.reason) throw badRequest("Give a reason when accepting or ignoring an issue");
    const issue = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      if (b.assigneeId) {
        const [m] = await q("select 1 from memberships where org_id = app_org() and user_id = $1", [b.assigneeId]);
        if (!m) throw badRequest("assigneeId is not a member of this organization");
      }
      const [i] = await q(
        `update issues set
           status = coalesce($3, status),
           status_reason = case when $3::text is not null then $4 else coalesce($4, status_reason) end,
           status_until = case when $5::boolean then $6::date when $3::text = 'open' then null else status_until end,
           assignee_id = case when $7::boolean then $8::uuid else assignee_id end,
           updated_at = now()
         where id = $1 and project_id = $2 returning id`,
        [req.params.issueId, req.params.projectId, b.status ?? null, b.reason ?? null, b.until !== undefined, b.until ?? null, b.assigneeId !== undefined, b.assigneeId ?? null],
      );
      if (!i) throw notFound("Issue");
      await audit(q, req, "issue.triaged", "issue", i.id, b);
      const [full] = await q(`select ${ISSUE_COLUMNS} from issues i left join users u on u.id = i.assignee_id where i.id = $1`, [i.id]);
      return full;
    });
    res.json({ issue });
  }),
);
