/**
 * User acceptance testing (UAT). A release holds acceptance criteria (a user story or
 * rule, manual steps, an optional linked scenario and run as automated evidence). Team
 * members record results; an owner or admin signs the release off (only when every
 * criterion passed) or rejects it with a reason. A decided release is locked until an
 * owner or admin reopens it. Every change is audited; the report exports as JSON or
 * Markdown.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { PERMISSIONS } from "@qa/shared";
import { auth } from "../../middleware/auth.js";
import { audit, loadProject, scoped } from "../../lib/context.js";
import { ApiError, badRequest, conflict, handle, notFound, query, validate } from "../../lib/http.js";
import type { Query } from "../../db/index.js";

export const UatRouter = Router({ mergeParams: true });

const RECORD = PERMISSIONS["uat.record"];
const DECIDE = PERMISSIONS["uat.decide"];
const MAX_CRITERIA = 200;
const STATUSES = ["untested", "passed", "failed", "blocked"] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).transform((v) => (v === "" ? null : v)).nullable().optional();
const criterionInput = z.object({ title: text(300), steps: optionalText(4000), scenario: optionalText(200) }).strict();

const RELEASE_COLUMNS = `r.id, r.name, r.description, r.status, r.decided_by as "decidedBy", d.name as "decidedByName", r.decided_at as "decidedAt",
  r.decision_note as "decisionNote", r.created_by as "createdBy", c.name as "createdByName", r.created_at as "createdAt", r.updated_at as "updatedAt",
  (select json_build_object('total', count(*)::int, 'untested', count(*) filter (where status = 'untested')::int, 'passed', count(*) filter (where status = 'passed')::int,
     'failed', count(*) filter (where status = 'failed')::int, 'blocked', count(*) filter (where status = 'blocked')::int) from uat_criteria x where x.release_id = r.id) as counts`;
const CRITERION_COLUMNS = `k.id, k.position, k.title, k.steps, k.scenario, k.status, k.note, k.evidence_run_id as "evidenceRunId", run.status as "evidenceRunStatus",
  run.started_at as "evidenceRunAt", k.tested_by as "testedBy", t.name as "testedByName", k.tested_at as "testedAt", k.updated_at as "updatedAt",
  auto.status as "automatedStatus", auto.run_id as "automatedRunId", auto.created_at as "automatedAt"`;

/** The release in this project; changes lock the row so concurrent decisions and edits serialise. */
async function release(q: Query, req: Request, opts: { open?: boolean; lock?: boolean } = {}) {
  await loadProject(q, req, req.params.projectId);
  const [row] = await q<{ id: string; status: string; name: string }>(`select id, status, name from uat_releases where id = $1 and project_id = $2${opts.lock || opts.open ? " for update" : ""}`, [req.params.releaseId, req.params.projectId]);
  if (!row) throw notFound("UAT release");
  if (opts.open && row.status !== "open") throw new ApiError(409, "release_locked", `This release is ${row.status === "signed_off" ? "signed off" : "rejected"}; reopen it to make changes`);
  return row;
}
const fullRelease = async (q: Query, id: string) => (await q(`select ${RELEASE_COLUMNS} from uat_releases r left join users d on d.id = r.decided_by left join users c on c.id = r.created_by where r.id = $1`, [id]))[0];
// The latest result of the linked scenario in this project's uploaded runs: automated evidence a tester can attach.
const criteria = (q: Query, releaseId: string) => q(`select ${CRITERION_COLUMNS} from uat_criteria k left join users t on t.id = k.tested_by left join runs run on run.id = k.evidence_run_id
  join uat_releases rel on rel.id = k.release_id
  left join lateral (select rc.status, rc.run_id, rc.created_at from run_cases rc
    where k.scenario is not null and rc.project_id = rel.project_id and rc.name = k.scenario order by rc.created_at desc limit 1) auto on true
  where k.release_id = $1 order by k.position, k.created_at`, [releaseId]);
const touch = (q: Query, id: string) => q("update uat_releases set updated_at = now() where id = $1", [id]);

UatRouter.get("/releases", auth(), validate({ query: z.object({ status: z.enum(["open", "signed_off", "rejected", "all"]).default("all") }) }), handle(async (req, res) => {
  const { status } = query<{ status: string }>(req);
  const releases = await scoped(req, async (q) => {
    await loadProject(q, req, req.params.projectId);
    return q(`select ${RELEASE_COLUMNS} from uat_releases r left join users d on d.id = r.decided_by left join users c on c.id = r.created_by
      where r.project_id = $1 and ($2 = 'all' or r.status = $2) order by r.created_at desc limit 200`, [req.params.projectId, status]);
  });
  res.json({ releases });
}));

// Scenario names the project's uploaded runs contain, each with its latest result, so a
// tester can link a criterion to a scenario by picking it instead of typing its exact name.
UatRouter.get("/scenarios", auth(), validate({ query: z.object({ tag: z.string().trim().min(1).max(50).optional() }) }), handle(async (req, res) => {
  const { tag } = query<{ tag?: string }>(req);
  const scenarios = await scoped(req, async (q) => {
    await loadProject(q, req, req.params.projectId);
    return q(`select distinct on (rc.name) rc.name, rc.status, rc.tags, rc.run_id as "runId", rc.created_at as "at"
      from run_cases rc where rc.project_id = $1 and ($2::text is null or $2 = any(rc.tags))
      order by rc.name, rc.created_at desc limit 500`, [req.params.projectId, tag ?? null]);
  });
  res.json({ scenarios });
}));

UatRouter.post("/releases", auth(...RECORD), validate({ body: z.object({ name: text(120), description: optionalText(4000), criteria: z.array(criterionInput).max(MAX_CRITERIA).default([]) }).strict() }), handle(async (req, res) => {
  const out = await scoped(req, async (q) => {
    await loadProject(q, req, req.params.projectId);
    const [dup] = await q("select 1 from uat_releases where project_id = $1 and lower(name) = lower($2)", [req.params.projectId, req.body.name]);
    if (dup) throw conflict("A UAT release with this name already exists in the project");
    const [r] = await q<{ id: string }>("insert into uat_releases(org_id, project_id, name, description, created_by) values(app_org(), $1, $2, $3, app_user()) returning id", [req.params.projectId, req.body.name, req.body.description ?? null]);
    for (const [i, c] of (req.body.criteria as z.output<typeof criterionInput>[]).entries()) {
      await q("insert into uat_criteria(org_id, release_id, position, title, steps, scenario) values(app_org(), $1, $2, $3, $4, $5)", [r.id, i + 1, c.title, c.steps ?? null, c.scenario ?? null]);
    }
    await audit(q, req, "uat.release_created", "uat_release", r.id, { name: req.body.name, criteria: req.body.criteria.length });
    return { release: await fullRelease(q, r.id), criteria: await criteria(q, r.id) };
  });
  res.status(201).json(out);
}));

UatRouter.get("/releases/:releaseId", auth(), validate({}), handle(async (req, res) => {
  const out = await scoped(req, async (q) => { const r = await release(q, req); return { release: await fullRelease(q, r.id), criteria: await criteria(q, r.id) }; });
  res.json(out);
}));

UatRouter.patch("/releases/:releaseId", auth(...RECORD), validate({ body: z.object({ name: text(120).optional(), description: optionalText(4000) }).strict().refine((b) => Object.keys(b).length > 0, "Nothing to update") }), handle(async (req, res) => {
  const out = await scoped(req, async (q) => {
    const r = await release(q, req, { open: true });
    if (req.body.name) {
      const [dup] = await q("select 1 from uat_releases where project_id = $1 and lower(name) = lower($2) and id <> $3", [req.params.projectId, req.body.name, r.id]);
      if (dup) throw conflict("A UAT release with this name already exists in the project");
    }
    await q("update uat_releases set name = coalesce($2, name), description = case when $3::boolean then $4 else description end, updated_at = now() where id = $1",
      [r.id, req.body.name ?? null, req.body.description !== undefined, req.body.description ?? null]);
    await audit(q, req, "uat.release_updated", "uat_release", r.id, { name: req.body.name });
    return { release: await fullRelease(q, r.id) };
  });
  res.json(out);
}));

UatRouter.post("/releases/:releaseId/criteria", auth(...RECORD), validate({ body: criterionInput }), handle(async (req, res) => {
  const out = await scoped(req, async (q) => {
    const r = await release(q, req, { open: true });
    const [{ n, next }] = await q<{ n: number; next: number }>("select count(*)::int as n, coalesce(max(position), 0)::int + 1 as next from uat_criteria where release_id = $1", [r.id]);
    if (n >= MAX_CRITERIA) throw badRequest(`A release can have at most ${MAX_CRITERIA} criteria`);
    const [c] = await q<{ id: string }>("insert into uat_criteria(org_id, release_id, position, title, steps, scenario) values(app_org(), $1, $2, $3, $4, $5) returning id", [r.id, next, req.body.title, req.body.steps ?? null, req.body.scenario ?? null]);
    await touch(q, r.id);
    await audit(q, req, "uat.criterion_added", "uat_release", r.id, { criterionId: c.id });
    return { criterion: (await criteria(q, r.id)).find((x: { id: string }) => x.id === c.id) };
  });
  res.status(201).json(out);
}));

UatRouter.patch("/releases/:releaseId/criteria/:criterionId", auth(...RECORD), validate({
  body: z.object({
    title: text(300).optional(), steps: optionalText(4000), scenario: optionalText(200),
    status: z.enum(STATUSES).optional(), note: optionalText(2000), evidenceRunId: z.string().uuid().nullable().optional(),
  }).strict().refine((b) => Object.keys(b).length > 0, "Nothing to update"),
}), handle(async (req, res) => {
  const b = req.body;
  const out = await scoped(req, async (q) => {
    const r = await release(q, req, { open: true });
    const [cur] = await q<{ id: string; status: string; note: string | null }>("select id, status, note from uat_criteria where id = $1 and release_id = $2", [req.params.criterionId, r.id]);
    if (!cur) throw notFound("Criterion");
    const status = b.status ?? cur.status;
    const note = b.note !== undefined ? b.note : b.status && b.status !== cur.status ? null : cur.note;
    if ((status === "failed" || status === "blocked") && (!note || note.length < 3)) throw badRequest(`Describe what ${status === "failed" ? "failed" : "blocks the test"} in the note`);
    if (b.evidenceRunId) {
      const [run] = await q("select 1 from runs where id = $1 and project_id = $2", [b.evidenceRunId, req.params.projectId]);
      if (!run) throw badRequest("evidenceRunId is not a run of this project");
    }
    const statusChanged = b.status !== undefined && b.status !== cur.status;
    await q(`update uat_criteria set title = coalesce($2, title),
        steps = case when $3::boolean then $4 else steps end, scenario = case when $5::boolean then $6 else scenario end,
        status = $7, note = $8,
        evidence_run_id = case when $9::boolean then $10::uuid else evidence_run_id end,
        tested_by = case when $11::boolean then (case when $7 = 'untested' then null else app_user() end) else tested_by end,
        tested_at = case when $11::boolean then (case when $7 = 'untested' then null else now() end) else tested_at end,
        updated_at = now() where id = $1`,
      [cur.id, b.title ?? null, b.steps !== undefined, b.steps ?? null, b.scenario !== undefined, b.scenario ?? null, status, note,
       b.evidenceRunId !== undefined, b.evidenceRunId ?? null, statusChanged]);
    await touch(q, r.id);
    await audit(q, req, statusChanged ? "uat.criterion_tested" : "uat.criterion_updated", "uat_release", r.id, { criterionId: cur.id, ...(statusChanged ? { status } : {}) });
    return { criterion: (await criteria(q, r.id)).find((x: { id: string }) => x.id === cur.id) };
  });
  res.json(out);
}));

UatRouter.delete("/releases/:releaseId/criteria/:criterionId", auth(...RECORD), validate({}), handle(async (req, res) => {
  await scoped(req, async (q) => {
    const r = await release(q, req, { open: true });
    const [row] = await q("delete from uat_criteria where id = $1 and release_id = $2 returning id", [req.params.criterionId, r.id]);
    if (!row) throw notFound("Criterion");
    await touch(q, r.id);
    await audit(q, req, "uat.criterion_removed", "uat_release", r.id, { criterionId: row.id });
  });
  res.status(204).end();
}));

UatRouter.post("/releases/:releaseId/decision", auth(...DECIDE), validate({ body: z.object({ decision: z.enum(["signed_off", "rejected"]), note: optionalText(2000) }).strict() }), handle(async (req, res) => {
  const out = await scoped(req, async (q) => {
    const r = await release(q, req, { open: true });
    const [c] = await q<{ total: number; open: number }>("select count(*)::int as total, count(*) filter (where status <> 'passed')::int as open from uat_criteria where release_id = $1", [r.id]);
    if (req.body.decision === "signed_off") {
      if (!c.total) throw new ApiError(422, "not_ready", "Add acceptance criteria before signing off");
      if (c.open) throw new ApiError(422, "not_ready", `${c.open} criterion${c.open === 1 ? " has" : "s have"} not passed; every criterion must pass before sign-off`);
    } else if (!req.body.note || req.body.note.length < 3) throw badRequest("Give the reason for rejecting this release");
    await q("update uat_releases set status = $2, decided_by = app_user(), decided_at = now(), decision_note = $3, updated_at = now() where id = $1", [r.id, req.body.decision, req.body.note ?? null]);
    await audit(q, req, req.body.decision === "signed_off" ? "uat.signed_off" : "uat.rejected", "uat_release", r.id, { criteria: c.total });
    return { release: await fullRelease(q, r.id) };
  });
  res.json(out);
}));

UatRouter.post("/releases/:releaseId/reopen", auth(...DECIDE), validate({ body: z.object({ reason: text(2000).refine((v) => v.length >= 3, "Give a reason") }).strict() }), handle(async (req, res) => {
  const out = await scoped(req, async (q) => {
    const r = await release(q, req, { lock: true });
    if (r.status === "open") throw conflict("This release is already open");
    await q("update uat_releases set status = 'open', decided_by = null, decided_at = null, decision_note = null, updated_at = now() where id = $1", [r.id]);
    await audit(q, req, "uat.reopened", "uat_release", r.id, { previous: r.status, reason: req.body.reason });
    return { release: await fullRelease(q, r.id) };
  });
  res.json(out);
}));

const cell = (v: unknown) => String(v ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim() || "—";
const LABEL: Record<string, string> = { untested: "Untested", passed: "Passed", failed: "Failed", blocked: "Blocked", skipped: "Skipped", open: "Open", signed_off: "Signed off", rejected: "Rejected" };

UatRouter.get("/releases/:releaseId/report", auth(), validate({ query: z.object({ format: z.enum(["json", "md"]).default("json") }) }), handle(async (req, res) => {
  const { format } = query<{ format: "json" | "md" }>(req);
  const out = await scoped(req, async (q) => {
    const r = await release(q, req);
    const project = (await q<{ name: string }>("select name from projects where id = $1", [req.params.projectId]))[0];
    return { project: project.name, release: await fullRelease(q, r.id), criteria: await criteria(q, r.id) };
  });
  if (format === "json") return void res.json({ ...out, generatedAt: new Date().toISOString() });
  const r = out.release;
  const lines = [
    `# UAT report: ${cell(r.name)}`, "",
    `Project: ${cell(out.project)}  `, `Status: **${LABEL[r.status]}**${r.decidedAt ? ` by ${cell(r.decidedByName)} on ${new Date(r.decidedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}  `,
    ...(r.decisionNote ? [`Decision note: ${cell(r.decisionNote)}  `] : []),
    `Criteria: ${r.counts.total} (passed ${r.counts.passed}, failed ${r.counts.failed}, blocked ${r.counts.blocked}, untested ${r.counts.untested})`, "",
    ...(r.description ? [cell(r.description), ""] : []),
    "| # | Criterion | Status | Tested by | Tested at (UTC) | Note | Evidence | Latest automated result |", "|---|---|---|---|---|---|---|---|",
    ...out.criteria.map((c: any) => `| ${c.position} | ${cell(c.title)} | ${LABEL[c.status]} | ${cell(c.testedByName)} | ${c.testedAt ? new Date(c.testedAt).toISOString().slice(0, 16).replace("T", " ") : "—"} | ${cell(c.note)} | ${c.evidenceRunId ? `run ${c.evidenceRunId}${c.evidenceRunStatus ? ` (${c.evidenceRunStatus})` : ""}` : "—"} | ${c.scenario ? `${cell(c.scenario)}: ${c.automatedStatus ? `${LABEL[c.automatedStatus]} in run ${c.automatedRunId} (${new Date(c.automatedAt).toISOString().slice(0, 16).replace("T", " ")})` : "no result yet"}` : "—"} |`),
    "", `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by VeriQ.`, "",
  ];
  const slug = String(r.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "release";
  res.setHeader("content-type", "text/markdown; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="uat-${slug}.md"`);
  res.send(lines.join("\n"));
}));
