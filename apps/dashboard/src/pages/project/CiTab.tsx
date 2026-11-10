import { useMemo, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { useApiKeys, useCredentials, useDeployments, useEnvironments } from "../../api/queries";
import type { Project } from "../../api/types";
import { useCurrentOrg } from "../../lib/org";
import { configTs, workflowYaml } from "../../lib/ci";
import { Button, Empty, ErrorAlert, Field, Input, Loading, RunStatusLabel, When } from "../../components/ui";

/** A generated file: shown in full, with copy and download */
function FileBlock({ name, content, label }: { name: string; content: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name.split("/").pop()! });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="panel" aria-label={label}>
      <div className="panel-head">
        <h3 className="mono" style={{ fontSize: 14 }}>{name}</h3>
        <div className="btn-row">
          <Button size="sm" onClick={async () => { try { await navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } }}>{copied ? "Copied" : "Copy"}</Button>
          <Button size="sm" onClick={download}>Download</Button>
        </div>
      </div>
      {/* tabIndex: the box scrolls, so keyboard users must be able to reach it */}
      <pre className="code file" data-testid={`file-${name}`} tabIndex={0} aria-label={`Contents of ${name}`}>{content}</pre>
    </section>
  );
}

function Deployments() {
  const { orgId } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const q = useDeployments(orgId, projectId);
  const base = `/o/${orgId}/projects/${projectId}`;
  return (
    <section className="panel" aria-labelledby="dep-h">
      <div className="panel-head"><h2 id="dep-h">Recent deployments</h2></div>
      {q.isLoading ? <Loading /> : q.error ? <div className="panel-body"><ErrorAlert error={q.error} /></div> : !q.data!.length ? (
        <Empty title="No deployments reported yet">The staging job reports each deploy before testing it, so you can see which version broke what.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Version</th><th>Environment</th><th>Reported</th><th>Check</th></tr></thead>
            <tbody>
              {q.data!.map((d) => (
                <tr key={d.id} data-testid="deployment-row">
                  <td><span className="mono">{d.version ?? d.sha?.slice(0, 8) ?? "Unnamed"}</span>{d.ref && <span className="muted small"> · {d.ref}</span>}</td>
                  <td>{d.environmentName ?? <span className="muted">None</span>}</td>
                  <td className="nowrap"><When at={d.createdAt} /></td>
                  <td>{d.lastRun ? <Link to={`${base}/runs/${d.lastRun.id}`}><RunStatusLabel status={d.lastRun.status} /></Link> : <span className="muted">Not tested yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function CiTab() {
  const project = useOutletContext<Project>();
  const { orgId, can } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const envs = useEnvironments(orgId, projectId);
  const keysQ = useApiKeys(orgId, projectId, can("apiKeys.manage"));
  // null = not chosen yet (pick the first environment); "" = the user chose pull requests only
  const [picked, setPicked] = useState<string | null>(null);
  const [branch, setBranch] = useState("staging");
  const [actionRef, setActionRef] = useState("your-org/qa-agent@v1");
  const envId = picked ?? envs.data?.[0]?.id ?? "";
  const setEnvId = (v: string) => setPicked(v);
  const env = envs.data?.find((e) => e.id === envId) ?? null;
  const creds = useCredentials(orgId, projectId, envId, !!envId);
  const activeKeys = (keysQ.data ?? []).filter((k) => !k.revokedAt);
  const platformAccounts = activeKeys.some((k) => k.scopes.includes("credentials:read"));
  const base = `/o/${orgId}/projects/${projectId}`;

  const workflow = useMemo(
    () => workflowYaml({ platformUrl: location.origin, environmentId: env?.id ?? null, actionRef: actionRef.trim() || "your-org/qa-agent@v1", stagingBranch: branch.trim() || "staging", platformAccounts }),
    [env, actionRef, branch, platformAccounts],
  );
  const config = useMemo(
    () => configTs({ projectName: project.name, stack: project.stack, accounts: envId && creds.data ? creds.data.map((c) => ({ name: c.name, role: c.role })) : [] }),
    [project.name, project.stack, creds.data, envId],
  );

  if (envs.isLoading) return <Loading />;
  if (envs.error) return <ErrorAlert error={envs.error} />;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
      <section className="panel" aria-labelledby="ci-h">
        <div className="panel-head"><h2 id="ci-h">Run the QA agent in GitHub Actions</h2></div>
        <div className="panel-body" style={{ display: "grid", gap: 14 }}>
          <p className="muted">Every pull request gets a comment and a "QA gate" check; every staging deploy is tested and recorded here.</p>
          <ol className="steps">
            <li>
              {activeKeys.length ? <>Use an API key from <Link to={`${base}/api-keys`}>API keys</Link> ({activeKeys.length} active).</> : <><Link to={`${base}/api-keys`}>Create an API key</Link> for this project.</>}{" "}
              Add it to the repository as the secret <code>QA_PLATFORM_API_KEY</code> (Settings → Secrets and variables → Actions).
            </li>
            {env && <li>Add the repository variable <code>QA_STAGING_URL</code>{env.apiBaseUrl && <> = <code>{env.apiBaseUrl}</code></>}.</li>}
            <li>Commit the two files below to the repository.</li>
          </ol>
          {!platformAccounts && env && (
            <div className="alert">
              Test accounts are read from CI env vars (see the config file). To use the accounts stored on this project instead, an owner or admin can create a key that can read test-account passwords.
            </div>
          )}
          <div className="form-grid">
            <Field label="Staging environment" hint="Leave empty for pull-request checks only">
              {(id) => (
                <select id={id} className="input" value={envId} onChange={(e) => setEnvId(e.target.value)}>
                  <option value="">None (pull requests only)</option>
                  {envs.data!.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              )}
            </Field>
            <Field label="Branch that deploys to staging" hint="A push to it runs the staging check">{(id) => <Input id={id} value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!env} />}</Field>
            <Field label="GitHub Action" hint="Where your organization hosts the QA agent action">{(id) => <Input id={id} value={actionRef} onChange={(e) => setActionRef(e.target.value)} />}</Field>
          </div>
          {!envs.data!.length && <p className="muted small">No environments yet. <Link to={`${base}/environments`}>Add staging</Link> to also test deploys.</p>}
        </div>
      </section>
      <FileBlock name=".github/workflows/qa.yml" content={workflow} label="Workflow file" />
      <FileBlock name="qa.config.ts" content={config} label="Config file" />
      <Deployments />
    </div>
  );
}
