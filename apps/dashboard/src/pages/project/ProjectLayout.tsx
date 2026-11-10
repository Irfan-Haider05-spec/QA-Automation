import { NavLink, Outlet, useParams, Link } from "react-router-dom";
import { useProject } from "../../api/queries";
import { useCurrentOrg } from "../../lib/org";
import { ErrorAlert, Loading, Ribbon } from "../../components/ui";
import { NotFoundPage } from "../NotFound";
import { ApiError } from "../../api/client";

export function ProjectLayout() {
  const { orgId, can } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const q = useProject(orgId, projectId);
  if (q.isLoading) return <Loading />;
  if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage what="project" />;
  if (q.error) return <div className="page"><ErrorAlert error={q.error} /></div>;
  const p = q.data!;
  const base = `/o/${orgId}/projects/${projectId}`;
  return (
    <div className="page">
      <div>
        <div className="crumbs"><Link to={`/o/${orgId}/projects`}>Projects</Link>{p.clientName && <><span aria-hidden="true">/</span><span>{p.clientName}</span></>}</div>
        <div className="page-head">
          <div>
            <h1>{p.name}</h1>
            <p className="sub">{p.openIssues ? `${p.openIssues} open issue${p.openIssues === 1 ? "" : "s"}${p.openCritical ? `, ${p.openCritical} critical` : ""}` : "No open issues"}{p.repoUrl && <> · <a href={p.repoUrl} target="_blank" rel="noreferrer">Repository</a></>}</p>
          </div>
          <Ribbon runs={p.recentRuns} size="lg" linkTo={(r) => `${base}/runs/${r.id}`} />
        </div>
      </div>
      <nav className="tabs" aria-label="Project sections">
        <NavLink to={`${base}/runs`}>Runs</NavLink>
        <NavLink to={`${base}/issues`}>Issues<span className="count">{p.openIssues}</span></NavLink>
        <NavLink to={`${base}/environments`}>Environments<span className="count">{p.environments?.length ?? 0}</span></NavLink>
        <NavLink to={`${base}/schedules`}>Schedules</NavLink>
        {can("apiKeys.manage") && <NavLink to={`${base}/api-keys`}>API keys</NavLink>}
        {can("apiKeys.manage") && <NavLink to={`${base}/ci`}>CI setup</NavLink>}
        {can("projects.update") && <NavLink to={`${base}/settings`}>Settings</NavLink>}
      </nav>
      <Outlet context={p} />
    </div>
  );
}
