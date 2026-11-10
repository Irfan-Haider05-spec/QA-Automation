/**
 * The client report, as shown in the dashboard and on public share links, and
 * printed to PDF (see the print rules in app.css). Plain language, no evidence.
 */
import { useEffect, useRef, useState } from "react";
import type { Report } from "../api/types";
import { SeverityLabel } from "./ui";

const SEV = ["critical", "high", "medium", "low", "info"] as const;
const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtShort = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Runs per day. Position carries the outcome so it reads without color:
 * passed runs grow up from the baseline, runs that didn't pass grow down;
 * "couldn't reach" is hatched. A legend and a table view are always there.
 */
function DailyChart({ days }: { days: Report["days"] }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the box's real width so axis text keeps its size on phones (a scaled viewBox shrinks it)
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 180, pad = { l: 28, r: 8, t: 12, b: 24 };
  const mid = pad.t + (H - pad.t - pad.b) / 2;
  const half = (H - pad.t - pad.b) / 2 - 4;
  const max = Math.max(1, ...days.map((d) => Math.max(d.passed, d.failed + d.envError)));
  const slot = (W - pad.l - pad.r) / days.length;
  const bw = Math.max(2, Math.min(24, slot - 2));
  const y = (n: number) => (n / max) * half;
  const ticks = days.length <= 14 ? days.map((_, i) => i) : [0, Math.floor(days.length / 2), days.length - 1];
  // Rounded data-end, square at the baseline
  const bar = (x: number, h: number, up: boolean) => {
    if (h <= 0) return "";
    const r = Math.min(4, bw / 2, h);
    return up
      ? `M${x},${mid - 1} V${mid - h + r} Q${x},${mid - h} ${x + r},${mid - h} H${x + bw - r} Q${x + bw},${mid - h} ${x + bw},${mid - h + r} V${mid - 1} Z`
      : `M${x},${mid + 1} V${mid + h - r} Q${x},${mid + h} ${x + r},${mid + h} H${x + bw - r} Q${x + bw},${mid + h} ${x + bw},${mid + h - r} V${mid + 1} Z`;
  };
  const hv = hover !== null ? days[hover] : null;
  return (
    <figure className="chart" aria-labelledby="chart-cap">
      <figcaption id="chart-cap" className="chart-head">
        <span>Runs per day</span>
        <span className="legend" aria-hidden="true">
          <span><i className="sw pass" />Passed (above the line)</span>
          <span><i className="sw fail" />Failed (below)</span>
          <span><i className="sw env" />Couldn't reach the environment</span>
        </span>
      </figcaption>
      <div className="chart-box" ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Runs per day from ${fmtDay(days[0].date)} to ${fmtDay(days[days.length - 1].date)}. The table below has the numbers.`} onMouseLeave={() => setHover(null)}>
          <defs>
            <pattern id="hatch" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
              <rect width="5" height="5" className="hatch-bg" />
              <line x1="0" y1="0" x2="0" y2="5" className="hatch-line" strokeWidth="2.2" />
            </pattern>
          </defs>
          <text x={pad.l - 6} y={mid - half + 4} className="axis" textAnchor="end">{max}</text>
          <text x={pad.l - 6} y={mid + half + 4} className="axis" textAnchor="end">{max}</text>
          <line x1={pad.l} x2={W - pad.r} y1={mid} y2={mid} className="baseline" />
          {days.map((d, i) => {
            const x = pad.l + i * slot + (slot - bw) / 2;
            const failH = y(d.failed);
            const envH = y(d.envError);
            return (
              <g key={d.date} className={hover === i ? "day on" : "day"}>
                <path d={bar(x, y(d.passed), true)} className="m-pass" />
                {/* stacked below: failed next to the line, then a 2px gap, then couldn't-reach */}
                <path d={bar(x, failH, false)} className="m-fail" />
                {envH > 0 && <rect x={x} y={mid + failH + (failH ? 2 : 1)} width={bw} height={Math.max(2, envH - (failH ? 2 : 0))} rx={Math.min(2, bw / 2)} className="m-env" fill="url(#hatch)" />}
                <rect x={pad.l + i * slot} y={pad.t} width={slot} height={H - pad.t - pad.b} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
          {ticks.map((i) => (
            <text key={i} x={pad.l + i * slot + slot / 2} y={H - 6} className="axis" textAnchor={i === 0 && days.length > 14 ? "start" : i === days.length - 1 && days.length > 14 ? "end" : "middle"}>
              {fmtShort(days[i].date)}
            </text>
          ))}
        </svg>
        {hv && (
          <div className="tip" style={{ left: `${((pad.l + hover! * slot + slot / 2) / W) * 100}%` }} role="status">
            <b>{fmtDay(hv.date)}</b>
            <span>{hv.passed} passed</span><span>{hv.failed} failed</span>{hv.envError > 0 && <span>{hv.envError} couldn't reach</span>}
          </div>
        )}
      </div>
      <details className="no-print">
        <summary>Show as a table</summary>
        <table className="table compact">
          <thead><tr><th>Day</th><th className="num">Passed</th><th className="num">Failed</th><th className="num">Couldn't reach</th></tr></thead>
          <tbody>{days.filter((d) => d.passed + d.failed + d.envError > 0).map((d) => <tr key={d.date}><td>{fmtDay(d.date)}</td><td className="num">{d.passed}</td><td className="num">{d.failed}</td><td className="num">{d.envError}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}

export function ReportView({ report: r }: { report: Report }) {
  const t = r.totals;
  return (
    <article className="report" aria-label={`Quality report for ${r.scope.name}`}>
      <header className="report-head">
        <p className="report-org">{r.org.name}</p>
        <h1>{r.scope.name}: quality report</h1>
        <p className="muted">{fmtDay(r.period.from)} to {fmtDay(r.period.to)} · {t.projects === 1 ? "1 project" : `${t.projects} projects`}</p>
      </header>

      <section className="report-lead" aria-label="Summary">
        <div className="lead-main">
          <span className="lead-num" data-testid="pass-rate">{t.passRate === null ? "No runs" : `${t.passRate}%`}</span>
          <span className="lead-label">{t.passRate === null ? "in this period" : `of ${t.runs} test runs passed the quality gate`}</span>
        </div>
        <dl className="lead-facts">
          <div><dt>Open issues</dt><dd>{t.openIssues}</dd></div>
          <div><dt>Fixed</dt><dd>{t.fixedIssues}</dd></div>
          <div><dt>New</dt><dd>{t.newIssues}</dd></div>
          <div><dt>Came back</dt><dd>{t.regressions}</dd></div>
        </dl>
      </section>

      {t.openIssues > 0 && (
        <p className="sev-line" aria-label="Open issues by severity">
          {SEV.filter((s) => t.openBySeverity[s]).map((s) => <span key={s}><SeverityLabel s={s} /> {t.openBySeverity[s]}</span>)}
        </p>
      )}

      {t.runs > 0 && <DailyChart days={r.days} />}

      {r.projects.length > 1 && (
        <section aria-labelledby="rp-h">
          <h2 id="rp-h">Projects</h2>
          <div className="table-wrap"><table className="table compact">
            <thead><tr><th>Project</th><th className="num">Runs</th><th className="num">Passed</th><th>Latest run</th><th className="num">Open</th><th className="num">Fixed</th></tr></thead>
            <tbody>
              {r.projects.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="num">{p.runs}</td>
                  <td className="num">{p.passRate === null ? "–" : `${p.passRate}%`}</td>
                  <td>{p.lastRun ? <span className={`status ${p.lastRun.status}`}>{p.lastRun.status === "passed" ? "Passed" : p.lastRun.status === "failed" ? "Failed" : "Couldn't reach"}</span> : <span className="muted">No runs</span>}</td>
                  <td className="num">{SEV.reduce((a, s) => a + p.open[s], 0)}</td>
                  <td className="num">{p.fixedInPeriod}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}

      <section aria-labelledby="ro-h">
        <h2 id="ro-h">Open issues</h2>
        {!r.openIssues.length ? <p className="muted">None. Every issue found so far is fixed.</p> : (
          <div className="table-wrap"><table className="table compact issues">
            <thead><tr><th>Severity</th><th>Issue</th>{r.projects.length > 1 && <th>Project</th>}<th>Since</th></tr></thead>
            <tbody>
              {r.openIssues.map((i, n) => (
                <tr key={n}>
                  <td><SeverityLabel s={i.severity} /></td>
                  <td>
                    <div>{i.title}</div>
                    <div className="mono small muted">{i.target}</div>
                    {i.status === "accepted" && <div className="small">Accepted for now{i.acceptedUntil ? ` until ${fmtDay(i.acceptedUntil)}` : ""}{i.acceptedReason ? `: ${i.acceptedReason}` : ""}</div>}
                  </td>
                  {r.projects.length > 1 && <td>{i.project}</td>}
                  <td className="nowrap">{fmtDay(i.firstSeenAt.slice(0, 10))}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      {r.fixedIssues.length > 0 && (
        <section aria-labelledby="rf-h">
          <h2 id="rf-h">Fixed in this period</h2>
          <div className="table-wrap"><table className="table compact">
            <thead><tr><th>Severity</th><th>Issue</th>{r.projects.length > 1 && <th>Project</th>}<th>Fixed</th></tr></thead>
            <tbody>
              {r.fixedIssues.map((i, n) => (
                <tr key={n}>
                  <td><SeverityLabel s={i.severity} /></td>
                  <td><div>{i.title}</div><div className="mono small muted">{i.target}</div></td>
                  {r.projects.length > 1 && <td>{i.project}</td>}
                  <td className="nowrap">{fmtDay(i.fixedAt.slice(0, 10))}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}

      <footer className="report-foot muted small">
        Generated {new Date(r.generatedAt).toLocaleString()} by automated API and dashboard checks. Issues are counted once however often a check finds them.
      </footer>
    </article>
  );
}

/** Open and fixed issues as CSV, for clients who track work in a spreadsheet */
export function reportCsv(r: Report): string {
  const esc = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    // Leading = + - @ would be run as formulas by spreadsheet apps
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rows: Array<Array<string | number | null>> = [["Status", "Severity", "Project", "Issue", "Where", "Since or fixed", "Note"]];
  for (const i of r.openIssues) rows.push([i.status === "accepted" ? "Accepted" : "Open", i.severity, i.project, i.title, i.target, i.firstSeenAt.slice(0, 10), i.acceptedReason]);
  for (const i of r.fixedIssues) rows.push(["Fixed", i.severity, i.project, i.title, i.target, i.fixedAt.slice(0, 10), null]);
  return rows.map((row) => row.map(esc).join(",")).join("\r\n") + "\r\n";
}
