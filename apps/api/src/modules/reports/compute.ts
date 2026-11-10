/**
 * The client report: quality of one project or all projects of a client over a
 * period. Used live in the dashboard and frozen into share-link snapshots.
 *
 * Deliberately left out: raw evidence (requests, responses, curl commands),
 * environment URLs and anything about test accounts. A report goes to people
 * outside the team.
 */
import type { Request } from "express";
import type { Query } from "../../db/index.js";
import { notFound } from "../../lib/http.js";
import { loadProject } from "../../lib/context.js";

const SEV = ["critical", "high", "medium", "low", "info"] as const;
type Sev = (typeof SEV)[number];
const zeroSev = () => Object.fromEntries(SEV.map((s) => [s, 0])) as Record<Sev, number>;

export interface Scope { type: "project" | "client"; id: string; name: string; projects: Array<{ id: string; name: string; clientName: string | null }> }

export async function resolveScope(q: Query, req: Request, type: "project" | "client", id: string): Promise<Scope> {
  if (type === "project") {
    await loadProject(q, req, id);
    const [p] = await q<{ id: string; name: string; client_name: string | null }>("select p.id, p.name, c.name as client_name from projects p left join clients c on c.id = p.client_id where p.id = $1", [id]);
    return { type, id, name: p.name, projects: [{ id: p.id, name: p.name, clientName: p.client_name }] };
  }
  const [c] = await q<{ id: string; name: string }>("select id, name from clients where id = $1", [id]);
  const scope = req.member?.clientIds;
  if (!c || (scope && !scope.includes(c.id))) throw notFound("Client");
  const ps = await q<{ id: string; name: string }>("select id, name from projects where client_id = $1 order by name", [id]);
  return { type, id, name: c.name, projects: ps.map((p) => ({ ...p, clientName: c.name })) };
}

export async function computeReport(q: Query, scope: Scope, from: string, to: string, orgName: string) {
  const ids = scope.projects.map((p) => p.id);
  // [from, to] are whole UTC days
  const start = `${from}T00:00:00Z`;
  const end = new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000).toISOString();

  const runs = await q<{ project_id: string; status: string; day: string }>(
    `select project_id, status, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day from runs
     where project_id = any($1::uuid[]) and created_at >= $2 and created_at < $3`,
    [ids, start, end],
  );
  const lastRuns = await q<{ project_id: string; status: string; created_at: Date }>(
    `select distinct on (project_id) project_id, status, created_at from runs where project_id = any($1::uuid[]) and created_at < $2 order by project_id, created_at desc`,
    [ids, end],
  );
  const issues = await q<{ id: string; project_id: string; title: string; severity: Sev; target: string; status: string; status_reason: string | null; status_until: string | null; first_seen_at: Date; occurrences: number; fixed_at: Date | null; reopened_at: Date | null }>(
    `select id, project_id, title, severity, target, status, status_reason, to_char(status_until, 'YYYY-MM-DD') as status_until, first_seen_at, occurrences, fixed_at, reopened_at
     from issues where project_id = any($1::uuid[])`,
    [ids],
  );
  const inPeriod = (d: Date | null) => !!d && d.toISOString() >= start && d.toISOString() < end;
  const name = new Map(scope.projects.map((p) => [p.id, p.name]));

  const projects = scope.projects.map((p) => {
    const pr = runs.filter((r) => r.project_id === p.id);
    const pi = issues.filter((i) => i.project_id === p.id);
    const open = zeroSev();
    for (const i of pi) if (i.status === "open") open[i.severity]++;
    const last = lastRuns.find((r) => r.project_id === p.id);
    const passed = pr.filter((r) => r.status === "passed").length;
    return {
      id: p.id, name: p.name, clientName: p.clientName,
      runs: pr.length, passed, passRate: pr.length ? Math.round((passed / pr.length) * 100) : null,
      lastRun: last ? { status: last.status, at: last.created_at.toISOString() } : null,
      open,
      accepted: pi.filter((i) => i.status === "known").length,
      newInPeriod: pi.filter((i) => inPeriod(i.first_seen_at)).length,
      fixedInPeriod: pi.filter((i) => i.status === "fixed" && inPeriod(i.fixed_at)).length,
      regressions: pi.filter((i) => inPeriod(i.reopened_at)).length,
    };
  });

  const days: Array<{ date: string; passed: number; failed: number; envError: number }> = [];
  for (let t = new Date(start).getTime(); t < new Date(end).getTime(); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const dr = runs.filter((r) => r.day === date);
    days.push({ date, passed: dr.filter((r) => r.status === "passed").length, failed: dr.filter((r) => r.status === "failed").length, envError: dr.filter((r) => r.status === "env_error").length });
  }

  const openBySeverity = zeroSev();
  for (const p of projects) for (const s of SEV) openBySeverity[s] += p.open[s];
  const totalRuns = runs.length;
  const passedRuns = runs.filter((r) => r.status === "passed").length;
  const order = (a: { severity: Sev }, b: { severity: Sev }) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity);

  return {
    version: 1 as const,
    org: { name: orgName },
    scope: { type: scope.type, id: scope.id, name: scope.name },
    period: { from, to },
    generatedAt: new Date().toISOString(),
    totals: {
      projects: projects.length, runs: totalRuns, passed: passedRuns,
      failed: runs.filter((r) => r.status === "failed").length, envErrors: runs.filter((r) => r.status === "env_error").length,
      passRate: totalRuns ? Math.round((passedRuns / totalRuns) * 100) : null,
      openIssues: Object.values(openBySeverity).reduce((a, b) => a + b, 0), openBySeverity,
      newIssues: projects.reduce((a, p) => a + p.newInPeriod, 0),
      fixedIssues: projects.reduce((a, p) => a + p.fixedInPeriod, 0),
      regressions: projects.reduce((a, p) => a + p.regressions, 0),
    },
    days,
    projects,
    openIssues: issues.filter((i) => i.status === "open" || i.status === "known").sort((a, b) => order(a, b) || +a.first_seen_at - +b.first_seen_at).slice(0, 30).map((i) => ({
      project: name.get(i.project_id)!, title: i.title, severity: i.severity, target: i.target,
      status: i.status === "known" ? "accepted" : "open", acceptedUntil: i.status === "known" ? i.status_until : null, acceptedReason: i.status === "known" ? i.status_reason : null,
      firstSeenAt: i.first_seen_at.toISOString(), occurrences: i.occurrences,
    })),
    fixedIssues: issues.filter((i) => i.status === "fixed" && inPeriod(i.fixed_at)).sort(order).slice(0, 30).map((i) => ({
      project: name.get(i.project_id)!, title: i.title, severity: i.severity, target: i.target, fixedAt: i.fixed_at!.toISOString(),
    })),
  };
}
export type ReportData = Awaited<ReturnType<typeof computeReport>>;
