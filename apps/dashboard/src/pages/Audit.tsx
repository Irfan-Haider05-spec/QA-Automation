import { useMemo, useState } from "react";
import { useAudit } from "../api/queries";
import type { AuditEvent } from "../api/types";
import { useCurrentOrg } from "../lib/org";
import { Empty, ErrorAlert, Input, Loading, When } from "../components/ui";

const ACTION_TEXT: Record<string, string> = {
  "org.created": "created the organization",
  "org.updated": "renamed the organization",
  "client.created": "created a client",
  "client.updated": "renamed a client",
  "client.deleted": "deleted a client",
  "project.created": "created a project",
  "project.updated": "updated a project",
  "project.deleted": "deleted a project",
  "environment.created": "created an environment",
  "environment.updated": "updated an environment",
  "environment.deleted": "deleted an environment",
  "environment.verified": "verified a domain",
  "credential.created": "added a test account",
  "credential.updated": "updated a test account",
  "credential.deleted": "deleted a test account",
  "api_key.created": "created an API key",
  "api_key.revoked": "revoked an API key",
  "invite.created": "invited a member",
  "invite.revoked": "revoked an invite",
  "invite.accepted": "accepted an invite",
  "member.updated": "changed a member's access",
  "member.removed": "removed a member",
  "member.left": "left the organization",
  "issue.triaged": "triaged an issue",
  "run.uploaded": "uploaded a run",
  "deployment.reported": "reported a deployment",
  "credentials.fetched": "handed test accounts to a runner",
  "job.requested": "started a hosted run",
  "job.cancelled": "cancelled a hosted run",
  "job.failed": "had a hosted run fail to start",
  "schedule.created": "created a schedule",
  "schedule.updated": "changed a schedule",
  "schedule.deleted": "deleted a schedule",
};

/** The one most useful detail of an event, shown after the action */
function detail(e: AuditEvent): string {
  const d = e.data ?? {};
  return d.name ?? d.email ?? d.domain ?? d.prefix ?? (d.status ? `status ${d.status}` : d.role ? `role ${d.role}` : "");
}

export function AuditPage() {
  const { orgId, can } = useCurrentOrg();
  const q = useAudit(orgId);
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    // Match what the user sees (the plain-language action), plus the raw action name
    return (q.data ?? []).filter((e) => !f || `${ACTION_TEXT[e.action] ?? ""} ${e.action} ${e.actorName ?? ""} ${detail(e)}`.toLowerCase().includes(f));
  }, [q.data, filter]);
  if (!can("audit.read")) return <div className="page"><div className="panel"><Empty title="Only owners and admins can see the audit log" /></div></div>;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Audit log</h1><p className="sub">Who changed what in this organization. Passwords and keys are never recorded.</p></div>
        <Input type="search" placeholder="Filter events" aria-label="Filter events" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 260 }} />
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !rows.length ? (
        <div className="panel"><Empty title={filter ? "No matching events" : "No events yet"} /></div>
      ) : (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} data-testid="audit-row">
                  <td className="nowrap"><When at={e.createdAt} /></td>
                  <td>{e.actorName ?? (e.actorApiKeyId ? <span className="muted">API key</span> : e.data?.hostedRunner ? <span className="muted">Hosted runner</span> : <span className="muted">System</span>)}</td>
                  <td>{ACTION_TEXT[e.action] ?? e.action}</td>
                  <td className="muted">{detail(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
