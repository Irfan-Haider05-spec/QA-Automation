import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { api } from "../../api/client";
import { keys, useAction, useClients } from "../../api/queries";
import type { Project } from "../../api/types";
import { useCurrentOrg } from "../../lib/org";
import { Button, Confirm, ErrorAlert, Field, Input, useToast } from "../../components/ui";
import { STACKS } from "../Projects";

export function ProjectSettingsTab() {
  const project = useOutletContext<Project>();
  const { orgId, can, scoped } = useCurrentOrg();
  const clients = useClients(orgId).data ?? [];
  const toast = useToast();
  const nav = useNavigate();
  const [f, setF] = useState({ name: project.name, clientId: project.clientId ?? "", repoUrl: project.repoUrl ?? "", stack: project.stack });
  const [deleting, setDeleting] = useState(false);
  const save = useAction(
    () => api("PATCH", `/orgs/${orgId}/projects/${project.id}`, { name: f.name.trim(), clientId: f.clientId || null, repoUrl: f.repoUrl.trim() || null, stack: f.stack }),
    [keys.project(orgId, project.id), keys.projects(orgId), keys.clients(orgId)],
  );
  const del = useAction(() => api("DELETE", `/orgs/${orgId}/projects/${project.id}`), [keys.projects(orgId), keys.clients(orgId)]);
  const edit = can("projects.update");
  const dirty = f.name !== project.name || f.clientId !== (project.clientId ?? "") || f.repoUrl !== (project.repoUrl ?? "") || f.stack !== project.stack;
  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
      <section className="panel" aria-labelledby="ps-h">
        <div className="panel-head"><h2 id="ps-h">Project details</h2></div>
        <form className="panel-body form" onSubmit={async (e) => { e.preventDefault(); if (await save.mutateAsync(undefined).then(() => true).catch(() => false)) toast("Project saved"); }}>
          <fieldset disabled={!edit} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
            <Field label="Project name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} />}</Field>
            <div className="form-grid">
              <Field label="Client">
                {(id) => (
                  <select id={id} className="input" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} required={scoped}>
                    {!scoped && <option value="">No client (your own product)</option>}
                    {scoped && !f.clientId && <option value="">Pick a client</option>}
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Stack">
                {(id) => <select id={id} className="input" value={f.stack} onChange={(e) => setF({ ...f, stack: e.target.value })}>{STACKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
              </Field>
            </div>
            <Field label="Repository URL" hint="Optional. Used to link findings to code.">{(id) => <Input id={id} type="url" value={f.repoUrl} onChange={(e) => setF({ ...f, repoUrl: e.target.value })} placeholder="https://github.com/acme/backend" />}</Field>
          </fieldset>
          <ErrorAlert error={save.error} />
          {edit ? <div><Button variant="primary" type="submit" busy={save.isPending} disabled={!dirty}>Save project</Button></div> : <p className="muted small">You have read-only access to this project.</p>}
          <p className="muted small">Project ID <span className="mono">{project.id}</span></p>
        </form>
      </section>
      {can("projects.delete") && (
        <section className="panel" aria-labelledby="pd-h">
          <div className="panel-head"><h2 id="pd-h">Delete project</h2></div>
          <div className="panel-body" style={{ display: "grid", gap: 10 }}>
            <p className="muted">Deletes its environments, test accounts, API keys, runs and issues. This can't be undone.</p>
            <div><Button variant="danger" onClick={() => setDeleting(true)}>Delete project</Button></div>
          </div>
        </section>
      )}
      {deleting && (
        <Confirm
          title={`Delete ${project.name}?`}
          body="All environments, test accounts, API keys, runs and issues of this project are deleted permanently."
          action="Delete project"
          onConfirm={async () => { await del.mutateAsync(undefined); toast("Project deleted"); nav(`/o/${orgId}/projects`, { replace: true }); }}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}
