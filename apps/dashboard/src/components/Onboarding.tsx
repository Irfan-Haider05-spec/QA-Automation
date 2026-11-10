import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface Status {
  steps: Record<"project" | "environment" | "verified" | "accounts" | "connected" | "firstRun" | "notifications" | "team", boolean>;
  firstProjectId: string | null;
  done: number;
  total: number;
}

const hiddenKey = (orgId: string) => `qa.onboarding.hidden.${orgId}`;

/** First-run checklist on the overview, for owners and admins, until it's done or hidden */
export function Onboarding({ orgId }: { orgId: string }) {
  const q = useQuery({ queryKey: ["org", orgId, "onboarding"], queryFn: () => api<Status>("GET", `/orgs/${orgId}/onboarding`) });
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(hiddenKey(orgId)) === "1"; } catch { return false; } });
  const s = q.data;
  if (!s || hidden || s.done === s.total) return null;
  const o = `/o/${orgId}`;
  const p = s.firstProjectId ? `${o}/projects/${s.firstProjectId}` : null;
  const inProject = (tab: string) => (p ? `${p}/${tab}` : `${o}/projects?new=1`);
  const items: Array<{ key: keyof Status["steps"]; title: string; why: string; to: string }> = [
    { key: "project", title: "Create a project", why: "One codebase you want tested: its API, dashboards or app.", to: `${o}/projects?new=1` },
    { key: "environment", title: "Add the staging environment", why: "The URL of the deployed API (and dashboards) the checks run against.", to: inProject("environments") },
    { key: "verified", title: "Verify the staging domain", why: "A DNS record or a file proves it's yours. Hosted runs only test verified domains.", to: inProject("environments") },
    { key: "accounts", title: "Store the test accounts", why: "Logins for each role. They're encrypted and handed to runs, never shown again.", to: inProject("environments") },
    { key: "connected", title: "Connect CI or schedule runs", why: "An API key for GitHub Actions, or a nightly schedule on the hosted runner.", to: inProject("ci") },
    { key: "firstRun", title: "Get the first run", why: "Open a pull request, or press Run now on the Runs tab.", to: inProject("runs") },
    { key: "notifications", title: "Send alerts to Slack or email", why: "Hear about failed gates and issues that come back.", to: `${o}/notifications` },
    { key: "team", title: "Invite your team", why: "Developers fix issues; clients can get read-only access to their projects.", to: `${o}/members` },
  ];
  const next = items.find((i) => !s.steps[i.key]);
  return (
    <section className="panel onboarding" aria-labelledby="onb-title">
      <div className="panel-head">
        <div>
          <h2 id="onb-title">Getting started</h2>
          <p className="muted small">{s.done} of {s.total} done</p>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => { try { localStorage.setItem(hiddenKey(orgId), "1"); } catch { /* storage off */ } setHidden(true); }}>Hide checklist</button>
      </div>
      <progress className="onb-progress" max={s.total} value={s.done} aria-label={`Setup progress: ${s.done} of ${s.total} steps done`} />
      <ol className="onb-list">
        {items.map((i) => {
          const done = s.steps[i.key];
          return (
            <li key={i.key} className={done ? "done" : i === next ? "next" : ""}>
              <span className="onb-mark" aria-hidden="true">{done ? "✓" : ""}</span>
              <div>
                {done ? <span className="onb-title">{i.title}</span> : <Link className="onb-title" to={i.to}>{i.title}</Link>}
                <span className="sr-only">{done ? " (done)" : " (to do)"}</span>
                {!done && <p className="muted small">{i.why}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
