import { Link } from "react-router-dom";
import { useProjects } from "../api/queries";
import { useCurrentOrg } from "../lib/org";
import { ErrorAlert, Loading, Ribbon, RunStatusLabel, When } from "../components/ui";
import { plural } from "../lib/format";
import { Onboarding } from "../components/Onboarding";
import { startTour } from "../components/Tour";

export function OverviewPage() {
  const { orgId, org, can } = useCurrentOrg();
  const q = useProjects(orgId);
  const projects = q.data ?? [];
  const failing = projects.filter((p) => p.lastRun && p.lastRun.status !== "passed");
  const criticals = projects.reduce((n, p) => n + p.openCritical, 0);
  // Projects needing attention first: failing, then most open criticals, then name
  const sorted = [...projects].sort(
    (a, b) => Number(b.lastRun?.status === "failed") - Number(a.lastRun?.status === "failed") || b.openCritical - a.openCritical || a.name.localeCompare(b.name),
  );
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{org?.name}</h1>
          {!!projects.length && (
            <p className="summary-line" style={{ marginTop: 6 }} data-testid="overview-summary">
              {failing.length ? <><b>{plural(failing.length, "project")}</b> failed their last run</> : <>All projects passed their last run</>}
              {criticals > 0 && <> · <b>{plural(criticals, "open critical issue")}</b></>}
            </p>
          )}
        </div>
        {can("projects.create") && <Link className="btn primary" to={`/o/${orgId}/projects?new=1`}>New project</Link>}
      </div>
      <ErrorAlert error={q.error} />
      {can("org.update") && <Onboarding orgId={orgId} />}
      {q.isLoading ? (
        <Loading />
      ) : !projects.length ? (
        <section className="panel welcome" aria-labelledby="welcome-h">
          <div className="panel-body">
            <h2 id="welcome-h">Welcome to VeriQ</h2>
            <p className="muted">VeriQ tests your API and dashboards from the outside — on every pull request, after each staging deploy, and on a schedule — and gathers what it finds here.</p>
            <div className="how">
              <div className="how-step"><span className="how-n" aria-hidden="true">1</span><div><b>Connect a project</b><p className="muted small">Point VeriQ at a codebase and its staging environment.</p></div></div>
              <div className="how-step"><span className="how-n" aria-hidden="true">2</span><div><b>Run the checks</b><p className="muted small">In CI on each pull request and deploy, or on the hosted runner.</p></div></div>
              <div className="how-step"><span className="how-n" aria-hidden="true">3</span><div><b>Act on the results</b><p className="muted small">Gates block regressions; issues and reports live here.</p></div></div>
            </div>
            <div className="btn-row">
              {can("projects.create") && <Link className="btn primary" to={`/o/${orgId}/projects?new=1`}>Create your first project</Link>}
              <button type="button" className="btn" onClick={startTour}>Take a tour</button>
              <Link className="btn" to={`/o/${orgId}/guide`}>Integration guide</Link>
            </div>
          </div>
        </section>
      ) : (
        <section className="panel" aria-label="Project health">
          <div className="health-head" aria-hidden="true">
            <span>Project</span><span>Last 14 runs</span><span className="r">Critical</span><span className="r">Open issues</span><span className="r">Last run</span>
          </div>
          <div className="health">
            {sorted.map((p) => (
              <Link key={p.id} className="health-row" to={`/o/${orgId}/projects/${p.id}`} data-testid="health-row">
                <span>
                  <span className="name">{p.name}</span>
                  {p.clientName && <span className="client"> · {p.clientName}</span>}
                  <span className="client" style={{ display: "block" }}>{p.lastRun ? <RunStatusLabel status={p.lastRun.status} /> : "Not run yet"}</span>
                </span>
                <Ribbon runs={p.recentRuns} />
                <span className={`metric ${p.openCritical ? "hot" : ""}`}><b>{p.openCritical}</b><span>critical</span></span>
                <span className="metric"><b>{p.openIssues}</b><span>open</span></span>
                <span className="metric when"><span style={{ fontSize: 13.5, color: "var(--ink-2)" }}><When at={p.lastRun?.createdAt} /></span></span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
