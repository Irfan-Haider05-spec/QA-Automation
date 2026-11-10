import { Fragment, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { keys, useAction, useCredentials, useEnvironments, useVerification } from "../../api/queries";
import type { Credential, Environment, WebApp } from "../../api/types";
import { useCurrentOrg } from "../../lib/org";
import { Button, Confirm, CopyField, Empty, ErrorAlert, Field, Input, Loading, Modal, useToast, When } from "../../components/ui";

const blankApp = (): WebApp => ({ name: "", baseUrl: "", loginPath: "/login" });

function EnvModal({ env, onClose }: { env?: Environment; onClose: () => void }) {
  const { orgId, can } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const [f, setF] = useState({ name: env?.name ?? "", apiBaseUrl: env?.apiBaseUrl ?? "", disposable: env?.disposable ?? false });
  const [apps, setApps] = useState<WebApp[]>(env?.webApps?.length ? env.webApps : []);
  const save = useAction(
    () => {
      const body = { name: f.name.trim(), apiBaseUrl: f.apiBaseUrl.trim() || null, webApps: apps.filter((a) => a.name || a.baseUrl).map((a) => ({ ...a, name: a.name.trim(), baseUrl: a.baseUrl.trim(), loginPath: a.loginPath.trim() || "/login" })), ...(can("environments.setDisposable") ? { disposable: f.disposable } : {}) };
      return env ? api("PATCH", `/orgs/${orgId}/projects/${projectId}/environments/${env.id}`, body) : api("POST", `/orgs/${orgId}/projects/${projectId}/environments`, body);
    },
    [keys.envs(orgId, projectId), keys.project(orgId, projectId)],
  );
  const setApp = (i: number, k: keyof WebApp, v: string) => setApps(apps.map((a, j) => (j === i ? { ...a, [k]: v } : a)));
  return (
    <Modal
      title={env ? `Edit ${env.name}` : "New environment"}
      description="Where tests run. All URLs of one environment must be on the same host, so one domain check covers them."
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="env-form" busy={save.isPending}>{env ? "Save environment" : "Create environment"}</Button></>}
    >
      <form id="env-form" className="form" onSubmit={async (e) => { e.preventDefault(); if (await save.mutateAsync(undefined).then(() => true).catch(() => false)) { toast(env ? "Environment saved" : `Environment "${f.name.trim()}" created`); onClose(); } }}>
        <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} placeholder="staging" />}</Field>
        <Field label="API base URL" hint="e.g. https://staging-api.example.com">{(id) => <Input id={id} type="url" value={f.apiBaseUrl} onChange={(e) => setF({ ...f, apiBaseUrl: e.target.value })} />}</Field>
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 10 }}>
          <legend style={{ fontWeight: 500, color: "var(--ink-2)", fontSize: 13.5, marginBottom: 6 }}>Dashboards</legend>
          {apps.map((a, i) => (
            <div key={i} className="form-grid" style={{ gridTemplateColumns: "1fr 2fr 1fr auto", alignItems: "end" }}>
              <Field label="Name">{(id) => <Input id={id} value={a.name} onChange={(e) => setApp(i, "name", e.target.value)} placeholder="admin" pattern="[A-Za-z0-9_\-]+" title="Letters, digits, - and _" />}</Field>
              <Field label="URL">{(id) => <Input id={id} type="url" value={a.baseUrl} onChange={(e) => setApp(i, "baseUrl", e.target.value)} placeholder="https://staging.example.com/admin" />}</Field>
              <Field label="Login path">{(id) => <Input id={id} value={a.loginPath} onChange={(e) => setApp(i, "loginPath", e.target.value)} />}</Field>
              <Button type="button" variant="ghost" onClick={() => setApps(apps.filter((_, j) => j !== i))} aria-label={`Remove dashboard ${a.name || i + 1}`}>Remove</Button>
            </div>
          ))}
          <div><Button type="button" size="sm" onClick={() => setApps([...apps, blankApp()])}>Add dashboard</Button></div>
        </fieldset>
        {can("environments.setDisposable") ? (
          <label className="check">
            <input type="checkbox" checked={f.disposable} onChange={(e) => setF({ ...f, disposable: e.target.checked })} />
            <span>Disposable database<br /><span className="muted small">Allow tests that create, change and delete data. Only for throwaway environments, never shared staging.</span></span>
          </label>
        ) : (
          <p className="muted small">Only owners and admins can allow write tests on an environment.</p>
        )}
        <ErrorAlert error={save.error} />
      </form>
    </Modal>
  );
}

function VerifyPanel({ env }: { env: Environment }) {
  const { orgId, can } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const v = useVerification(orgId, projectId, env.id, open && can("environments.manage"));
  const check = useAction(() => api("POST", `/orgs/${orgId}/projects/${projectId}/environments/${env.id}/verify`), [keys.envs(orgId, projectId), keys.project(orgId, projectId)]);
  if (!env.domain) return <p className="muted small">Add a URL to verify the domain.</p>;
  if (env.verifiedAt) return <p className="small"><span className="status passed">Domain verified</span> <span className="muted">· {env.domain} · <When at={env.verifiedAt} /></span></p>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="btn-row">
        <span className="status env_error">Domain not verified</span>
        <span className="muted small">Live tests won't run against {env.domain} until you prove you control it.</span>
        {can("environments.manage") && !open && <Button size="sm" onClick={() => setOpen(true)}>Verify domain</Button>}
      </div>
      {open && (
        v.isLoading ? <Loading /> : v.error ? <ErrorAlert error={v.error} /> : v.data?.instructions && (
          <div className="alert" style={{ display: "grid", gap: 10 }}>
            <p><b>Option 1:</b> add this DNS TXT record</p>
            <CopyField label="DNS record name" value={v.data.instructions.dns.name} />
            <CopyField label="DNS record value" value={v.data.instructions.dns.value} />
            <p><b>Option 2:</b> serve this text at <span className="mono">{v.data.instructions.file.url}</span></p>
            <CopyField label="File content" value={v.data.instructions.file.content} />
            <div className="btn-row">
              <Button
                variant="primary"
                busy={check.isPending}
                onClick={async () => { if (await check.mutateAsync(undefined).then(() => true).catch(() => false)) toast("Domain verified"); }}
              >
                Check now
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>Hide</Button>
            </div>
            {check.error && (
              <div className="alert error" role="alert">
                {check.error instanceof ApiError && check.error.status === 422 ? "We couldn't find the record or the file yet. DNS changes can take a few minutes; try again shortly." : (check.error as Error).message}
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

function CredentialModal({ env, cred, onClose }: { env: Environment; cred?: Credential; onClose: () => void }) {
  const { orgId } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const [f, setF] = useState({ name: cred?.name ?? "", role: cred?.role ?? "", identifier: cred?.identifier ?? "", device: cred?.device ?? "", secret: "" });
  const path = `/orgs/${orgId}/projects/${projectId}/environments/${env.id}/credentials`;
  const save = useAction(
    () => cred
      ? api("PUT", `${path}/${cred.id}`, { role: f.role.trim(), identifier: f.identifier.trim(), device: f.device.trim() || null, ...(f.secret ? { secret: f.secret } : {}) })
      : api("POST", path, { name: f.name.trim(), role: f.role.trim(), identifier: f.identifier.trim(), device: f.device.trim() || null, secret: f.secret }),
    [keys.creds(orgId, projectId, env.id)],
  );
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      title={cred ? `Edit ${cred.name}` : "Add test account"}
      description="A dedicated account the QA engine logs in with. The password is encrypted and can't be viewed again, only replaced."
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="cred-form" busy={save.isPending}>{cred ? "Save account" : "Add account"}</Button></>}
    >
      <form id="cred-form" className="form" autoComplete="off" onSubmit={async (e) => { e.preventDefault(); if (await save.mutateAsync(undefined).then(() => true).catch(() => false)) { toast(cred ? "Account saved" : `Account "${f.name.trim()}" added`); onClose(); } }}>
        <div className="form-grid">
          <Field label="Account name" hint="Used in configs, e.g. merchantA">{(id) => <Input id={id} value={f.name} onChange={set("name")} required disabled={!!cred} pattern="[A-Za-z][A-Za-z0-9_\-]*" title="Start with a letter; letters, digits, - and _" />}</Field>
          <Field label="Role in your app" hint="e.g. MERCHANT, ADMIN, USER">{(id) => <Input id={id} value={f.role} onChange={set("role")} required maxLength={60} />}</Field>
        </div>
        <Field label="Login email or phone">{(id) => <Input id={id} value={f.identifier} onChange={set("identifier")} required maxLength={254} autoComplete="off" />}</Field>
        <Field label="Device" hint="Optional. Some login endpoints need it, e.g. merchant or admin.">{(id) => <Input id={id} value={f.device} onChange={set("device")} maxLength={40} />}</Field>
        <Field label={cred ? "New password" : "Password"} hint={cred ? "Leave empty to keep the current password." : undefined}>
          {(id) => <Input id={id} type="password" value={f.secret} onChange={set("secret")} required={!cred} autoComplete="new-password" />}
        </Field>
        <ErrorAlert error={save.error} />
      </form>
    </Modal>
  );
}

function Credentials({ env }: { env: Environment }) {
  const { orgId, can } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const q = useCredentials(orgId, projectId, env.id);
  const [editing, setEditing] = useState<Credential | "new" | null>(null);
  const [deleting, setDeleting] = useState<Credential | null>(null);
  const del = useAction((c: Credential) => api("DELETE", `/orgs/${orgId}/projects/${projectId}/environments/${env.id}/credentials/${c.id}`), [keys.creds(orgId, projectId, env.id)]);
  const manage = can("credentials.manage");
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <h3>Test accounts</h3>
        {manage && <Button size="sm" onClick={() => setEditing("new")}>Add test account</Button>}
      </div>
      {editing && <CredentialModal env={env} cred={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
      {deleting && <Confirm title={`Delete ${deleting.name}?`} body="The QA engine will no longer be able to log in with this account here." action="Delete account" onConfirm={async () => { await del.mutateAsync(deleting); toast("Account deleted"); }} onClose={() => setDeleting(null)} />}
      {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !q.data!.length ? (
        <p className="muted small">No test accounts. Tenant-isolation and role checks need at least two accounts from different tenants.</p>
      ) : (
        <div className="table-wrap" style={{ border: "1px solid var(--rule)", borderRadius: 6 }}>
          <table className="table">
            <thead><tr><th>Account</th><th>Role</th><th>Login</th><th>Password</th><th>Last used</th>{manage && <th><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody>
              {q.data!.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.name}</td>
                  <td>{c.role}</td>
                  <td>{c.identifier}{c.device && <span className="muted small"> · {c.device}</span>}</td>
                  <td className="muted">Stored encrypted</td>
                  <td className="nowrap"><When at={c.lastUsedAt} /></td>
                  {manage && (
                    <td style={{ textAlign: "right" }}>
                      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                        <Button size="sm" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>Edit</Button>
                        <Button size="sm" variant="danger" onClick={() => setDeleting(c)} aria-label={`Delete ${c.name}`}>Delete</Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function EnvironmentsTab() {
  const { orgId, can } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const q = useEnvironments(orgId, projectId);
  const [editing, setEditing] = useState<Environment | "new" | null>(null);
  const [deleting, setDeleting] = useState<Environment | null>(null);
  const del = useAction((e: Environment) => api("DELETE", `/orgs/${orgId}/projects/${projectId}/environments/${e.id}`), [keys.envs(orgId, projectId), keys.project(orgId, projectId)]);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <p className="muted">Staging and test environments the QA engine runs against.</p>
        {can("environments.manage") && <Button variant="primary" onClick={() => setEditing("new")}>New environment</Button>}
      </div>
      {editing && <EnvModal env={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
      {deleting && <Confirm title={`Delete ${deleting.name}?`} body="Its test accounts are deleted too. Past runs stay, without a link to this environment." action="Delete environment" onConfirm={async () => { await del.mutateAsync(deleting); toast("Environment deleted"); }} onClose={() => setDeleting(null)} />}
      {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !q.data!.length ? (
        <div className="panel"><Empty title="No environments">Add your staging URLs so runs can target them and record where they ran.</Empty></div>
      ) : (
        q.data!.map((env) => (
          <section key={env.id} className="panel" aria-label={`Environment ${env.name}`}>
            <div className="panel-head">
              <div>
                <h2>{env.name} {env.disposable && <span className="tag" style={{ marginLeft: 6 }}>Disposable: write tests allowed</span>}</h2>
                <p className="muted small mono" style={{ marginTop: 2 }}>{env.apiBaseUrl ?? "No API URL"}</p>
                <p className="muted small" style={{ marginTop: 2 }}>Environment ID <span className="mono">{env.id}</span></p>
              </div>
              <div className="btn-row">
                {can("environments.manage") && <Button size="sm" onClick={() => setEditing(env)}>Edit</Button>}
                {can("projects.delete") && <Button size="sm" variant="danger" onClick={() => setDeleting(env)}>Delete</Button>}
              </div>
            </div>
            <div className="panel-body">
              {env.webApps.length > 0 && (
                <dl className="kv">
                  {env.webApps.map((a) => <Fragment key={a.name}><dt>{a.name}</dt><dd className="mono small">{a.baseUrl} <span className="muted">(login {a.loginPath})</span></dd></Fragment>)}
                </dl>
              )}
              <VerifyPanel env={env} />
              <Credentials env={env} />
            </div>
          </section>
        ))
      )}
    </div>
  );
}
