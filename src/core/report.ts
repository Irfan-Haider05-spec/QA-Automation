import fs from "node:fs";
import path from "node:path";
import type { Finding, PluginResult, Severity, Suite } from "./types.js";
import { SEVERITY_ORDER, severityRank } from "./types.js";

export interface RunSummary {
  project: string;
  suite: Suite;
  target?: string;
  startedAt: string;
  durationMs: number;
  routesTotal: number;
  routesSelected: number;
  selectionReason: string;
  requests: number;
  results: PluginResult[];
  gate: { failOn: Severity; passed: boolean; blocking: number; envError?: string };
  git?: { sha?: string; ref?: string; pr?: string; repo?: string; ciUrl?: string };
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const sortFindings = (fs: Finding[]) =>
  [...fs].sort((a, b) => Number(!!a.known) - Number(!!b.known) || severityRank(a.severity) - severityRank(b.severity) || a.plugin.localeCompare(b.plugin));

function counts(findings: Finding[]) {
  const c = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) if (!f.known) c[f.severity]++;
  return c;
}

export function writeReports(outDir: string, s: RunSummary) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(s, null, 2));
  fs.writeFileSync(path.join(outDir, "summary.md"), markdown(s));
  fs.writeFileSync(path.join(outDir, "report.html"), html(s));
}

export function markdown(s: RunSummary): string {
  const all = s.results.flatMap((r) => r.findings);
  const c = counts(all);
  const known = all.filter((f) => f.known).length;
  const icon = s.gate.envError ? "⚠️" : s.gate.passed ? "✅" : "❌";
  const lines: string[] = [];
  lines.push(`<!-- qa-agent-report -->`);
  lines.push(`## ${icon} QA agent · ${s.suite} suite`);
  if (s.gate.envError) lines.push(`\n**Environment problem:** ${s.gate.envError}`);
  lines.push(
    `\n**Gate:** ${s.gate.passed ? "passed" : `failed: ${s.gate.blocking} new finding(s) at ${s.gate.failOn} or above`} · ` +
      `critical ${c.critical} · high ${c.high} · medium ${c.medium} · low ${c.low} · known ${known}`,
  );
  lines.push(`\nTarget: \`${s.target ?? "static only"}\` · routes ${s.routesSelected}/${s.routesTotal} (${s.selectionReason}) · ${s.requests} requests · ${(s.durationMs / 1000).toFixed(0)}s`);
  lines.push(`\n| Plugin | Status | Findings | Time |\n|---|---|---|---|`);
  for (const r of s.results) {
    const n = r.findings.filter((f) => !f.known).length;
    lines.push(`| ${r.plugin} | ${r.status}${r.reason && r.status !== "failed" ? ` (${r.reason})` : ""} | ${n} | ${(r.durationMs / 1000).toFixed(1)}s |`);
  }
  const top = sortFindings(all.filter((f) => !f.known)).slice(0, 15);
  if (top.length) {
    lines.push(`\n### New findings`);
    for (const f of top) lines.push(`- **${f.severity}** · ${f.title} · \`${f.target}\` _(${f.plugin}, ${f.fingerprint})_`);
    if (all.filter((f) => !f.known).length > top.length) lines.push(`- …and ${all.filter((f) => !f.known).length - top.length} more in the full report`);
  }
  lines.push(`\nFull report: \`report.html\` in the run artifacts.`);
  return lines.join("\n") + "\n";
}

export function html(s: RunSummary): string {
  const all = sortFindings(s.results.flatMap((r) => r.findings));
  const c = counts(all);
  const known = all.filter((f) => f.known).length;
  const verdict = s.gate.envError ? "env" : s.gate.passed ? "pass" : "fail";
  const verdictText = s.gate.envError ? "Environment problem" : s.gate.passed ? "Gate passed" : "Gate failed";
  const rows = all
    .map((f) => {
      const ev = f.evidence ?? {};
      const evParts = [
        ev.status !== undefined ? `<div><b>Status</b> ${esc(ev.status)}</div>` : "",
        ev.file ? `<div><b>Source</b> <code>${esc(ev.file)}${ev.line ? ":" + ev.line : ""}</code></div>` : "",
        ev.curl ? `<pre>${esc(ev.curl)}</pre>` : "",
        ev.responseSnippet ? `<pre>${esc(ev.responseSnippet)}</pre>` : "",
        ev.log ? `<pre>${esc(ev.log)}</pre>` : "",
        ev.image ? `<a href="${esc(ev.image)}" target="_blank"><img class="shot" loading="lazy" src="${esc(ev.image)}" alt="Screenshot for this finding"></a>` : "",
      ].join("");
      return `<tr class="sev-${f.severity}${f.known ? " known" : ""}" data-sev="${f.severity}" data-known="${f.known ? 1 : 0}">
<td><span class="pill ${f.severity}">${f.severity}</span>${f.known ? '<span class="pill k">known</span>' : ""}</td>
<td><div class="t">${esc(f.title)}</div><div class="tg"><code>${esc(f.target)}</code></div>${f.detail ? `<p>${esc(f.detail)}</p>` : ""}${f.known ? `<p class="kn">Known: ${esc(f.known.reason)}</p>` : ""}
${evParts ? `<details><summary>Evidence</summary>${evParts}</details>` : ""}</td>
<td>${esc(f.plugin)}<div class="fp">${esc(f.category)} · ${esc(f.fingerprint)}</div></td></tr>`;
    })
    .join("\n");
  const pluginRows = s.results
    .map((r) => `<tr><td>${esc(r.plugin)}</td><td><span class="st ${r.status}">${r.status}</span></td><td>${r.findings.filter((f) => !f.known).length}</td><td>${(r.durationMs / 1000).toFixed(1)}s</td><td>${esc(r.reason ?? "")}${r.stats ? `<div class="fp">${esc(Object.entries(r.stats).map(([k, v]) => `${k}: ${v}`).join(" · "))}</div>` : ""}</td></tr>`)
    .join("\n");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA report · ${esc(s.project)} · ${esc(s.suite)}</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--ink:#141a26;--muted:#5a6476;--rule:#d9dee7;--accent:#2346d8;--crit:#9b1c1c;--high:#c2410c;--med:#a16207;--low:#2563eb;--info:#64748b;--ok:#15803d;--code:#eef1f6;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#10141c;--panel:#171c27;--ink:#e7eaf0;--muted:#9aa4b5;--rule:#2a3242;--accent:#7d97ff;--crit:#ff8a8a;--high:#fb923c;--med:#facc15;--low:#7aa2ff;--info:#94a3b8;--ok:#5cc98a;--code:#1c2230;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Segoe UI",Roboto,system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 18px 60px;display:grid;gap:20px}
h1{margin:0;font-size:26px}h2{margin:0 0 8px;font-size:18px}.muted{color:var(--muted)}code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
pre{background:var(--code);padding:8px 10px;border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:6px 0}
.head{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;justify-content:space-between}
.verdict{font-weight:700;padding:6px 14px;border-radius:999px;color:#fff}.verdict.pass{background:var(--ok)}.verdict.fail{background:var(--crit)}.verdict.env{background:var(--med);color:#111}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.tile{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:10px 12px}.tile b{display:block;font-size:24px;font-variant-numeric:tabular-nums}
.tile.critical b{color:var(--crit)}.tile.high b{color:var(--high)}.tile.medium b{color:var(--med)}.tile.low b{color:var(--low)}
.box{background:var(--panel);border:1px solid var(--rule);border-radius:6px;overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:720px}th,td{text-align:left;vertical-align:top;padding:9px 11px;border-bottom:1px solid var(--rule)}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:var(--code)}
.pill{display:inline-block;font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;margin:0 4px 4px 0;color:#fff;text-transform:uppercase}
.pill.critical{background:var(--crit)}.pill.high{background:var(--high)}.pill.medium{background:var(--med);color:#111}.pill.low{background:var(--low)}.pill.info{background:var(--info)}.pill.k{background:transparent;color:var(--muted);border:1px solid var(--rule)}
tr.known{opacity:.6}.t{font-weight:600}.tg{margin-top:2px}.fp{font-size:12px;color:var(--muted)}.kn{color:var(--muted);font-style:italic}td p{margin:6px 0 0;white-space:pre-line}
details summary{cursor:pointer;color:var(--accent);margin-top:6px}
.shot{display:block;max-width:420px;max-height:260px;object-fit:cover;object-position:top;border:1px solid var(--rule);border-radius:4px;margin-top:6px}
.st{font-weight:600}.st.passed{color:var(--ok)}.st.failed{color:var(--crit)}.st.errored{color:var(--high)}.st.skipped{color:var(--muted)}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.filters label{display:flex;gap:4px;align-items:center;font-size:14px}
</style></head><body><div class="wrap">
<div class="head"><div><h1>QA report · ${esc(s.project)}</h1>
<div class="muted">Suite <b>${esc(s.suite)}</b> · target <code>${esc(s.target ?? "static only")}</code> · ${esc(s.startedAt)} · ${(s.durationMs / 1000).toFixed(0)}s${s.git?.sha ? ` · commit <code>${esc(s.git.sha.slice(0, 8))}</code>` : ""}</div></div>
<span class="verdict ${verdict}">${verdictText}</span></div>
${s.gate.envError ? `<div class="box" style="padding:12px 14px"><b>Environment problem:</b> ${esc(s.gate.envError)}</div>` : ""}
<div class="tiles">
<div class="tile critical"><b>${c.critical}</b>critical</div><div class="tile high"><b>${c.high}</b>high</div><div class="tile medium"><b>${c.medium}</b>medium</div><div class="tile low"><b>${c.low}</b>low</div>
<div class="tile"><b>${c.info}</b>info</div><div class="tile"><b>${known}</b>known</div><div class="tile"><b>${s.routesSelected}/${s.routesTotal}</b>routes tested</div><div class="tile"><b>${s.requests}</b>requests</div></div>
<p class="muted" style="margin:0">Gate fails on new findings at <b>${esc(s.gate.failOn)}</b> or above. Route selection: ${esc(s.selectionReason)}.</p>
<div><h2>Plugins</h2><div class="box"><table><thead><tr><th>Plugin</th><th>Status</th><th>New</th><th>Time</th><th>Notes</th></tr></thead><tbody>${pluginRows}</tbody></table></div></div>
<div><h2>Findings</h2>
<div class="filters"><label><input type="checkbox" id="hideKnown"> Hide known</label>
${SEVERITY_ORDER.map((sv) => `<label><input type="checkbox" class="sevf" value="${sv}" checked> ${sv}</label>`).join("")}</div>
<div class="box" style="margin-top:8px"><table><thead><tr><th style="width:120px">Severity</th><th>Finding</th><th style="width:220px">Plugin</th></tr></thead><tbody id="rows">${rows || '<tr><td colspan="3">No findings.</td></tr>'}</tbody></table></div></div>
</div><script>
(function(){var hk=document.getElementById('hideKnown');var cbs=[].slice.call(document.querySelectorAll('.sevf'));
function apply(){var on=cbs.filter(function(c){return c.checked}).map(function(c){return c.value});
[].slice.call(document.querySelectorAll('#rows tr[data-sev]')).forEach(function(tr){var show=on.indexOf(tr.dataset.sev)>=0&&!(hk.checked&&tr.dataset.known==='1');tr.style.display=show?'':'none';});}
hk.addEventListener('change',apply);cbs.forEach(function(c){c.addEventListener('change',apply)});})();
</script></body></html>`;
}
