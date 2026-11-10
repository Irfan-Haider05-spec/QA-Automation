import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { keys, useAction, useClients, useInvites, useMembers } from "../api/queries";
import type { Client, Invite, Member, Role } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useCurrentOrg } from "../lib/org";
import { Button, Confirm, CopyField, Empty, ErrorAlert, Field, Input, Loading, Modal, useToast, When } from "../components/ui";

const ROLE_INFO: Record<Role, string> = {
  owner: "Everything, including deleting the organization",
  admin: "Manage members, clients, projects and settings",
  developer: "Create projects, environments and keys; triage issues",
  viewer: "Read-only",
};
const ROLE_NAME: Record<Role, string> = { owner: "Owner", admin: "Admin", developer: "Developer", viewer: "Viewer" };

/** "All clients" (null) or a chosen list */
function ClientScope({ clients, value, onChange }: { clients: Client[]; value: string[] | null; onChange: (v: string[] | null) => void }) {
  if (!clients.length) return <p className="muted small">No clients in this organization, so access can't be limited by client.</p>;
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
      <legend style={{ fontWeight: 500, color: "var(--ink-2)", fontSize: 13.5, marginBottom: 6 }}>Access</legend>
      <label className="check"><input type="radio" name="scope" checked={value === null} onChange={() => onChange(null)} /><span>All projects</span></label>
      <label className="check"><input type="radio" name="scope" checked={value !== null} onChange={() => onChange([])} /><span>Only some clients' projects</span></label>
      {value !== null && (
        <div style={{ display: "grid", gap: 4, paddingLeft: 24 }}>
          {clients.map((c) => (
            <label key={c.id} className="check">
              <input type="checkbox" checked={value.includes(c.id)} onChange={(e) => onChange(e.target.checked ? [...value, c.id] : value.filter((x) => x !== c.id))} />
              <span>{c.name}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function RoleSelect({ value, onChange, allowOwner, id }: { value: Role; onChange: (r: Role) => void; allowOwner: boolean; id: string }) {
  const roles: Role[] = allowOwner ? ["owner", "admin", "developer", "viewer"] : ["admin", "developer", "viewer"];
  return (
    <>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value as Role)}>
        {roles.map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}
      </select>
      <span className="muted small">{ROLE_INFO[value]}</span>
    </>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const { orgId } = useCurrentOrg();
  const clients = useClients(orgId).data ?? [];
  const toast = useToast();
  const [f, setF] = useState<{ email: string; role: Role; clientIds: string[] | null }>({ email: "", role: "developer", clientIds: null });
  const [link, setLink] = useState<string | null>(null);
  const create = useAction(() => api<{ invite: Invite; token: string }>("POST", `/orgs/${orgId}/invites`, { email: f.email.trim(), role: f.role, clientIds: f.clientIds }), [keys.invites(orgId), keys.audit(orgId)]);
  if (link) {
    return (
      <Modal title="Share the invite link" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="secret-once">
          <p><b>This link is shown once.</b> Send it to {f.email.trim()}. They sign in or create an account with that email, then accept.</p>
          <CopyField label="Invite link" value={link} />
        </div>
      </Modal>
    );
  }
  const scopeInvalid = f.clientIds !== null && f.clientIds.length === 0;
  return (
    <Modal
      title="Invite member"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="invite-form" busy={create.isPending} disabled={scopeInvalid}>Create invite</Button></>}
    >
      <form
        id="invite-form"
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await create.mutateAsync(undefined).catch(() => null);
          if (r) { toast(`Invite created for ${r.invite.email}`); setLink(`${location.origin}/invite?token=${encodeURIComponent(r.token)}`); }
        }}
      >
        <Field label="Email">{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required maxLength={254} />}</Field>
        <Field label="Role">{(id) => <RoleSelect id={id} value={f.role} onChange={(role) => setF({ ...f, role })} allowOwner={false} />}</Field>
        <ClientScope clients={clients} value={f.clientIds} onChange={(clientIds) => setF({ ...f, clientIds })} />
        {scopeInvalid && <p className="muted small">Pick at least one client.</p>}
        <ErrorAlert error={create.error} />
      </form>
    </Modal>
  );
}

function EditMemberModal({ member, onClose }: { member: Member; onClose: () => void }) {
  const { orgId, role: myRole } = useCurrentOrg();
  const clients = useClients(orgId).data ?? [];
  const toast = useToast();
  const [f, setF] = useState<{ role: Role; clientIds: string[] | null }>({ role: member.role, clientIds: member.clientIds });
  const save = useAction(() => api("PATCH", `/orgs/${orgId}/members/${member.userId}`, { role: f.role, clientIds: f.clientIds }), [keys.members(orgId), keys.audit(orgId)]);
  const scopeInvalid = f.clientIds !== null && f.clientIds.length === 0;
  return (
    <Modal
      title={`Edit ${member.name}`}
      description={member.email}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="member-form" busy={save.isPending} disabled={scopeInvalid}>Save member</Button></>}
    >
      <form id="member-form" className="form" onSubmit={async (e) => { e.preventDefault(); if (await save.mutateAsync(undefined).then(() => true).catch(() => false)) { toast("Member saved"); onClose(); } }}>
        <Field label="Role">{(id) => <RoleSelect id={id} value={f.role} onChange={(role) => setF({ ...f, role })} allowOwner={myRole === "owner"} />}</Field>
        <ClientScope clients={clients} value={f.clientIds} onChange={(clientIds) => setF({ ...f, clientIds })} />
        {scopeInvalid && <p className="muted small">Pick at least one client.</p>}
        <ErrorAlert error={save.error} />
      </form>
    </Modal>
  );
}

export function MembersPage() {
  const { orgId, can, role: myRole } = useCurrentOrg();
  const { user, reload } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const manage = can("members.manage");
  const members = useMembers(orgId);
  const invites = useInvites(orgId, manage);
  const clients = useClients(orgId).data ?? [];
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "Unknown client";
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<Invite | null>(null);
  const remove = useAction((m: Member) => api("DELETE", `/orgs/${orgId}/members/${m.userId}`), [keys.members(orgId), keys.audit(orgId)]);
  const revoke = useAction((i: Invite) => api("DELETE", `/orgs/${orgId}/invites/${i.id}`), [keys.invites(orgId), keys.audit(orgId)]);
  const canTouch = (m: Member) => manage && m.userId !== user?.id && (m.role !== "owner" || myRole === "owner");
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Members</h1><p className="sub">People in this organization and what they can do.</p></div>
        {manage && <Button variant="primary" onClick={() => setInviting(true)}>Invite member</Button>}
      </div>
      {inviting && <InviteModal onClose={() => setInviting(false)} />}
      {editing && <EditMemberModal member={editing} onClose={() => setEditing(null)} />}
      {removing && (
        <Confirm
          title={removing.userId === user?.id ? "Leave this organization?" : `Remove ${removing.name}?`}
          body={removing.userId === user?.id ? "You'll lose access to all of its projects until someone invites you again." : `${removing.name} loses access to all projects in this organization.`}
          action={removing.userId === user?.id ? "Leave organization" : "Remove member"}
          onConfirm={async () => {
            const self = removing.userId === user?.id;
            await remove.mutateAsync(removing);
            if (self) { await reload(); nav("/", { replace: true }); } else toast("Member removed");
          }}
          onClose={() => setRemoving(null)}
        />
      )}
      {revoking && <Confirm title={`Revoke invite for ${revoking.email}?`} body="The invite link stops working." action="Revoke invite" onConfirm={async () => { await revoke.mutateAsync(revoking); toast("Invite revoked"); }} onClose={() => setRevoking(null)} />}

      {members.isLoading ? <Loading /> : members.error ? <ErrorAlert error={members.error} /> : (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Role</th><th>Access</th><th>Joined</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {members.data!.map((m) => (
                <tr key={m.userId} data-testid="member-row">
                  <td><div style={{ fontWeight: 600 }}>{m.name}{m.userId === user?.id && <span className="muted"> (you)</span>}</div><div className="muted small">{m.email}</div></td>
                  <td>{ROLE_NAME[m.role]}</td>
                  <td>{m.clientIds ? m.clientIds.map(clientName).join(", ") || "No clients" : <span className="muted">All projects</span>}</td>
                  <td className="nowrap"><When at={m.joinedAt} /></td>
                  <td style={{ textAlign: "right" }}>
                    <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                      {canTouch(m) && <Button size="sm" onClick={() => setEditing(m)} aria-label={`Edit ${m.name}`}>Edit</Button>}
                      {canTouch(m) && <Button size="sm" variant="danger" onClick={() => setRemoving(m)} aria-label={`Remove ${m.name}`}>Remove</Button>}
                      {m.userId === user?.id && <Button size="sm" onClick={() => setRemoving(m)}>Leave</Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manage && (
        <section aria-labelledby="inv-h" style={{ display: "grid", gap: 10 }}>
          <h2 id="inv-h">Pending invites</h2>
          {invites.isLoading ? <Loading /> : invites.error ? <ErrorAlert error={invites.error} /> : !invites.data!.length ? (
            <div className="panel"><Empty title="No pending invites" /></div>
          ) : (
            <div className="panel table-wrap">
              <table className="table">
                <thead><tr><th>Email</th><th>Role</th><th>Access</th><th>Expires</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {invites.data!.map((i) => (
                    <tr key={i.id} data-testid="invite-row">
                      <td>{i.email}</td>
                      <td>{ROLE_NAME[i.role]}</td>
                      <td>{i.clientIds ? i.clientIds.map(clientName).join(", ") : <span className="muted">All projects</span>}</td>
                      <td className="nowrap">{new Date(i.expiresAt).toLocaleDateString()}</td>
                      <td style={{ textAlign: "right" }}><Button size="sm" variant="danger" onClick={() => setRevoking(i)} aria-label={`Revoke invite for ${i.email}`}>Revoke</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
