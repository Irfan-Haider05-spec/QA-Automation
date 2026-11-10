import { useState } from "react";
import { api } from "../api/client";
import { keys, useAction, useClients } from "../api/queries";
import type { Client } from "../api/types";
import { useCurrentOrg } from "../lib/org";
import { Button, Confirm, Empty, ErrorAlert, Field, Input, Loading, Modal, useToast } from "../components/ui";

function ClientModal({ client, onClose }: { client?: Client; onClose: () => void }) {
  const { orgId } = useCurrentOrg();
  const toast = useToast();
  const [name, setName] = useState(client?.name ?? "");
  const save = useAction(
    (n: string) => (client ? api("PATCH", `/orgs/${orgId}/clients/${client.id}`, { name: n }) : api("POST", `/orgs/${orgId}/clients`, { name: n })),
    [keys.clients(orgId), keys.projects(orgId)],
  );
  return (
    <Modal
      title={client ? "Rename client" : "New client"}
      description={client ? undefined : "A customer whose projects you test. Members can be limited to specific clients."}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="client-form" busy={save.isPending}>{client ? "Save name" : "Create client"}</Button></>}
    >
      <form id="client-form" className="form" onSubmit={async (e) => { e.preventDefault(); if (await save.mutateAsync(name.trim()).then(() => true).catch(() => false)) { toast(client ? "Client renamed" : `Client "${name.trim()}" created`); onClose(); } }}>
        <Field label="Client name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />}</Field>
        <ErrorAlert error={save.error} />
      </form>
    </Modal>
  );
}

export function ClientsPage() {
  const { orgId, can } = useCurrentOrg();
  const q = useClients(orgId);
  const toast = useToast();
  const [editing, setEditing] = useState<Client | "new" | null>(null);
  const [deleting, setDeleting] = useState<Client | null>(null);
  const del = useAction((c: Client) => api("DELETE", `/orgs/${orgId}/clients/${c.id}`), [keys.clients(orgId)]);
  const manage = can("clients.manage");
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Clients</h1><p className="sub">The customers your projects belong to. Agencies use clients to keep each customer's work and access separate.</p></div>
        {manage && <Button variant="primary" onClick={() => setEditing("new")}>New client</Button>}
      </div>
      {editing && <ClientModal client={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <Confirm
          title={`Delete ${deleting.name}?`}
          body="The client is removed. A client that still has projects can't be deleted; move or delete its projects first."
          action="Delete client"
          onConfirm={async () => { await del.mutateAsync(deleting); toast("Client deleted"); }}
          onClose={() => setDeleting(null)}
        />
      )}
      <ErrorAlert error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? (
        <div className="panel"><Empty title="No clients">{manage ? "Testing your own product only? You don't need clients. Agencies add one per customer." : "No clients you can see yet."}</Empty></div>
      ) : (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>Client</th><th className="num">Projects</th>{manage && <th><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td className="num">{c.projectCount}</td>
                  {manage && (
                    <td style={{ textAlign: "right" }}>
                      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                        <Button size="sm" onClick={() => setEditing(c)} aria-label={`Rename ${c.name}`}>Rename</Button>
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
