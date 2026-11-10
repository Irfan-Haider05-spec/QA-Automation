import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRun } from "../../api/queries";
import type { Finding, Severity } from "../../api/types";
import { useCurrentOrg } from "../../lib/org";
import { ErrorAlert, IssueStatusLabel, Loading, RunStatusLabel, SeverityLabel, When } from "../../components/ui";
import { fmtDate, fmtDuration } from "../../lib/format";
import { gitLinks } from "../../lib/ci";
import { Trigger } from "./RunsTab";
import { NotFoundPage } from "../NotFound";
import { ApiError } from "../../api/client";

const SEVS: Severity[] = ["critical", "high", "medium", "low", "info"];

const PLUGIN_LABEL = { passed: "Passed", failed: "Failed", skipped: "Skipped", errored: "Errored" } as const;

export function Evidence({ e }: { e: Record<string, any> | null }) {
  if (!e) return null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <dl className="kv">
        {e.status !== undefined && <><dt>Status</dt><dd>{String(e.status)}</dd></>}
        {e.url && <><dt>URL</dt><dd className="mono">{e.url}</dd></>}
        {e.file && <><dt>Source</dt><dd className="mono">{e.file}{e.line ? `:${e.line}` : ""}</dd></>}
        {e.image && <><dt>Screenshot</dt><dd className="muted">In the CI report artifact ({e.image})</dd></>}
      </dl>
      {e.curl && <pre className="code" tabIndex={0} aria-label="Reproduce with curl">{e.curl}</pre>}
      {e.responseSnippet && <pre className="code" tabIndex={0} aria-label="Response">{e.responseSnippet}</pre>}
      {e.log && <pre className="code" tabIndex={0} aria-label="Log">{e.log}</pre>}
    </div>
  );
}

function FindingRow({ f, issueHref }: { f: Finding; issueHref: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="clickable" onClick={() => setOpen((v) => !v)}>
        <td className={`edge ${f.severity}`}><span /></td>
        <td><SeverityLabel s={f.severity} /></td>
        <td>
          <button className="btn ghost sm" style={{ padding: 0, height: "auto", fontWeight: 600, textAlign: "left", whiteSpace: "normal" }} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} aria-expanded={open}>
            {f.title}
          </button>
          <div className="mono muted small">{f.target}</div>
        </td>
        <td className="muted small nowrap">{f.plugin}</td>
        <td className="nowrap">{f.issueStatus ? <IssueStatusLabel status={f.issueStatus} /> : null}{f.known && <span className="tag" style={{ marginLeft: 6 }}>baseline</span>}</td>
      </tr>
      {open && (
        <tr>
          <td />
          <td colSpan={4} style={{ background: "var(--sunken)" }}>
            <div style={{ display: "grid", gap: 10, padding: "4px 0" }}>
              {f.detail && <p style={{ whiteSpace: "pre-line" }}>{f.detail}</p>}
              <Evidence e={f.evidence} />
              <div className="small muted">Fingerprint <span className="mono">{f.fingerprint}</span>{issueHref && <> · <Link to={issueHref}>Open issue</Link></>}</div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function RunDetailPage() {
  const { orgId } = useCurrentOrg();
  const { projectId = "", runId = "" } = useParams();
  const q = useRun(orgId, projectId, runId);
  const [sev, setSev] = useState<Severity | "all">("all");
  if (q.isLoading) return <Loading />;
  if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage what="run" />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const r = q.data!;
  const links = gitLinks(r.git);
  const base = `/o/${orgId}/projects/${projectId}`;
  const findings = r.findings.filter((f) => sev === "all" || f.severity === sev);
  const counts = Object.fromEntries(SEVS.map((s) => [s, r.findings.filter((f) => f.severity === s).length]));
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="crumbs"><Link to={`${base}/runs`}>Runs</Link><span aria-hidden="true">/</span><span>{fmtDate(r.createdAt)}</span></div>
      <div className="panel panel-body">
        <div className="page-head">
          <div>
            <h2 style={{ display: "flex", gap: 10, alignItems: "center" }}><RunStatusLabel status={r.status} /> <span className="muted" style={{ fontWeight: 400 }}>{r.suite} suite</span></h2>
            <p className="muted small" style={{ marginTop: 4 }}>
              Gate fails on {r.gateFailOn} or above · {r.blocking} blocking · {r.newIssues} new · {r.fixedIssues} fixed
            </p>
          </div>
        </div>
        {r.envError && <div className="alert warn"><b>Environment problem:</b> {r.envError}. Live checks were skipped, so this run says nothing about the code.</div>}
        <dl className="kv">
          <dt>Target</dt><dd className="mono">{r.target ?? "static checks only"}</dd>
          <dt>Coverage</dt><dd>{r.fullCoverage ? "All routes" : `${r.routesSelected} of ${r.routesTotal} routes (${r.selectionReason})`}</dd>
          <dt>Requests</dt><dd>{r.requests}</dd>
          <dt>Duration</dt><dd>{fmtDuration(r.durationMs)}</dd>
          <dt>Trigger</dt><dd><Trigger r={r} /> <span className="muted small">({r.source === "cli" ? "command line" : r.source === "ci" ? "CI" : "hosted runner"})</span></dd>
          {(r.git?.sha || r.git?.ref) && (
            <><dt>Code</dt><dd>{r.git.ref && <span>{r.git.ref} </span>}{r.git.sha && (links.commitUrl ? <a className="mono" href={links.commitUrl} target="_blank" rel="noreferrer">{r.git.sha.slice(0, 8)}</a> : <span className="mono">{r.git.sha.slice(0, 8)}</span>)}{links.prUrl && <> · <a href={links.prUrl} target="_blank" rel="noreferrer">pull request #{r.git.pr}</a></>}</dd></>
          )}
          {r.deployment && <><dt>Deployment</dt><dd>{r.deployment.version ?? r.deployment.sha?.slice(0, 8) ?? "Reported deploy"} <span className="muted">· reported <When at={r.deployment.createdAt} /></span></dd></>}
          {links.ciUrl && <><dt>CI job</dt><dd><a href={links.ciUrl} target="_blank" rel="noreferrer">Job log and report artifact</a></dd></>}
          <dt>Started</dt><dd><When at={r.startedAt} /></dd>
        </dl>
      </div>

      <section className="panel" aria-label="Plugins">
        <div className="panel-head"><h2>Checks</h2></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Plugin</th><th>Result</th><th className="num">Findings</th><th>Time</th><th>Notes</th></tr></thead>
            <tbody>
              {r.plugins.map((p) => (
                <tr key={p.plugin}>
                  <td className="mono">{p.plugin}</td>
                  <td><span className={`status ${p.status === "passed" ? "passed" : p.status === "failed" ? "failed" : p.status === "errored" ? "env_error" : ""}`}>{PLUGIN_LABEL[p.status]}</span></td>
                  <td className="num">{p.findingCount}</td>
                  <td className="nowrap">{fmtDuration(p.durationMs)}</td>
                  <td className="muted small">{p.reason ?? (p.stats ? Object.entries(p.stats).map(([k, v]) => `${k} ${v}`).join(" · ") : "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-label="Findings">
        <div className="panel-head">
          <h2>Findings <span className="muted" style={{ fontWeight: 400 }}>{r.findings.length}</span></h2>
          <div className="seg" role="group" aria-label="Filter by severity">
            <button aria-pressed={sev === "all"} onClick={() => setSev("all")}>All</button>
            {SEVS.filter((s) => counts[s]).map((s) => <button key={s} aria-pressed={sev === s} onClick={() => setSev(s)}>{s} {counts[s]}</button>)}
          </div>
        </div>
        {!r.findings.length ? (
          <div className="empty"><h3>No findings</h3><p>Every check that ran passed.</p></div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th><span className="sr-only">Severity edge</span></th><th>Severity</th><th>Finding</th><th>Plugin</th><th>Issue</th></tr></thead>
              <tbody>{findings.map((f) => <FindingRow key={f.id} f={f} issueHref={f.issueId ? `${base}/issues/${f.issueId}` : null} />)}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
