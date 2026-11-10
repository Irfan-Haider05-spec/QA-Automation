import { Link } from "react-router-dom";
import { useProjects } from "../api/queries";
import { useCurrentOrg } from "../lib/org";
import { Empty, ErrorAlert, Loading, Ribbon, RunStatusLabel, When } from "../components/ui";
import { plural } from "../lib/format";
import { Onboarding } from "../components/Onboarding";

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
        <div className="panel">
          <Empty
            title="No projects yet"
            action={can("projects.create") ? <Link className="btn primary" to={`/o/${orgId}/projects?new=1`}>Create your first project</Link> : undefined}
          >
            A project is one codebase you want tested: its API, dashboards or app.
          </Empty>
        </div>
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
