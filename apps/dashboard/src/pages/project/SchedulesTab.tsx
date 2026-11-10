import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { keys, useAction, useHostedStatus, useSchedules } from "../../api/queries";
import type { HostedSuite, Schedule } from "../../api/types";
import { useCurrentOrg } from "../../lib/org";
import { browserTimezone, DAYS, describe, fmtInZone, fromCron, timezones, toCron, type Frequency } from "../../lib/schedule";
import { Button, Confirm, Empty, ErrorAlert, Field, Input, Loading, Modal, RunStatusLabel, useToast } from "../../components/ui";
import { ReadinessNote, SUITE_INFO } from "./Hosted";

function ScheduleModal({ schedule, onClose }: { schedule?: Schedule; onClose: () => void }) {
  const { orgId } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const status = useHostedStatus(orgId, projectId);
  const envs = status.data?.environments ?? [];
  const [envId, setEnvId] = useState<string | null>(schedule?.environmentId ?? null);
  const [suite, setSuite] = useState<HostedSuite>(schedule?.suite ?? "nightly");
  const [freq, setFreq] = useState<Frequency>(schedule ? fromCron(schedule.cron) : { kind: "daily", time: "02:41" });
  const [tz, setTz] = useState(schedule?.timezone ?? browserTimezone());
  const zones = useMemo(timezones, []);
  const chosen = envId ?? envs.find((e) => e.canRun)?.id ?? envs[0]?.id ?? "";
  const env = envs.find((e) => e.id === chosen);
  const path = `/orgs/${orgId}/projects/${projectId}/schedules`;
  const save = useAction(
    () => schedule
      ? api<{ schedule: Schedule }>("PATCH", `${path}/${schedule.id}`, { suite, cron: toCron(freq), timezone: tz })
      : api<{ schedule: Schedule }>("POST", path, { environmentId: chosen, suite, cron: toCron(freq), timezone: tz }),
    [keys.schedules(orgId, projectId)],
  );
  // Remember the last time picked, so trying "Custom" or "Every few hours" and coming back keeps it
  const lastTime = useRef("time" in freq ? freq.time : "02:41");
  if ("time" in freq) lastTime.current = freq.time;
  const setKind = (kind: Frequency["kind"]) => {
    const parsed = freq.kind === "custom" ? fromCron(freq.cron) : freq;
    const time = "time" in parsed ? parsed.time : lastTime.current;
    setFreq(kind === "daily" || kind === "weekdays" ? { kind, time } : kind === "weekly" ? { kind, day: 1, time } : kind === "hours" ? { kind, every: 6 } : { kind, cron: toCron(freq) });
  };
  return (
    <Modal
      title={schedule ? "Edit schedule" : "New schedule"}
      description="The platform's runner tests the environment at these times. A run is skipped if the previous one hasn't finished."
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="schedule-form" busy={save.isPending} disabled={!schedule && !env?.canRun}>{schedule ? "Save schedule" : "Create schedule"}</Button></>}
    >
      {status.isLoading ? <Loading /> : (
        <form id="schedule-form" className="form" onSubmit={async (e) => { e.preventDefault(); const r = await save.mutateAsync(undefined).catch(() => null); if (r) { toast(schedule ? "Schedule saved" : "Schedule created"); onClose(); } }}>
          {!status.data?.enabled && <div className="alert error" role="alert">Hosted runs are turned off on this platform, so schedules won't run.</div>}
          <Field label="Environment">
            {(id) => (
              <select id={id} className="input" value={chosen} onChange={(e) => setEnvId(e.target.value)} disabled={!!schedule}>
                {envs.map((e) => <option key={e.id} value={e.id}>{e.name}{e.canRun ? "" : " (can't run yet)"}</option>)}
              </select>
            )}
          </Field>
          <Field label="Checks">
            {(id) => (
              <select id={id} className="input" value={suite} onChange={(e) => setSuite(e.target.value as HostedSuite)}>
                {(Object.keys(SUITE_INFO) as HostedSuite[]).map((s) => <option key={s} value={s}>{SUITE_INFO[s].label}</option>)}
              </select>
            )}
          </Field>
          <div className="form-grid">
            <Field label="How often">
              {(id) => (
                <select id={id} className="input" value={freq.kind} onChange={(e) => setKind(e.target.value as Frequency["kind"])}>
                  <option value="daily">Every day</option>
                  <option value="weekdays">Weekdays (Mon–Fri)</option>
                  <option value="weekly">Once a week</option>
                  <option value="hours">Every few hours</option>
                  <option value="custom">Custom (cron)</option>
                </select>
              )}
            </Field>
            {freq.kind === "weekly" && (
              <Field label="Day">{(id) => <select id={id} className="input" value={freq.day} onChange={(e) => setFreq({ ...freq, day: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>}</Field>
            )}
            {"time" in freq && <Field label="Time">{(id) => <Input id={id} type="time" value={freq.time} onChange={(e) => setFreq({ ...freq, time: e.target.value })} required />}</Field>}
            {freq.kind === "hours" && (
              <Field label="Every">{(id) => <select id={id} className="input" value={freq.every} onChange={(e) => setFreq({ kind: "hours", every: Number(e.target.value) as 6 | 12 })}><option value={6}>6 hours</option><option value={12}>12 hours</option></select>}</Field>
            )}
            {freq.kind === "custom" && (
              <Field label="Cron expression" hint="minute hour day month weekday, at least an hour apart">{(id) => <Input id={id} className="input mono" value={freq.cron} onChange={(e) => setFreq({ kind: "custom", cron: e.target.value })} required />}</Field>
            )}
          </div>
          <Field label="Time zone">
            {(id) => <select id={id} className="input" value={tz} onChange={(e) => setTz(e.target.value)}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</select>}
          </Field>
          <p className="muted small" data-testid="schedule-summary">{describe(toCron(freq))} ({tz}) · {SUITE_INFO[suite].label.toLowerCase()} on {env?.name ?? "…"}</p>
          {!schedule && <ReadinessNote env={env} />}
          <ErrorAlert error={save.error} />
        </form>
      )}
    </Modal>
  );
}

export function SchedulesTab() {
  const { orgId, can } = useCurrentOrg();
  const { projectId = "" } = useParams();
  const toast = useToast();
  const q = useSchedules(orgId, projectId);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const path = `/orgs/${orgId}/projects/${projectId}/schedules`;
  const toggle = useAction((s: Schedule) => api("PATCH", `${path}/${s.id}`, { enabled: !s.enabled }), [keys.schedules(orgId, projectId)]);
  const del = useAction((s: Schedule) => api("DELETE", `${path}/${s.id}`), [keys.schedules(orgId, projectId)]);
  const manage = can("schedules.manage");
  const base = `/o/${orgId}/projects/${projectId}`;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <p className="muted">Recurring runs by the platform's runner, without CI.</p>
        {manage && <Button variant="primary" onClick={() => setEditing("new")}>New schedule</Button>}
      </div>
      {editing && <ScheduleModal schedule={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
      {deleting && <Confirm title="Delete this schedule?" body={`${describe(deleting.cron)} on ${deleting.environmentName}. Past runs stay.`} action="Delete schedule" onConfirm={async () => { await del.mutateAsync(deleting); toast("Schedule deleted"); }} onClose={() => setDeleting(null)} />}
      {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !q.data!.length ? (
        <div className="panel"><Empty title="No schedules">A nightly run catches what slipped past pull requests, such as config changes on staging.</Empty></div>
      ) : (
        <div className="panel table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Environment</th><th>Checks</th><th>Next run</th><th>Last run</th>{manage && <th><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody>
              {q.data!.map((s) => (
                <tr key={s.id} data-testid="schedule-row" className={s.enabled ? undefined : "muted"}>
                  <td><div style={{ fontWeight: 600 }}>{describe(s.cron)}</div><div className="muted small">{s.timezone}</div></td>
                  <td>{s.environmentName}</td>
                  <td>{SUITE_INFO[s.suite].label}</td>
                  <td className="nowrap">{s.enabled && s.nextRunAt ? fmtInZone(s.nextRunAt, s.timezone) : <span className="muted">Paused</span>}</td>
                  <td>
                    {s.lastJob?.runId && s.lastJob.runStatus ? <Link to={`${base}/runs/${s.lastJob.runId}`}><RunStatusLabel status={s.lastJob.runStatus} /></Link>
                      : s.lastJob ? <span className="muted">{s.lastJob.status === "queued" || s.lastJob.status === "running" ? "In progress" : s.lastJob.status === "error" ? "Couldn't run" : "Cancelled"}</span>
                      : <span className="muted">Not yet</span>}
                    {s.lastError && <div className="muted small">{s.lastError}</div>}
                  </td>
                  {manage && (
                    <td style={{ textAlign: "right" }}>
                      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                        <Button size="sm" onClick={async () => { await toggle.mutateAsync(s).catch(() => null); toast(s.enabled ? "Schedule paused" : "Schedule resumed"); }} aria-label={`${s.enabled ? "Pause" : "Resume"} ${describe(s.cron)}`}>{s.enabled ? "Pause" : "Resume"}</Button>
                        <Button size="sm" onClick={() => setEditing(s)} aria-label={`Edit ${describe(s.cron)}`}>Edit</Button>
                        <Button size="sm" variant="danger" onClick={() => setDeleting(s)} aria-label={`Delete ${describe(s.cron)}`}>Delete</Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorAlert error={toggle.error} />
    </div>
  );
}
