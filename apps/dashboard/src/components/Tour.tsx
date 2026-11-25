import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A lightweight product tour: no dependencies. It spotlights an element (by a
 * [data-tour] attribute) and shows a popover next to it. Steps whose target is
 * not on the page (e.g. a nav item a role can't see) are skipped.
 *
 * Start it from anywhere with startTour(); it also runs once for a new user.
 */

const SEEN_KEY = "qa.tour.seen.v1";
const EVENT = "veriq:tour:start";

export function startTour() {
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** True until the user has seen (or skipped) the tour once on this browser. */
export function tourUnseen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== "1";
  } catch {
    return false;
  }
}

interface Step {
  target?: string; // CSS selector; omitted = centered card
  title: string;
  body: string;
}

const STEPS: Step[] = [
  { title: "Welcome to VeriQ", body: "A quick tour of the sidebar, so you know where everything is. It takes about a minute — you can skip any time." },
  { target: '[data-tour="overview"]', title: "Overview", body: "Your home. Which projects passed their last run, how many critical issues are open, and the getting-started checklist until you're set up." },
  { target: '[data-tour="projects"]', title: "Projects", body: "One project is one codebase you test — its API, dashboards or app. Each project holds its environments, runs, issues and CI setup." },
  { target: '[data-tour="clients"]', title: "Clients", body: "Group projects by the customer they belong to. A client can be given read-only access to only their own projects." },
  { target: '[data-tour="reports"]', title: "Reports", body: "Every run's full report: the findings, who was notified, and a shareable read-only link for stakeholders." },
  { target: '[data-tour="notifications"]', title: "Notifications", body: "Send alerts to Slack or email when a gate fails or an issue comes back, so no one has to watch the dashboard." },
  { target: '[data-tour="members"]', title: "Members", body: "Invite your team. Developers fix issues; viewers and clients get read-only access. You control who sees what." },
  { target: '[data-tour="settings"]', title: "Settings", body: "Your organization: name, sign-in options, and (later) other preferences. The Audit log, when visible, records who did what." },
  { target: '[data-tour="guide"]', title: "Integration guide", body: "The full how-to for putting VeriQ on a project: qa init, the suites, the baseline, CI and this platform. Open it any time from here." },
];

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function Tour() {
  const [active, setActive] = useState(false);
  const [i, setI] = useState(0);
  const [steps, setSteps] = useState<Step[]>([]);
  const [spot, setSpot] = useState<Box | null>(null);
  const [pop, setPop] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const popRef = useRef<HTMLDivElement>(null);

  const stop = useCallback(() => {
    setActive(false);
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* storage off */
    }
  }, []);

  // Start on the custom event; build the step list from what's actually on the page.
  useEffect(() => {
    const onStart = () => {
      const present = STEPS.filter((s) => !s.target || document.querySelector(s.target));
      setSteps(present);
      setI(0);
      setActive(true);
    };
    window.addEventListener(EVENT, onStart);
    return () => window.removeEventListener(EVENT, onStart);
  }, []);

  const step = steps[i];

  // Measure the target and place the spotlight + popover.
  useLayoutEffect(() => {
    if (!active || !step) return;
    const place = () => {
      const el = step.target ? (document.querySelector(step.target) as HTMLElement | null) : null;
      if (el) {
        const r = el.getBoundingClientRect();
        const pad = 6;
        setSpot({ top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 });
        const popW = 320;
        const popH = popRef.current?.offsetHeight ?? 150;
        let left = r.right + 14;
        if (left + popW > window.innerWidth - 12) left = Math.max(12, r.left - popW - 14);
        let top = r.top;
        if (top + popH > window.innerHeight - 12) top = Math.max(12, window.innerHeight - popH - 12);
        setPop({ top, left });
      } else {
        setSpot(null);
        const popW = 340;
        const popH = popRef.current?.offsetHeight ?? 160;
        setPop({ top: Math.max(16, (window.innerHeight - popH) / 2), left: Math.max(16, (window.innerWidth - popW) / 2) });
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [active, step, i]);

  // Keyboard: Esc closes, arrows/Enter move.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
      else if (e.key === "ArrowRight" || e.key === "Enter") setI((v) => (v + 1 < steps.length ? v + 1 : (stop(), v)));
      else if (e.key === "ArrowLeft") setI((v) => Math.max(0, v - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, steps.length, stop]);

  if (!active || !step) return null;
  const last = i === steps.length - 1;
  return (
    <div className="tour">
      {/* The backdrop: a spotlight cut out of a dark overlay, or a plain dim for centered steps. */}
      {spot ? (
        <div className="tour-spot" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} onClick={stop} />
      ) : (
        <div className="tour-dim" onClick={stop} />
      )}
      <div className="tour-pop" role="dialog" aria-modal="true" aria-labelledby="tour-title" ref={popRef} style={{ top: pop.top, left: pop.left }}>
        <div className="tour-pop-head">
          <h3 id="tour-title">{step.title}</h3>
          <button type="button" className="icon-btn" aria-label="Close tour" onClick={stop}>×</button>
        </div>
        <p>{step.body}</p>
        <div className="tour-pop-foot">
          <span className="muted small">{i + 1} / {steps.length}</span>
          <div className="btn-row">
            {i > 0 && <button type="button" className="btn sm" onClick={() => setI((v) => Math.max(0, v - 1))}>Back</button>}
            {last ? (
              <button type="button" className="btn primary sm" onClick={stop}>Done</button>
            ) : (
              <button type="button" className="btn primary sm" onClick={() => setI((v) => v + 1)}>Next</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
