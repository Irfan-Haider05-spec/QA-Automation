import { useMemo, useState } from "react";
import { api } from "../api/client";
import { keys, useAction, useClients, useProjects, useReport, useShares } from "../api/queries";
import type { ReportShare } from "../api/types";
import { useCurrentOrg } from "../lib/org";
import { ReportView, reportCsv } from "../components/ReportView";
import { Button, Confirm, CopyField, Empty, ErrorAlert, Field, Input, Loading, Modal, useToast, When } from "../components/ui";

const day = (d: Date) => d.toISOString().slice(0, 10);
const PERIODS: Record<string, { label: string; range: () => [string, string] }> = {
  "7": { label: "Last 7 days", range: () => [day(new Date(Date.now() - 6 * 864e5)), day(new Date())] },
  "30": { label: "Last 30 days", range: () => [day(new Date(Date.now() - 29 * 864e5)), day(new Date())] },
  "90": { label: "Last 90 days", range: () => [day(new Date(Date.now() - 89 * 864e5)), day(new Date())] },
  month: { label: "This month", range: () => { const n = new Date(); return [day(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1))), day(n)]; } },
  last: { label: "Last month", range: () => { const n = new Date(); return [day(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1))), day(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0)))]; } },
  custom: { label: "Custom dates", range: () => [day(new Date(Date.now() - 29 * 864e5)), day(new Date())] },
};

function ShareModal({ query, scopeName, onClose }: { query: { scope: string; id: string; from: string; to: string }; scopeName: string; onClose: () => void }) {
  const { orgId } = useCurrentOrg();
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [link, setLink] = useState<string | null>(null);
  const create = useAction(() => api<{ share: ReportShare; token: string }>("POST", `/orgs/${orgId}/report-shares`, { ...query, expiresInDays: days }), [keys.shares(orgId)]);
  if (link) {
    return (
      <Modal title="Share link created" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="secret-once" style={{ display: "grid", gap: 10 }}>
          <p><b>Copy the link now; it's shown once.</b> Anyone with it can open this report without an account until it expires. It shows the report as it is now; later runs don't change it.</p>
          <CopyField label="Report link" value={link} />
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title={`Share the ${scopeName} report`}
      description="Creates a read-only page for people outside your organization, such as your client. It contains no request details, URLs or test-account data."
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="share-form" busy={create.isPending}>Create link</Button></>}
    >
      <form id="share-form" className="form" onSubmit={async (e) => { e.preventDefault(); const r = await create.mutateAsync(undefined).catch(() => null); if (r) { toast("Share link created"); setLink(`${location.origin}/r/${r.token}`); } }}>
        <Field label="Link works for">
          {(id) => <select id={id} className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 14, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select>}
        </Field>
        <ErrorAlert error={create.error} />
      </form>
    </Modal>
  );
}

function Shares() {
  const { orgId } = useCurrentOrg();
  const toast = useToast();
  const q = useShares(orgId, true);
  const [revoking, setRevoking] = useState<ReportShare | null>(null);
  const revoke = useAction((s: ReportShare) => api("DELETE", `/orgs/${orgId}/report-shares/${s.id}`), [keys.shares(orgId)]);
  const now = Date.now();
  const active = (q.data ?? []).filter((s) => !s.revokedAt && new Date(s.expiresAt).getTime() > now);
  return (
    <section className="no-print" aria-labelledby="sh-h" style={{ display: "grid", gap: 10 }}>
      <h2 id="sh-h">Active share links</h2>
      {revoking && <Confirm title="Turn off this link?" body={`People with the ${revoking.scopeName} link will see "link expired".`} action="Turn off link" onConfirm={async () => { await revoke.mutateAsync(revoking); toast("Link turned off"); }} onClose={() => setRevoking(null)} />}
      {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !active.length ? <div className="panel"><Empty title="No active links" /></div> : (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>Report</th><th>Period</th><th className="num">Views</th><th>Expires</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {active.map((s) => (
                <tr key={s.id} data-testid="share-row">
                  <td>{s.scopeName}<div className="muted small">by {s.createdBy ?? "someone"} · <When at={s.createdAt} /></div></td>
                  <td className="nowrap">{s.from} – {s.to}</td>
                  <td className="num">{s.viewCount}</td>
                  <td className="nowrap"><When at={s.expiresAt} /></td>
                  <td style={{ textAlign: "right" }}><Button size="sm" variant="danger" onClick={() => setRevoking(s)} aria-label={`Turn off the ${s.scopeName} link`}>Turn off</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ReportsPage() {
  const { orgId, can } = useCurrentOrg();
  const clients = useClients(orgId).data ?? [];
  const projects = useProjects(orgId).data ?? [];
  const [target, setTarget] = useState("");
  const [period, setPeriod] = useState("30");
  const [custom, setCustom] = useState(PERIODS.custom.range());
  const [sharing, setSharing] = useState(false);
  const chosen = target || (clients[0] ? `client:${clients[0].id}` : projects[0] ? `project:${projects[0].id}` : "");
  const [from, to] = period === "custom" ? custom : PERIODS[period].range();
  const query = useMemo(() => {
    if (!chosen) return null;
    const [scope, id] = chosen.split(":");
    return { scope, id, from, to };
  }, [chosen, from, to]);
  const report = useReport(orgId, query && from <= to ? new URLSearchParams(query).toString() : null);
  const download = () => {
    if (!report.data) return;
    const url = URL.createObjectURL(new Blob([reportCsv(report.data)], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${report.data.scope.name.replace(/[^\w-]+/g, "-")}-issues-${from}-to-${to}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Reports</h1><p className="sub">Quality over a period, for a client or a project. Download as PDF or share a link.</p></div>
      </div>
      {!clients.length && !projects.length ? <div className="panel"><Empty title="Nothing to report yet">Reports appear once a project has runs.</Empty></div> : (
        <>
          <div className="report-tools panel" style={{ padding: 14 }}>
            <Field label="Report for">
              {(id) => (
                <select id={id} className="input" value={chosen} onChange={(e) => setTarget(e.target.value)}>
                  {clients.length > 0 && <optgroup label="Clients (all their projects)">{clients.map((c) => <option key={c.id} value={`client:${c.id}`}>{c.name}</option>)}</optgroup>}
                  <optgroup label="Projects">{projects.map((p) => <option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}</optgroup>
                </select>
              )}
            </Field>
            <Field label="Period">
              {(id) => <select id={id} className="input" value={period} onChange={(e) => setPeriod(e.target.value)}>{Object.entries(PERIODS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>}
            </Field>
            {period === "custom" && (
              <>
                <Field label="From">{(id) => <Input id={id} type="date" value={custom[0]} max={custom[1]} onChange={(e) => setCustom([e.target.value, custom[1]])} />}</Field>
                <Field label="To">{(id) => <Input id={id} type="date" value={custom[1]} min={custom[0]} onChange={(e) => setCustom([custom[0], e.target.value])} />}</Field>
              </>
            )}
            <div className="btn-row" style={{ marginLeft: "auto" }}>
              <Button onClick={() => window.print()} disabled={!report.data}>Download PDF</Button>
              <Button onClick={download} disabled={!report.data}>Issues as CSV</Button>
              {can("reports.share") && <Button variant="primary" onClick={() => setSharing(true)} disabled={!report.data}>Share link</Button>}
            </div>
          </div>
          {sharing && query && report.data && <ShareModal query={query} scopeName={report.data.scope.name} onClose={() => setSharing(false)} />}
          {from > to ? <div className="alert error" role="alert">The start date is after the end date.</div>
            : report.isLoading ? <Loading /> : report.error ? <ErrorAlert error={report.error} /> : report.data && <ReportView report={report.data} />}
          {can("reports.share") && <Shares />}
        </>
      )}
    </div>
  );
}
