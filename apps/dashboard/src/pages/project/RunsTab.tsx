import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRuns } from "../../api/queries";
import type { Run } from "../../api/types";
import { useCurrentOrg } from "../../lib/org";
import { Button, Empty, ErrorAlert, Loading, RunStatusLabel, When } from "../../components/ui";
import { JobsPanel, RunNowModal } from "./Hosted";
import { fmtDuration } from "../../lib/format";
import { gitLinks, triggerText } from "../../lib/ci";

/** "PR #12" links to the pull request, "Deploy v1.4" to the commit; plain text otherwise */
export function Trigger({ r }: { r: Run }) {
  const links = gitLinks(r.git);
  const text = triggerText(r);
  const href = r.trigger === "pr" ? links.prUrl : links.commitUrl;
  return href ? <a href={href} target="_blank" rel="noreferrer">{text}</a> : <span>{text}</span>;
}

export function RunsTab() {
  const { orgId, can } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const q = useRuns(orgId, projectId);
  const [runNow, setRunNow] = useState(false);
  const base = `/o/${orgId}/projects/${projectId}`;
  const head = (
    <>
      {can("runs.start") && (
        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
          <Button variant="primary" onClick={() => setRunNow(true)}>Run now</Button>
        </div>
      )}
      {runNow && <RunNowModal onClose={() => setRunNow(false)} />}
      <JobsPanel />
    </>
  );
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  if (!q.data!.length)
    return (
      <div style={{ display: "grid", gap: 16 }}>
        {head}
        <div className="panel">
          <Empty title="No runs yet" action={can("apiKeys.manage") ? <Link className="btn" to={`${base}/ci`}>Set up CI</Link> : undefined}>
            Runs arrive from CI (with <code>--upload</code>), from <b>Run now</b>, and from schedules.
          </Empty>
        </div>
      </div>
    );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
    {head}
    <div className="panel table-wrap">
      <table className="table">
        <thead><tr><th>Result</th><th>Trigger</th><th>Suite</th><th>Coverage</th><th className="num">New</th><th className="num">Fixed</th><th className="num">Blocking</th><th>Duration</th><th>When</th></tr></thead>
        <tbody>
          {q.data!.map((r) => (
            <tr key={r.id}>
              <td><Link to={`${base}/runs/${r.id}`} aria-label={`Open run from ${r.createdAt}`}><RunStatusLabel status={r.status} /></Link></td>
              <td className="nowrap"><Trigger r={r} /></td>
              <td>{r.suite}{r.git?.ref && r.trigger !== "push" && <span className="muted small"> · {r.git.ref}</span>}</td>
              <td className="muted">{r.fullCoverage ? "All routes" : `${r.routesSelected} of ${r.routesTotal} routes`}</td>
              <td className="num">{r.newIssues}</td>
              <td className="num">{r.fixedIssues}</td>
              <td className="num">{r.blocking}</td>
              <td className="nowrap">{fmtDuration(r.durationMs)}</td>
              <td className="nowrap"><When at={r.createdAt} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}
