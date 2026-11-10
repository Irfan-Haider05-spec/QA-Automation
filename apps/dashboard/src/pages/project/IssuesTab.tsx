import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { keys, useAction, useIssue, useIssues, useMembers } from "../../api/queries";
import type { IssueDetail, Severity } from "../../api/types";
import { useCurrentOrg } from "../../lib/org";
import { Button, Empty, ErrorAlert, Field, IssueStatusLabel, Loading, SeverityLabel, useToast, When } from "../../components/ui";
import { Evidence } from "./RunDetail";

const STATUSES: Array<[string, string]> = [["open", "Open"], ["known", "Accepted"], ["ignored", "Ignored"], ["fixed", "Fixed"], ["all", "All"]];
const SEVS: Severity[] = ["critical", "high", "medium", "low", "info"];

function Triage({ issue }: { issue: IssueDetail }) {
  const { orgId, can } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const members = useMembers(orgId).data ?? [];
  const [mode, setMode] = useState<"known" | "ignored" | null>(null);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const prefix = ["org", orgId, "project", projectId];
  const patch = useAction((b: Record<string, unknown>) => api("PATCH", `/orgs/${orgId}/projects/${projectId}/issues/${issue.id}`, b), [prefix]);
  useEffect(() => { setMode(null); setReason(""); setUntil(""); patch.reset(); }, [issue.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!can("issues.triage")) return null;
  const run = async (b: Record<string, unknown>, msg: string) => {
    if (await patch.mutateAsync(b).then(() => true).catch(() => false)) { toast(msg); setMode(null); setReason(""); setUntil(""); }
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Field label="Assignee">
        {(id) => (
          <select id={id} className="input" value={issue.assigneeId ?? ""} onChange={(e) => run({ assigneeId: e.target.value || null }, e.target.value ? "Issue assigned" : "Assignee removed")}>
            <option value="">Nobody</option>
            {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </select>
        )}
      </Field>
      {mode ? (
        <form className="form" onSubmit={(e) => { e.preventDefault(); run({ status: mode, reason: reason.trim(), until: mode === "known" ? until || null : undefined }, mode === "known" ? "Issue accepted" : "Issue ignored"); }}>
          <Field label={mode === "known" ? "Why is this accepted for now?" : "Why ignore this?"} hint="Shown to everyone who sees this issue.">
            {(id) => <textarea id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={1000} />}
          </Field>
          {mode === "known" && (
            <Field label="Accept until" hint="Optional. After this date the issue blocks again.">
              {(id) => <input id={id} className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />}
            </Field>
          )}
          <div className="btn-row">
            <Button variant="primary" type="submit" busy={patch.isPending}>{mode === "known" ? "Accept issue" : "Ignore issue"}</Button>
            <Button type="button" onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="btn-row">
          {issue.status === "fixed" && <p className="muted small">Fixed issues reopen on their own if a later run finds them again.</p>}
          {issue.status === "open" && <Button onClick={() => setMode("known")}>Accept for now</Button>}
          {(issue.status === "open" || issue.status === "known") && <Button onClick={() => setMode("ignored")}>Ignore</Button>}
          {(issue.status === "known" || issue.status === "ignored") && <Button onClick={() => run({ status: "open" }, "Issue reopened")} busy={patch.isPending}>Reopen</Button>}
        </div>
      )}
      <ErrorAlert error={patch.error} />
    </div>
  );
}

function IssuePanel({ issueId }: { issueId: string }) {
  const { orgId } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const nav = useNavigate();
  const q = useIssue(orgId, projectId, issueId);
  const base = `/o/${orgId}/projects/${projectId}`;
  return (
    <aside className="panel detail" aria-label="Issue details">
      <div className="panel-head">
        <h2>Issue</h2>
        <Button size="sm" variant="ghost" onClick={() => nav(`${base}/issues`)} aria-label="Close issue details">Close</Button>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <div className="panel-body"><ErrorAlert error={q.error} /></div> : (
        <div className="panel-body">
          <div style={{ display: "grid", gap: 6 }}>
            <div className="btn-row"><SeverityLabel s={q.data!.severity} /><IssueStatusLabel status={q.data!.status} /></div>
            <h3 style={{ fontSize: 16 }}>{q.data!.title}</h3>
            <div className="mono small muted">{q.data!.target}</div>
          </div>
          {q.data!.statusReason && <div className="alert">{q.data!.statusReason}{q.data!.statusUntil && <> · until {q.data!.statusUntil}</>}</div>}
          <dl className="kv">
            <dt>Plugin</dt><dd className="mono">{q.data!.plugin}</dd>
            <dt>Seen</dt><dd>{q.data!.occurrences} time{q.data!.occurrences === 1 ? "" : "s"}</dd>
            <dt>First seen</dt><dd><When at={q.data!.firstSeenAt} /></dd>
            <dt>Last seen</dt><dd><When at={q.data!.lastSeenAt} /></dd>
            <dt>Assignee</dt><dd>{q.data!.assigneeName ?? "Nobody"}</dd>
            <dt>Fingerprint</dt><dd className="mono">{q.data!.fingerprint}</dd>
          </dl>
          <Triage issue={q.data!} />
          {q.data!.history[0] && (
            <div style={{ display: "grid", gap: 8 }}>
              <h3>Latest evidence</h3>
              {q.data!.history[0].detail && <p className="small" style={{ whiteSpace: "pre-line" }}>{q.data!.history[0].detail}</p>}
              <Evidence e={q.data!.history[0].evidence} />
              <h3 style={{ marginTop: 6 }}>Seen in runs</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {q.data!.history.map((h) => <li key={h.id}><Link to={`${base}/runs/${h.runId}`}><When at={h.runAt} /></Link> <span className="muted small">· {h.suite}</span></li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

export function IssuesTab() {
  const { orgId } = useCurrentOrg();
  const { projectId = "", issueId } = useParams();
  const nav = useNavigate();
  const [status, setStatus] = useState("open");
  const [severity, setSeverity] = useState<Severity | "">("");
  const q = useIssues(orgId, projectId, { status, severity: severity || undefined });
  const base = `/o/${orgId}/projects/${projectId}`;
  const countBy = (st: string) => (q.data?.counts ?? []).filter((c) => st === "all" || c.status === st).reduce((n, c) => n + c.n, 0);
  return (
    <div className={issueId ? "split" : ""}>
      <div className="panel">
        <div className="panel-head">
          <div className="seg" role="group" aria-label="Filter by status">
            {STATUSES.map(([v, l]) => <button key={v} aria-pressed={status === v} onClick={() => setStatus(v)}>{l} <span className="muted">{countBy(v)}</span></button>)}
          </div>
          <label className="sr-only" htmlFor="sev-filter">Severity</label>
          <select id="sev-filter" className="input" style={{ width: 160 }} value={severity} onChange={(e) => setSeverity(e.target.value as Severity | "")}>
            <option value="">All severities</option>
            {SEVS.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
        </div>
        {q.isLoading ? <Loading /> : q.error ? <div className="panel-body"><ErrorAlert error={q.error} /></div> : !q.data!.issues.length ? (
          <Empty title={status === "open" ? "No open issues" : "Nothing here"}>{status === "open" ? "Every finding from recent runs is fixed, accepted or ignored." : "No issues match these filters."}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th><span className="sr-only">Severity edge</span></th><th>Issue</th><th>Status</th><th className="num">Seen</th><th>Last seen</th></tr></thead>
              <tbody>
                {q.data!.issues.map((i) => (
                  <tr key={i.id} className={`clickable ${i.id === issueId ? "selected" : ""}`} onClick={() => nav(`${base}/issues/${i.id}`)}>
                    <td className={`edge ${i.severity}`}><span /></td>
                    <td>
                      <Link to={`${base}/issues/${i.id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600, color: "var(--ink)" }}>{i.title}</Link>
                      <div className="small muted"><span className={`sev ${i.severity}`} style={{ fontWeight: 500 }}>{i.severity}</span> · <span className="mono">{i.target}</span>{i.assigneeName && <> · {i.assigneeName}</>}</div>
                    </td>
                    <td className="nowrap"><IssueStatusLabel status={i.status} /></td>
                    <td className="num">{i.occurrences}</td>
                    <td className="nowrap"><When at={i.lastSeenAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {issueId && <IssuePanel issueId={issueId} />}
    </div>
  );
}
