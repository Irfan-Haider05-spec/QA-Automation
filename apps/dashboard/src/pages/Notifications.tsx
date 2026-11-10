import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { keys, useAction, useChannels, useDeliveries, useProjects } from "../api/queries";
import type { Channel, NotifyEvent } from "../api/types";
import { useCurrentOrg } from "../lib/org";
import { Button, Confirm, CopyField, Empty, ErrorAlert, Field, Input, Loading, Modal, useToast, When } from "../components/ui";

export const EVENT_INFO: Record<NotifyEvent, { label: string; detail: string }> = {
  "run.failed": { label: "Quality gate failed", detail: "A run found new problems at or above the gate level" },
  "run.recovered": { label: "Passing again", detail: "The first passing run after a failed one" },
  "run.env_error": { label: "Environment unreachable", detail: "The tested site didn't answer, so nothing was checked" },
  "issue.regression": { label: "Fixed issue came back", detail: "Something marked fixed was found again" },
  "job.error": { label: "Hosted run couldn't run", detail: "Run now or a schedule failed to start or finish" },
};
const KIND_LABEL: Record<Channel["kind"], string> = { slack: "Slack", email: "Email", webhook: "Webhook" };
const STATUS_LABEL = { queued: "Waiting to retry", sending: "Sending", sent: "Delivered", failed: "Not delivered" } as const;
const statusText = (d: { status: keyof typeof STATUS_LABEL; attempts: number }) => (d.status === "queued" && d.attempts === 0 ? "Waiting to send" : STATUS_LABEL[d.status]);

function ChannelModal({ channel, emailAvailable, onClose }: { channel?: Channel; emailAvailable: boolean; onClose: () => void }) {
  const { orgId } = useCurrentOrg();
  const toast = useToast();
  const projects = useProjects(orgId).data ?? [];
  const [kind, setKind] = useState<Channel["kind"]>(channel?.kind ?? "slack");
  const [name, setName] = useState(channel?.name ?? "");
  const [url, setUrl] = useState("");
  const [recipients, setRecipients] = useState((channel?.recipients ?? []).join(", "));
  const [events, setEvents] = useState<NotifyEvent[]>(channel?.events ?? ["run.failed", "run.recovered", "issue.regression"]);
  const [projectIds, setProjectIds] = useState<string[] | null>(channel?.projectIds ?? null);
  const [includeLocal, setIncludeLocal] = useState(channel?.includeLocal ?? false);
  const [secret, setSecret] = useState<string | null>(null);
  const emails = recipients.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  const save = useAction(() => {
    const body = {
      name: name.trim(), events, projectIds, includeLocal,
      ...(kind === "email" ? { recipients: emails } : url.trim() ? { url: url.trim() } : {}),
    };
    return channel
      ? api<{ channel: Channel }>("PATCH", `/orgs/${orgId}/notifications/${channel.id}`, body)
      : api<{ channel: Channel; signingSecret?: string }>("POST", `/orgs/${orgId}/notifications`, { ...body, kind });
  }, [keys.channels(orgId)]);
  if (secret) {
    return (
      <Modal title="Copy the signing secret" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="secret-once" style={{ display: "grid", gap: 10 }}>
          <p><b>Shown once.</b> Your receiver checks that each request really comes from this platform: <span className="mono">X-QA-Signature</span> is <span className="mono">sha256=</span> + HMAC-SHA256 of <span className="mono">{"{X-QA-Timestamp}.{body}"}</span> with this secret.</p>
          <CopyField label="Signing secret" value={secret} />
        </div>
      </Modal>
    );
  }
  const invalid = !events.length || (projectIds !== null && !projectIds.length) || (kind === "email" && !emails.length) || (!channel && kind !== "email" && !url.trim());
  return (
    <Modal
      title={channel ? `Edit ${channel.name}` : "New notification channel"}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="channel-form" busy={save.isPending} disabled={invalid}>{channel ? "Save channel" : "Create channel"}</Button></>}
    >
      <form
        id="channel-form"
        className="form"
        autoComplete="off"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await save.mutateAsync(undefined).catch(() => null);
          if (!r) return;
          toast(channel ? "Channel saved" : `Channel "${r.channel.name}" created`);
          const signing = (r as { signingSecret?: string }).signingSecret;
          if (signing) setSecret(signing);
          else onClose();
        }}
      >
        {!channel && (
          <div className="seg" role="group" aria-label="Send to">
            {(["slack", "email", "webhook"] as const).map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>)}
          </div>
        )}
        <Field label="Name" hint={kind === "slack" ? "e.g. #qa-alerts" : kind === "email" ? "e.g. Client PM" : "e.g. Ops pager"}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />}</Field>
        {kind === "email" ? (
          !emailAvailable && !channel ? <div className="alert error" role="alert">Email isn't set up on this platform yet. Use Slack or a webhook, or ask the platform admin to configure outgoing mail.</div> : (
            <Field label="Email addresses" hint="Separate with commas; up to 20">
              {(id) => <textarea id={id} className="input" rows={2} value={recipients} onChange={(e) => setRecipients(e.target.value)} required />}
            </Field>
          )
        ) : (
          <Field
            label={kind === "slack" ? "Slack incoming-webhook URL" : "Webhook URL"}
            hint={channel ? `Current: ${channel.targetHint}. Leave empty to keep it.` : kind === "slack" ? "In Slack: Apps → Incoming Webhooks → Add to a channel → copy the URL (https://hooks.slack.com/…)" : "We POST JSON, signed with a secret you'll get after saving"}
          >
            {(id) => <Input id={id} type="url" value={url} onChange={(e) => setUrl(e.target.value)} required={!channel} placeholder={kind === "slack" ? "https://hooks.slack.com/services/…" : "https://"} />}
          </Field>
        )}
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
          <legend style={{ fontWeight: 500, color: "var(--ink-2)", fontSize: 13.5, marginBottom: 6 }}>Send a message when</legend>
          {(Object.keys(EVENT_INFO) as NotifyEvent[]).map((ev) => (
            <label key={ev} className="check">
              <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} />
              <span>{EVENT_INFO[ev].label}<br /><span className="muted small">{EVENT_INFO[ev].detail}</span></span>
            </label>
          ))}
        </fieldset>
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
          <legend style={{ fontWeight: 500, color: "var(--ink-2)", fontSize: 13.5, marginBottom: 6 }}>For</legend>
          <label className="check"><input type="radio" name="projects" checked={projectIds === null} onChange={() => setProjectIds(null)} /><span>All projects, including new ones</span></label>
          <label className="check"><input type="radio" name="projects" checked={projectIds !== null} onChange={() => setProjectIds([])} /><span>Only some projects</span></label>
          {projectIds !== null && (
            <div style={{ display: "grid", gap: 4, paddingLeft: 24 }}>
              {projects.map((p) => (
                <label key={p.id} className="check">
                  <input type="checkbox" checked={projectIds.includes(p.id)} onChange={(e) => setProjectIds(e.target.checked ? [...projectIds, p.id] : projectIds.filter((x) => x !== p.id))} />
                  <span>{p.name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={includeLocal} onChange={(e) => setIncludeLocal(e.target.checked)} />
          <span>Include runs from developers' laptops<br /><span className="muted small">Off: only CI, scheduled and Run now runs send messages</span></span>
        </label>
        <ErrorAlert error={save.error} />
      </form>
    </Modal>
  );
}

function Deliveries({ channel }: { channel: Channel }) {
  const { orgId } = useCurrentOrg();
  const q = useDeliveries(orgId, channel.id, true);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  if (!q.data!.length) return <p className="muted small">No messages yet.</p>;
  return (
    <table className="table compact" aria-label={`Recent messages of ${channel.name}`}>
      <thead><tr><th>When</th><th>About</th><th>Result</th></tr></thead>
      <tbody>
        {q.data!.map((d) => (
          <tr key={d.id} data-testid="delivery-row">
            <td className="nowrap"><When at={d.createdAt} /></td>
            <td>{EVENT_INFO[d.event].label}{d.projectName && <span className="muted"> · {d.projectName}</span>}</td>
            <td>
              <span className={`status ${d.status === "sent" ? "passed" : d.status === "failed" ? "failed" : "queued"}`}>{statusText(d)}</span>
              {d.attempts > 1 && <span className="muted small"> · {d.attempts} tries</span>}
              {d.lastError && d.status !== "sent" && <div className="muted small">{d.lastError}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function NotificationsPage() {
  const { orgId, can } = useCurrentOrg();
  const toast = useToast();
  const q = useChannels(orgId);
  const projects = useProjects(orgId).data ?? [];
  const [editing, setEditing] = useState<Channel | "new" | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const manage = can("notifications.manage");
  const del = useAction((c: Channel) => api("DELETE", `/orgs/${orgId}/notifications/${c.id}`), [keys.channels(orgId)]);
  const toggle = useAction((c: Channel) => api("PATCH", `/orgs/${orgId}/notifications/${c.id}`, { enabled: !c.enabled }), [keys.channels(orgId)]);
  const qc = useQueryClient();
  const testSend = useAction((c: Channel) => api("POST", `/orgs/${orgId}/notifications/${c.id}/test`), [keys.channels(orgId)]);
  // A failed test also changes the channel (its last error), so refresh it either way
  const sendTest = async (c: Channel) => {
    const ok = await testSend.mutateAsync(c).then(() => true).catch(() => false);
    if (!ok) void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
    else toast(`Test message sent to ${c.name}`);
  };
  const projectNames = (ids: string[] | null) => ids === null ? "All projects" : ids.map((id) => projects.find((p) => p.id === id)?.name ?? "Deleted project").join(", ");
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Notifications</h1><p className="sub">Tell people in Slack, by email or through a webhook when a run needs attention.</p></div>
        {manage && <Button variant="primary" onClick={() => setEditing("new")}>New channel</Button>}
      </div>
      {editing && <ChannelModal channel={editing === "new" ? undefined : editing} emailAvailable={!!q.data?.emailAvailable} onClose={() => setEditing(null)} />}
      {deleting && <Confirm title={`Delete ${deleting.name}?`} body="No more messages go there. Its message history is deleted too." action="Delete channel" onConfirm={async () => { await del.mutateAsync(deleting); toast("Channel deleted"); }} onClose={() => setDeleting(null)} />}
      <ErrorAlert error={testSend.error ?? toggle.error} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !q.data!.channels.length ? (
        <div className="panel"><Empty title="No channels">A Slack channel for failed runs is a good start; add your client's PM by email for regressions.</Empty></div>
      ) : (
        q.data!.channels.map((c) => (
          <section key={c.id} className="panel" aria-label={`Channel ${c.name}`}>
            <div className="panel-head">
              <div>
                <h2>{c.name} <span className="tag" style={{ marginLeft: 6 }}>{KIND_LABEL[c.kind]}</span>{!c.enabled && <span className="tag" style={{ marginLeft: 6 }}>Off</span>}</h2>
                <p className="muted small mono" style={{ marginTop: 2 }}>{c.targetHint}</p>
              </div>
              {manage && (
                <div className="btn-row">
                  <Button size="sm" busy={testSend.isPending && testSend.variables?.id === c.id} onClick={() => sendTest(c)}>Send test</Button>
                  <Button size="sm" onClick={() => setEditing(c)}>Edit</Button>
                  <Button size="sm" onClick={async () => { if (await toggle.mutateAsync(c).then(() => true).catch(() => false)) toast(c.enabled ? `${c.name} turned off` : `${c.name} turned on`); }}>{c.enabled ? "Turn off" : "Turn on"}</Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleting(c)}>Delete</Button>
                </div>
              )}
            </div>
            <div className="panel-body" style={{ display: "grid", gap: 10 }}>
              <dl className="kv">
                <dt>When</dt><dd>{c.events.map((e) => EVENT_INFO[e].label).join(" · ")}</dd>
                <dt>For</dt><dd>{projectNames(c.projectIds)}{c.includeLocal && <span className="muted"> · including laptop runs</span>}</dd>
                <dt>Last message</dt><dd>{c.lastDeliveryAt ? <When at={c.lastDeliveryAt} /> : <span className="muted">None yet</span>}</dd>
              </dl>
              {c.lastError && <div className="alert error" role="alert">Last delivery failed: {c.lastError}</div>}
              <div>
                <Button size="sm" variant="ghost" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? "Hide recent messages" : "Show recent messages"}</Button>
                {open === c.id && <Deliveries channel={c} />}
              </div>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
