import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "../../api/client";
import { useCurrentOrg } from "../../lib/org";
import { Button, ErrorAlert, Loading } from "../../components/ui";

type Day = { day: string; runs: number; passed: number; failed: number; envErrors: number; averageDurationMs: number; newIssues: number; fixedIssues: number };
type Trends = { days: Day[]; plugins: Array<{ plugin: string; executions: number; failed: number; errored: number; skipped: number; findings: number }>; generatedAt: string };
function download(data: Trends, csv: boolean) {
  const fields: Array<keyof Day> = ["day", "runs", "passed", "failed", "envErrors", "averageDurationMs", "newIssues", "fixedIssues"];
  const text = csv ? [fields.join(","), ...data.days.map((d) => fields.map((f) => String(d[f])).join(","))].join("\r\n") : JSON.stringify(data, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: csv ? "text/csv;charset=utf-8" : "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `veriq-trends.${csv ? "csv" : "json"}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function TrendsTab() {
  const { orgId } = useCurrentOrg(); const { projectId } = useParams(); const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ["org", orgId, "project", projectId, "trends", days], queryFn: () => api<Trends>("GET", `/orgs/${orgId}/projects/${projectId}/runs/trends?days=${days}`) });
  const totals = q.data?.days.reduce((a, d) => ({ runs: a.runs + d.runs, passed: a.passed + d.passed }), { runs: 0, passed: 0 });
  return <section className="panel"><div className="panel-head"><h2>Quality trends</h2><label>Period <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90].map((n) => <option key={n} value={n}>{n} days</option>)}</select></label></div>
    <div className="panel-body"><ErrorAlert error={q.error} />{q.isLoading && <Loading />}
      {q.data && <><p>{totals?.runs ?? 0} runs · {totals?.runs ? `${Math.round(totals.passed / totals.runs * 100)}% passed` : "No observations"} · UTC calendar days</p>
        <p className="muted">Days without a run are missing observations. Skipped checks are listed separately.</p>
        <div className="btn-row"><Button onClick={() => download(q.data!, true)}>Export CSV</Button><Button onClick={() => download(q.data!, false)}>Export JSON</Button></div>
        <div className="table-wrap"><table className="table"><caption>Daily outcomes</caption><thead><tr><th>Date</th><th>Runs</th><th>Passed</th><th>Failed</th><th>Environment errors</th><th>Average duration</th><th>New issues</th><th>Fixed issues</th></tr></thead><tbody>{q.data.days.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.runs}</td><td>{d.passed}</td><td>{d.failed}</td><td>{d.envErrors}</td><td>{(d.averageDurationMs / 1000).toFixed(1)} s</td><td>{d.newIssues}</td><td>{d.fixedIssues}</td></tr>)}</tbody></table></div>
        <div className="table-wrap"><table className="table"><caption>Plugin outcomes</caption><thead><tr><th>Plugin</th><th>Executions</th><th>Failed</th><th>Errored</th><th>Skipped</th><th>Findings</th></tr></thead><tbody>{q.data.plugins.map((p) => <tr key={p.plugin}><td>{p.plugin}</td><td>{p.executions}</td><td>{p.failed}</td><td>{p.errored}</td><td>{p.skipped}</td><td>{p.findings}</td></tr>)}</tbody></table></div>
      </>}
    </div></section>;
}
