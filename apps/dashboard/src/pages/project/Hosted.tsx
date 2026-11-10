/**
 * Hosted runs on the Runs tab: the "Run now" dialog and the live queue
 * (queued and running jobs, plus recent ones that failed or were cancelled).
 */
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { keys, useAction, useHostedStatus, useJobs } from "../../api/queries";
import type { EnvReadiness, HostedSuite, Job } from "../../api/types";
import { useCurrentOrg } from "../../lib/org";
import { Button, Confirm, ErrorAlert, Field, Loading, Modal, useToast, When } from "../../components/ui";

export const SUITE_INFO: Record<HostedSuite, { label: string; detail: string }> = {
  staging: { label: "Staging checks", detail: "API auth, roles, tenant isolation, smoke and CORS; a crawl of each dashboard" },
  nightly: { label: "Nightly checks", detail: "Everything in staging plus accessibility of each dashboard" },
};

/** What a run on this environment will check, or why it can't run */
export function ReadinessNote({ env }: { env: EnvReadiness | undefined }) {
  if (!env) return null;
  const checks = [env.api && "API checks", env.web && "dashboard checks"].filter(Boolean).join(" and ");
  return (
    <div className={env.canRun ? "alert" : "alert error"} role={env.canRun ? undefined : "alert"} data-testid="readiness">
      {env.canRun && <p style={{ marginBottom: env.reasons.length ? 6 : 0 }}>Will run {checks} on {env.name}.</p>}
      {env.reasons.length > 0 && <ul style={{ margin: 0, paddingLeft: 18 }}>{env.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
    </div>
  );
}

export function RunNowModal({ onClose }: { onClose: () => void }) {
  const { orgId } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const status = useHostedStatus(orgId, projectId);
  const [envId, setEnvId] = useState<string | null>(null);
  const [suite, setSuite] = useState<HostedSuite>("staging");
  const envs = status.data?.environments ?? [];
  const chosen = envId ?? envs.find((e) => e.canRun)?.id ?? envs[0]?.id ?? "";
  const env = envs.find((e) => e.id === chosen);
  const start = useAction(
    () => api<{ job: Job }>("POST", `/orgs/${orgId}/projects/${projectId}/jobs`, { environmentId: chosen, suite }),
    [keys.jobs(orgId, projectId)],
  );
  return (
    <Modal
      title="Run tests now"
      description="The platform's runner tests the deployed environment. Results appear under Runs like any other run."
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="run-now" busy={start.isPending} disabled={!env?.canRun || !status.data?.enabled}>Start run</Button></>}
    >
      {status.isLoading ? <Loading /> : status.error ? <ErrorAlert error={status.error} /> : !status.data!.enabled ? (
        <div className="alert error" role="alert">Hosted runs are turned off on this platform. Run the QA agent from CI instead (see the CI setup tab).</div>
      ) : !envs.length ? (
        <p className="muted">Add an environment first.</p>
      ) : (
        <form
          id="run-now"
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await start.mutateAsync(undefined).catch(() => null);
            if (r) { toast(`${SUITE_INFO[suite].label} queued for ${r.job.environmentName}`); onClose(); }
          }}
        >
          <Field label="Environment">
            {(id) => (
              <select id={id} className="input" value={chosen} onChange={(e) => setEnvId(e.target.value)}>
                {envs.map((e) => <option key={e.id} value={e.id}>{e.name}{e.canRun ? "" : " (can't run yet)"}</option>)}
              </select>
            )}
          </Field>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
            <legend style={{ fontWeight: 500, color: "var(--ink-2)", fontSize: 13.5, marginBottom: 6 }}>Checks</legend>
            {(Object.keys(SUITE_INFO) as HostedSuite[]).map((s) => (
              <label key={s} className="check">
                <input type="radio" name="suite" checked={suite === s} onChange={() => setSuite(s)} />
                <span>{SUITE_INFO[s].label}<br /><span className="muted small">{SUITE_INFO[s].detail}</span></span>
              </label>
            ))}
          </fieldset>
          <ReadinessNote env={env} />
          <ErrorAlert error={start.error} />
        </form>
      )}
    </Modal>
  );
}

const JOB_LABEL: Record<Job["status"], string> = { queued: "Waiting for a runner", running: "Running", done: "Finished", cancelled: "Cancelled", error: "Couldn't run" };

/** Queued/running jobs, and failed or cancelled ones from the last day; refreshes the runs list when a job finishes */
export function JobsPanel() {
  const { orgId, can } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useJobs(orgId, projectId);
  const [cancelling, setCancelling] = useState<Job | null>(null);
  const cancel = useAction((j: Job) => api("POST", `/orgs/${orgId}/projects/${projectId}/jobs/${j.id}/cancel`), [keys.jobs(orgId, projectId)]);
  const active = (q.data ?? []).filter((j) => j.status === "queued" || j.status === "running");
  // When the number of active jobs drops, a run has finished: reload runs, issues and the ribbon
  const prev = useRef(active.length);
  useEffect(() => {
    if (active.length < prev.current) void qc.invalidateQueries({ queryKey: ["org", orgId, "project", projectId] });
    prev.current = active.length;
  }, [active.length, qc, orgId, projectId]);
  const dayAgo = Date.now() - 86_400_000;
  const problems = (q.data ?? []).filter((j) => (j.status === "error" || j.status === "cancelled") && new Date(j.finishedAt ?? j.createdAt).getTime() > dayAgo).slice(0, 3);
  const rows = [...active, ...problems];
  if (!rows.length) return null;
  const base = `/o/${orgId}/projects/${projectId}`;
  return (
    <section className="panel" aria-label="Hosted runs in progress">
      {cancelling && <Confirm title="Cancel this run?" body={cancelling.status === "running" ? "The runner stops at its next check-in. Nothing is recorded." : "It won't start."} action="Cancel run" onConfirm={async () => { await cancel.mutateAsync(cancelling); toast("Run cancelled"); }} onClose={() => setCancelling(null)} />}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Status</th><th>Environment</th><th>Checks</th><th>Started by</th><th>When</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {rows.map((j) => (
              <tr key={j.id} data-testid="job-row">
                <td className="nowrap">
                  <span className={`status ${j.status === "running" ? "running" : j.status === "queued" ? "queued" : j.status === "error" ? "env_error" : "skipped"}`}>
                    {j.cancelRequested && j.status === "running" ? "Stopping" : JOB_LABEL[j.status]}
                  </span>
                  {j.attempts > 1 && j.status !== "error" && <span className="muted small"> · attempt {j.attempts}</span>}
                </td>
                <td>{j.environmentName}</td>
                <td>{SUITE_INFO[j.suite].label}</td>
                <td>{j.trigger === "schedule" ? <Link to={`${base}/schedules`}>Schedule</Link> : j.requestedBy ?? "Deploy"}</td>
                <td className="nowrap"><When at={j.startedAt ?? j.createdAt} /></td>
                <td style={{ textAlign: "right" }}>
                  {(j.status === "queued" || (j.status === "running" && !j.cancelRequested)) && can("runs.start") && <Button size="sm" onClick={() => setCancelling(j)} aria-label={`Cancel the run on ${j.environmentName}`}>Cancel</Button>}
                  {j.status === "error" && <span className="muted small">{j.error}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
