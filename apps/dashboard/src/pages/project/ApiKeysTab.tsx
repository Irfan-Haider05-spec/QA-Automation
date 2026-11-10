import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { keys, useAction, useApiKeys } from "../../api/queries";
import type { ApiKey } from "../../api/types";
import { useCurrentOrg } from "../../lib/org";
import { Button, Confirm, CopyField, Empty, ErrorAlert, Field, Input, Loading, Modal, useToast, When } from "../../components/ui";

function NewKeyModal({ onClose }: { onClose: () => void }) {
  const { orgId, role } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const [name, setName] = useState("");
  const [readAccounts, setReadAccounts] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const mayReadAccounts = role === "owner" || role === "admin";
  const create = useAction(
    (n: string) => api<{ apiKey: ApiKey; key: string }>("POST", `/orgs/${orgId}/projects/${projectId}/api-keys`, { name: n, scopes: readAccounts ? ["credentials:read"] : [] }),
    [keys.apiKeys(orgId, projectId)],
  );
  if (created) {
    return (
      <Modal title="Copy your API key" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="secret-once" style={{ display: "grid", gap: 10 }}>
          <p><b>This is the only time the key is shown.</b> Store it as a secret in your CI named <span className="mono">QA_PLATFORM_API_KEY</span>.</p>
          <CopyField label="API key" value={created} />
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          For GitHub, the <Link to={`/o/${orgId}/projects/${projectId}/ci`}>CI setup</Link> tab generates the workflow. From a laptop or another CI:
        </p>
        <pre className="code">{`QA_PLATFORM_URL=${location.origin}\nQA_PLATFORM_API_KEY=<this key>\nnpm run -s qa -- run --upload --platform-env <environment id>`}</pre>
      </Modal>
    );
  }
  return (
    <Modal
      title="New API key"
      description="Lets a runner (CLI, CI pipeline) upload results to this project."
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="key-form" busy={create.isPending}>Create key</Button></>}
    >
      <form id="key-form" className="form" onSubmit={async (e) => { e.preventDefault(); const r = await create.mutateAsync(name.trim()).catch(() => null); if (r) { toast(`API key "${r.apiKey.name}" created`); setCreated(r.key); } }}>
        <Field label="Key name" hint="Where it's used, e.g. GitHub Actions">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />}</Field>
        {mayReadAccounts ? (
          <label className="check">
            <input type="checkbox" checked={readAccounts} onChange={(e) => setReadAccounts(e.target.checked)} />
            <span>Can read test-account passwords<br /><span className="muted small">CI then logs in with the accounts stored on this project, so you don't copy passwords into CI secrets. Anyone holding the key can read them.</span></span>
          </label>
        ) : (
          <p className="muted small">Keys that can read test-account passwords can only be created by owners and admins.</p>
        )}
        <ErrorAlert error={create.error} />
      </form>
    </Modal>
  );
}

export function ApiKeysTab() {
  const { orgId, can } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const manage = can("apiKeys.manage");
  const q = useApiKeys(orgId, projectId, manage);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const revoke = useAction((k: ApiKey) => api("DELETE", `/orgs/${orgId}/projects/${projectId}/api-keys/${k.id}`), [keys.apiKeys(orgId, projectId)]);
  if (!manage) return <div className="panel"><Empty title="API keys are managed by developers and admins">Ask a developer, admin or owner of this organization for a key.</Empty></div>;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <p className="muted">Keys that runners use to upload results to this project.</p>
        <Button variant="primary" onClick={() => setCreating(true)}>New API key</Button>
      </div>
      {creating && <NewKeyModal onClose={() => setCreating(false)} />}
      {revoking && <Confirm title={`Revoke ${revoking.name}?`} body="Runners using this key will be refused immediately. This can't be undone." action="Revoke key" onConfirm={async () => { await revoke.mutateAsync(revoking); toast("API key revoked"); }} onClose={() => setRevoking(null)} />}
      {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !q.data!.length ? (
        <div className="panel"><Empty title="No API keys">Create one to upload runs from your CI or the command line.</Empty></div>
      ) : (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Key</th><th>Can</th><th>Created</th><th>Last used</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {q.data!.map((k) => (
                <tr key={k.id} className={k.revokedAt ? "muted" : undefined}>
                  <td style={{ fontWeight: 600 }}>{k.name}</td>
                  <td className="mono small">{k.prefix}…</td>
                  <td className="small">{k.scopes.includes("credentials:read") ? "Upload runs, read test-account passwords" : "Upload runs"}</td>
                  <td className="nowrap"><When at={k.createdAt} /></td>
                  <td className="nowrap"><When at={k.lastUsedAt} /></td>
                  <td>{k.revokedAt ? <span className="status skipped">Revoked</span> : <span className="status passed">Active</span>}</td>
                  <td style={{ textAlign: "right" }}>{!k.revokedAt && <Button size="sm" variant="danger" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}>Revoke</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
