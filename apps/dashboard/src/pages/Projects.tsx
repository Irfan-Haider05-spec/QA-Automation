import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { keys, useAction, useClients, useProjects } from "../api/queries";
import type { Project } from "../api/types";
import { useCurrentOrg } from "../lib/org";
import { Button, Empty, ErrorAlert, Field, Input, Loading, Modal, Ribbon, useToast, When } from "../components/ui";

export const STACKS: Array<[string, string]> = [
  ["node-express", "Node.js / Express"], ["nestjs", "NestJS"], ["fastapi", "Python / FastAPI"], ["django", "Python / Django"],
  ["laravel", "PHP / Laravel"], ["openapi-only", "Any stack (I have an OpenAPI spec)"], ["other", "Other"],
];

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const { orgId, scoped } = useCurrentOrg();
  const clients = useClients(orgId).data ?? [];
  const nav = useNavigate();
  const toast = useToast();
  const [f, setF] = useState({ name: "", clientId: "", repoUrl: "", stack: "node-express" });
  const create = useAction(
    (b: typeof f) => api<{ project: Project }>("POST", `/orgs/${orgId}/projects`, { name: b.name.trim(), clientId: b.clientId || null, repoUrl: b.repoUrl.trim() || null, stack: b.stack }),
    [keys.projects(orgId), keys.clients(orgId)],
  );
  return (
    <Modal
      title="New project"
      description="One codebase you want tested. You'll add its staging URLs next."
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" form="new-project" type="submit" busy={create.isPending}>Create project</Button></>}
    >
      <form
        id="new-project"
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await create.mutateAsync(f).catch(() => null);
          if (r) { toast(`Project "${r.project.name}" created`); onClose(); nav(`/o/${orgId}/projects/${r.project.id}/environments`); }
        }}
      >
        <Field label="Project name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} placeholder="e.g. Loyalty backend" />}</Field>
        <Field label="Client" hint={scoped ? "You can only create projects for your clients." : "Optional. Group projects by the customer they belong to."}>
          {(id) => (
            <select id={id} className="input" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} required={scoped}>
              {!scoped && <option value="">No client</option>}
              {scoped && <option value="" disabled>Choose a client</option>}
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Stack">
          {(id) => <select id={id} className="input" value={f.stack} onChange={(e) => setF({ ...f, stack: e.target.value })}>{STACKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
        </Field>
        <Field label="Repository URL" hint="Optional, e.g. https://github.com/acme/api">{(id) => <Input id={id} type="url" value={f.repoUrl} onChange={(e) => setF({ ...f, repoUrl: e.target.value })} />}</Field>
        <ErrorAlert error={create.error} />
      </form>
    </Modal>
  );
}

export function ProjectsPage() {
  const { orgId, can } = useCurrentOrg();
  const q = useProjects(orgId);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState("");
  const showNew = params.get("new") === "1";
  const projects = (q.data ?? []).filter((p) => !filter || `${p.name} ${p.clientName ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Projects</h1><p className="sub">Codebases under test, and the result of their latest runs.</p></div>
        {can("projects.create") && <Button variant="primary" onClick={() => setParams({ new: "1" })}>New project</Button>}
      </div>
      {showNew && <NewProjectModal onClose={() => setParams({})} />}
      <ErrorAlert error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? (
        <div className="panel"><Empty title="No projects yet">{can("projects.create") ? "Create one to start connecting staging environments." : "An admin or developer can create projects."}</Empty></div>
      ) : (
        <div className="panel">
          <div className="panel-head">
            <label className="sr-only" htmlFor="project-filter">Filter projects</label>
            <input id="project-filter" className="input" style={{ maxWidth: 280 }} placeholder="Filter by project or client" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span className="muted small">{projects.length} of {q.data.length}</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Project</th><th>Client</th><th>Recent runs</th><th className="num">Open issues</th><th>Last run</th></tr></thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td><Link to={`/o/${orgId}/projects/${p.id}`} style={{ fontWeight: 600 }}>{p.name}</Link></td>
                    <td className="muted">{p.clientName ?? "—"}</td>
                    <td><Ribbon runs={p.recentRuns} /></td>
                    <td className="num">{p.openIssues}</td>
                    <td className="nowrap"><When at={p.lastRun?.createdAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
