import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, apiText } from "../../api/client";
import { keys, useAction, useRuns, useUatRelease, useUatReleases, useUatScenarios } from "../../api/queries";
import type { UatCriterion, UatRelease, UatReleaseStatus, UatStatus } from "../../api/types";
import { useCurrentOrg } from "../../lib/org";
import { fmtDate } from "../../lib/format";
import { Button, Empty, ErrorAlert, Field, Input, Loading, Modal, When, useToast } from "../../components/ui";

const STATUS_LABEL: Record<UatStatus, string> = { untested: "Untested", passed: "Passed", failed: "Failed", blocked: "Blocked" };
const RELEASE_LABEL: Record<UatReleaseStatus, string> = { open: "In testing", signed_off: "Signed off", rejected: "Rejected" };
const StatusLabel = ({ s }: { s: UatStatus }) => <span className={`status uat-${s}`}>{STATUS_LABEL[s]}</span>;
const ReleaseLabel = ({ s }: { s: UatReleaseStatus }) => <span className={`status uat-${s}`}>{RELEASE_LABEL[s]}</span>;

function Progress({ r }: { r: UatRelease }) {
  const c = r.counts;
  return (
    <span className="small">
      <strong>{c.passed}</strong> of {c.total} passed
      {c.failed > 0 && <span className="muted"> · {c.failed} failed</span>}
      {c.blocked > 0 && <span className="muted"> · {c.blocked} blocked</span>}
    </span>
  );
}

function NewReleaseModal({ onClose }: { onClose: () => void }) {
  const { orgId } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const lines = criteria.split("\n").map((l) => l.trim()).filter(Boolean);
  const create = useAction(
    () => api<{ release: UatRelease }>("POST", `/orgs/${orgId}/projects/${projectId}/uat/releases`, { name, description, criteria: lines.map((title) => ({ title })) }),
    [keys.uat(orgId, projectId)],
  );
  return (
    <Modal
      title="New UAT release"
      description="List what the business must confirm before this release goes live. You can add steps and evidence to each criterion afterwards."
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="uat-release-form" busy={create.isPending}>Create release</Button></>}
    >
      <form id="uat-release-form" className="form" onSubmit={async (e) => { e.preventDefault(); const r = await create.mutateAsync(undefined).catch(() => null); if (r) { toast("Release created"); onClose(); } }}>
        <Field label="Release name" hint="For example: v2.3 promotions">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />}</Field>
        <Field label="Description">{(id) => <textarea id={id} className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />}</Field>
        <Field label="Acceptance criteria" hint={`One per line${lines.length ? ` · ${lines.length} criteria` : ""}`}>
          {(id) => <textarea id={id} className="input" value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={6} placeholder={"Merchant can create a 15% promotion\nCustomers see the promotion in the app"} />}
        </Field>
        <ErrorAlert error={create.error} />
      </form>
    </Modal>
  );
}

export function UatTab() {
  const { orgId, can } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const q = useUatReleases(orgId, projectId);
  const [creating, setCreating] = useState(false);
  const base = `/o/${orgId}/projects/${projectId}/uat`;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <p className="muted">User acceptance testing: the team records each criterion's result, then an owner or admin signs the release off.</p>
        {can("uat.record") && <Button variant="primary" onClick={() => setCreating(true)}>New release</Button>}
      </div>
      {creating && <NewReleaseModal onClose={() => setCreating(false)} />}
      {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !q.data!.length ? (
        <div className="panel"><Empty title="No UAT releases">Create a release for the next version and list what the business must confirm before it goes live.</Empty></div>
      ) : (
        <div className="panel table-wrap">
          <table className="table" aria-label="UAT releases">
            <thead><tr><th>Release</th><th>Status</th><th>Progress</th><th>Decision</th><th>Created</th></tr></thead>
            <tbody>
              {q.data!.map((r) => (
                <tr key={r.id} data-testid="uat-release-row">
                  <td><Link to={`${base}/${r.id}`} style={{ fontWeight: 600 }}>{r.name}</Link></td>
                  <td><ReleaseLabel s={r.status} /></td>
                  <td><Progress r={r} /></td>
                  <td>{r.decidedAt ? <span className="small">{r.decidedByName ?? "Former member"}, <When at={r.decidedAt} /></span> : <span className="muted small">Not decided</span>}</td>
                  <td><When at={r.createdAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const AUTOMATED_LABEL = { passed: "Passed", failed: "Failed", skipped: "Skipped" } as const;

function CriterionRow({ c, release, editable }: { c: UatCriterion; release: UatRelease; editable: boolean }) {
  const { orgId } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const runs = useRuns(orgId, projectId);
  const [status, setStatus] = useState<UatStatus>(c.status);
  const [note, setNote] = useState(c.note ?? "");
  const [runId, setRunId] = useState(c.evidenceRunId ?? "");
  const dirty = status !== c.status || note !== (c.note ?? "") || runId !== (c.evidenceRunId ?? "");
  const path = `/orgs/${orgId}/projects/${projectId}/uat/releases/${release.id}/criteria/${c.id}`;
  const save = useAction(() => api("PATCH", path, { status, note, evidenceRunId: runId || null }), [keys.uatRelease(orgId, projectId, release.id), keys.uat(orgId, projectId)]);
  const remove = useAction(() => api("DELETE", path), [keys.uatRelease(orgId, projectId, release.id), keys.uat(orgId, projectId)]);
  const runBase = `/o/${orgId}/projects/${projectId}/runs`;
  return (
    <li className="panel panel-body" data-testid="uat-criterion" aria-label={`Criterion ${c.position}: ${c.title}`}>
      <div className="btn-row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0 }}><span className="muted">{c.position}.</span> {c.title}</h3>
        <StatusLabel s={c.status} />
      </div>
      {c.steps && <p className="small" style={{ whiteSpace: "pre-wrap" }}>{c.steps}</p>}
      {c.scenario && (
        <div className="small" data-testid="uat-automated">
          <p className="muted" style={{ margin: 0 }}>Automated scenario: <span className="mono">{c.scenario}</span></p>
          {c.automatedStatus && c.automatedRunId ? (
            <p style={{ margin: "4px 0 0" }}>
              Latest result: <span className={`status uat-${c.automatedStatus === "skipped" ? "untested" : c.automatedStatus}`}>{AUTOMATED_LABEL[c.automatedStatus]}</span>{" "}
              in <Link to={`${runBase}/${c.automatedRunId}`}>run {c.automatedAt ? fmtDate(c.automatedAt) : c.automatedRunId.slice(0, 8)}</Link>
              {editable && runId !== c.automatedRunId && (
                <> · <button type="button" className="link-button" onClick={() => setRunId(c.automatedRunId!)}>Use this run as evidence</button></>
              )}
            </p>
          ) : <p className="muted" style={{ margin: "4px 0 0" }}>No uploaded run has this scenario yet.</p>}
        </div>
      )}
      {c.testedAt && <p className="muted small">Tested by {c.testedByName ?? "a former member"} on {fmtDate(c.testedAt)}{c.note && !editable ? `: ${c.note}` : ""}</p>}
      {c.evidenceRunId && <p className="small">Evidence: <Link to={`${runBase}/${c.evidenceRunId}`}>run {c.evidenceRunAt ? fmtDate(c.evidenceRunAt) : c.evidenceRunId.slice(0, 8)}</Link>{c.evidenceRunStatus ? ` (${c.evidenceRunStatus.replace("_", " ")})` : ""}</p>}
      {editable && (
        <form className="form" onSubmit={async (e) => { e.preventDefault(); const ok = await save.mutateAsync(undefined).then(() => true).catch(() => false); if (ok) toast("Result saved"); }}>
          <div className="form-grid">
            <Field label="Result">
              {(id) => <select id={id} className="input" value={status} onChange={(e) => setStatus(e.target.value as UatStatus)}>{(Object.keys(STATUS_LABEL) as UatStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>}
            </Field>
            <Field label="Evidence run" hint="Optional: a run that shows this works">
              {(id) => (
                <select id={id} className="input" value={runId} onChange={(e) => setRunId(e.target.value)}>
                  <option value="">None</option>
                  {(runs.data ?? []).map((r) => <option key={r.id} value={r.id}>{fmtDate(r.startedAt)} · {r.suite} · {r.status.replace("_", " ")}</option>)}
                  {c.evidenceRunId && !(runs.data ?? []).some((r) => r.id === c.evidenceRunId) && <option value={c.evidenceRunId}>Earlier run</option>}
                </select>
              )}
            </Field>
          </div>
          <Field label="Note" hint={status === "failed" || status === "blocked" ? "Required: what failed, or what blocks the test" : "Optional"}>
            {(id) => <textarea id={id} className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} required={status === "failed" || status === "blocked"} minLength={status === "failed" || status === "blocked" ? 3 : undefined} />}
          </Field>
          <ErrorAlert error={save.error ?? remove.error} />
          <div className="btn-row">
            <Button type="submit" variant="primary" size="sm" busy={save.isPending} disabled={!dirty}>Save result</Button>
            <Button type="button" size="sm" onClick={async () => { const ok = await remove.mutateAsync(undefined).then(() => true).catch(() => false); if (ok) toast("Criterion removed"); }} aria-label={`Remove criterion ${c.position}`}>Remove</Button>
          </div>
        </form>
      )}
    </li>
  );
}

function DecisionModal({ release, decision, onClose }: { release: UatRelease; decision: "signed_off" | "rejected" | "reopen"; onClose: () => void }) {
  const { orgId } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const [note, setNote] = useState("");
  const path = `/orgs/${orgId}/projects/${projectId}/uat/releases/${release.id}`;
  const act = useAction(
    () => (decision === "reopen" ? api("POST", `${path}/reopen`, { reason: note }) : api("POST", `${path}/decision`, { decision, note })),
    [keys.uatRelease(orgId, projectId, release.id), keys.uat(orgId, projectId)],
  );
  const title = decision === "signed_off" ? "Sign off this release?" : decision === "rejected" ? "Reject this release?" : "Reopen this release?";
  const action = decision === "signed_off" ? "Sign off" : decision === "rejected" ? "Reject release" : "Reopen";
  const required = decision !== "signed_off";
  return (
    <Modal
      title={title}
      description={decision === "signed_off" ? `All ${release.counts.total} criteria passed. Your name and the time are recorded, and the release is locked.` : decision === "rejected" ? "The release is locked with your reason. Reopen it to test again." : "Results are kept; the decision is cleared so the release can be tested again."}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="uat-decision-form" busy={act.isPending}>{action}</Button></>}
    >
      <form id="uat-decision-form" className="form" onSubmit={async (e) => { e.preventDefault(); const ok = await act.mutateAsync(undefined).then(() => true).catch(() => false); if (ok) { toast(decision === "signed_off" ? "Release signed off" : decision === "rejected" ? "Release rejected" : "Release reopened"); onClose(); } }}>
        <Field label={required ? "Reason" : "Note"} hint={required ? "Required" : "Optional"}>
          {(id) => <textarea id={id} className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} required={required} minLength={required ? 3 : undefined} />}
        </Field>
        <ErrorAlert error={act.error} />
      </form>
    </Modal>
  );
}

export function UatReleasePage() {
  const { orgId, can } = useCurrentOrg();
  const { projectId = "", releaseId = "" } = useParams();
  const toast = useToast();
  const q = useUatRelease(orgId, projectId, releaseId);
  const [decision, setDecision] = useState<"signed_off" | "rejected" | "reopen" | null>(null);
  const [title, setTitle] = useState("");
  const [steps, setSteps] = useState("");
  const [scenario, setScenario] = useState("");
  const scenarios = useUatScenarios(orgId, projectId);
  const path = `/orgs/${orgId}/projects/${projectId}/uat/releases/${releaseId}`;
  const add = useAction(() => api("POST", `${path}/criteria`, { title, steps, scenario }), [keys.uatRelease(orgId, projectId, releaseId), keys.uat(orgId, projectId)]);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const { release: r, criteria } = q.data!;
  const editable = r.status === "open" && can("uat.record");
  const ready = r.counts.total > 0 && r.counts.passed === r.counts.total;
  const download = async () => {
    setDownloadError(null);
    try {
      const text = await apiText(`${path}/report?format=md`);
      const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: `uat-${r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "release"}.md` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setDownloadError(e); }
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
      <div className="crumbs"><Link to={`/o/${orgId}/projects/${projectId}/uat`}>Acceptance</Link></div>
      <section className="panel panel-body" aria-label="Release summary">
        <div className="btn-row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ margin: 0 }}>{r.name}</h2>
          <ReleaseLabel s={r.status} />
        </div>
        {r.description && <p style={{ whiteSpace: "pre-wrap" }}>{r.description}</p>}
        <p><Progress r={r} /></p>
        {r.decidedAt && <p className="small" data-testid="uat-decision">{RELEASE_LABEL[r.status]} by {r.decidedByName ?? "a former member"} on {fmtDate(r.decidedAt)}{r.decisionNote ? `: ${r.decisionNote}` : ""}</p>}
        <div className="btn-row">
          <Button onClick={download}>Download report</Button>
          {can("uat.decide") && r.status === "open" && (
            <>
              <Button variant="primary" onClick={() => setDecision("signed_off")} disabled={!ready} title={ready ? undefined : "Every criterion must pass first"}>Sign off</Button>
              <Button onClick={() => setDecision("rejected")}>Reject</Button>
            </>
          )}
          {can("uat.decide") && r.status !== "open" && <Button onClick={() => setDecision("reopen")}>Reopen</Button>}
        </div>
        {can("uat.decide") && r.status === "open" && !ready && <p className="muted small">Sign-off becomes available when every criterion has passed.</p>}
        <ErrorAlert error={downloadError} />
      </section>
      {decision && <DecisionModal release={r} decision={decision} onClose={() => setDecision(null)} />}
      {!criteria.length ? (
        <div className="panel"><Empty title="No criteria yet">Add what the business must confirm, one criterion at a time.</Empty></div>
      ) : (
        <ol style={{ display: "grid", gap: 12, listStyle: "none", padding: 0, margin: 0 }} aria-label="Acceptance criteria">
          {criteria.map((c) => <CriterionRow key={`${c.id}-${c.updatedAt}`} c={c} release={r} editable={editable} />)}
        </ol>
      )}
      {editable && (
        <form className="panel panel-body form" aria-label="Add a criterion" onSubmit={async (e) => { e.preventDefault(); const ok = await add.mutateAsync(undefined).then(() => true).catch(() => false); if (ok) { setTitle(""); setSteps(""); setScenario(""); toast("Criterion added"); } }}>
          <h3 style={{ margin: 0 }}>Add a criterion</h3>
          <Field label="Criterion">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} required />}</Field>
          <Field label="Steps" hint="Optional, for example Given / When / Then">{(id) => <textarea id={id} className="input" value={steps} onChange={(e) => setSteps(e.target.value)} maxLength={4000} />}</Field>
          <Field label="Automated scenario" hint={scenarios.data?.length ? "Optional. Pick an API scenario from your uploaded runs; its latest result appears on the criterion." : "Optional. The exact name of an API scenario; its latest result appears once a run with it is uploaded."}>
            {(id) => (
              <>
                <Input id={id} value={scenario} onChange={(e) => setScenario(e.target.value)} maxLength={200} list={`${id}-options`} autoComplete="off" />
                <datalist id={`${id}-options`}>
                  {(scenarios.data ?? []).map((s) => <option key={s.name} value={s.name}>{`Latest: ${s.status === "passed" ? "passed" : s.status === "failed" ? "failed" : "skipped"}${s.tags.length ? ` (${s.tags.join(", ")})` : ""}`}</option>)}
                </datalist>
              </>
            )}
          </Field>
          <ErrorAlert error={add.error} />
          <div className="btn-row"><Button type="submit" busy={add.isPending}>Add criterion</Button></div>
        </form>
      )}
    </div>
  );
}
