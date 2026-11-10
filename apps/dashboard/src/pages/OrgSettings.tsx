import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { keys, useAction, useOrg } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { useCurrentOrg } from "../lib/org";
import { plural } from "../lib/format";
import { Button, Confirm, ErrorAlert, Field, Input, Loading, useToast } from "../components/ui";

function RenameOrg({ name }: { name: string }) {
  const { orgId, can } = useCurrentOrg();
  const { reload } = useAuth();
  const toast = useToast();
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  const save = useAction((n: string) => api("PATCH", `/orgs/${orgId}`, { name: n }), [keys.org(orgId), keys.audit(orgId)]);
  const edit = can("org.update");
  return (
    <section className="panel" aria-labelledby="on-h">
      <div className="panel-head"><h2 id="on-h">Organization</h2></div>
      <form className="panel-body form" onSubmit={async (e) => { e.preventDefault(); if (await save.mutateAsync(v.trim()).then(() => true).catch(() => false)) { await reload(); toast("Organization renamed"); } }}>
        <Field label="Organization name">{(id) => <Input id={id} value={v} onChange={(e) => setV(e.target.value)} required maxLength={120} disabled={!edit} />}</Field>
        <ErrorAlert error={save.error} />
        {edit ? <div><Button variant="primary" type="submit" busy={save.isPending} disabled={v.trim() === name}>Save name</Button></div> : <p className="muted small">Only owners and admins can rename the organization.</p>}
      </form>
    </section>
  );
}

function NewOrg() {
  const { reload } = useAuth();
  const nav = useNavigate();
  const { hash } = useLocation();
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const create = useAction((n: string) => api<{ org: { id: string; name: string } }>("POST", "/orgs", { name: n }));
  useEffect(() => { if (hash === "#new-org") ref.current?.focus(); }, [hash]);
  return (
    <section className="panel" id="new-org" aria-labelledby="no-h">
      <div className="panel-head"><h2 id="no-h">Create another organization</h2></div>
      <form
        className="panel-body form"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await create.mutateAsync(name.trim()).catch(() => null);
          if (r) { await reload(); toast(`Organization "${r.org.name}" created`); nav(`/o/${r.org.id}`); }
        }}
      >
        <p className="muted small">A separate workspace with its own members, projects and billing. You'll be its owner.</p>
        <Field label="New organization name">{(id) => <Input id={id} ref={ref} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />}</Field>
        <ErrorAlert error={create.error} />
        <div><Button type="submit" busy={create.isPending}>Create organization</Button></div>
      </form>
    </section>
  );
}

export function OrgSettingsPage() {
  const { orgId, can } = useCurrentOrg();
  const { reload } = useAuth();
  const nav = useNavigate();
  const q = useOrg(orgId);
  const [deleting, setDeleting] = useState(false);
  const del = useAction(() => api("DELETE", `/orgs/${orgId}`));
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="page-head"><div><h1>Settings</h1></div></div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : (
        <>
          <RenameOrg name={q.data!.name} />
          <NewOrg />
          {can("org.delete") && (
            <section className="panel" aria-labelledby="od-h">
              <div className="panel-head"><h2 id="od-h">Delete organization</h2></div>
              <div className="panel-body" style={{ display: "grid", gap: 10 }}>
                <p className="muted">Deletes {plural(q.data!.counts.projects, "project")}, {plural(q.data!.counts.clients, "client")} and all runs, issues and test accounts, and removes {plural(q.data!.counts.members, "member")}. This can't be undone.</p>
                <div><Button variant="danger" onClick={() => setDeleting(true)}>Delete organization</Button></div>
              </div>
            </section>
          )}
          {deleting && <DeleteOrgConfirm name={q.data!.name} onConfirm={async () => { await del.mutateAsync(undefined); localStorage.removeItem("qa.lastOrg"); await reload(); nav("/", { replace: true }); }} onClose={() => setDeleting(false)} />}
        </>
      )}
    </div>
  );
}

/** Typing the name guards against deleting the wrong organization */
function DeleteOrgConfirm({ name, onConfirm, onClose }: { name: string; onConfirm: () => Promise<unknown>; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  return (
    <Confirm
      title={`Delete ${name}?`}
      body={
        <span style={{ display: "grid", gap: 8 }}>
          <span>Everything in this organization is deleted permanently. Type its name to confirm.</span>
          <Input aria-label="Organization name" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </span>
      }
      action="Delete organization"
      onConfirm={async () => { if (typed.trim() !== name) throw new Error("The name doesn't match."); await onConfirm(); }}
      onClose={onClose}
    />
  );
}
