import crypto from "node:crypto";
import fs from "node:fs";
import type { Finding, PluginResult, Severity } from "./types.js";
import { severityRank } from "./types.js";

/**
 * Deterministic triage: stable fingerprints, dedupe, known-issue lookup.
 * The fingerprint ignores volatile parts (ids, numbers, timings) so the same
 * bug keeps the same fingerprint across runs.
 */

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[0-9a-f]{24}/g, "<id>")
    .replace(/\b\d+(\.\d+)?\s*ms\b/g, "<ms>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();

export const fingerprintOf = (f: Finding) =>
  crypto
    .createHash("sha1")
    // A plugin-supplied key is the problem's exact identity and is used verbatim. Findings
    // without one keep the fingerprints they always had.
    .update([f.plugin, normalise(f.title), normalise(f.target), ...(f.key ? [f.key] : [])].join("|"))
    .digest("hex")
    .slice(0, 12);

const MERGED_LISTED = 20;

export interface KnownIssue {
  fingerprint: string;
  title: string;
  reason: string;
  since?: string;
  /** Optional ISO date after which the issue blocks again */
  until?: string;
}

export function loadKnownIssues(file: string): KnownIssue[] {
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(data) ? data : data.issues ?? [];
}

export function triage(results: PluginResult[], known: KnownIssue[]) {
  const byFp = new Map(known.map((k) => [k.fingerprint, k]));
  const today = new Date().toISOString().slice(0, 10);
  for (const r of results) {
    const seen = new Map<string, { kept: Finding; merged: string[] }>();
    r.findings = r.findings.filter((f) => {
      f.fingerprint = fingerprintOf(f);
      const prior = seen.get(f.fingerprint);
      if (prior) {
        // An exact repeat is dropped. A different problem that happens to share the
        // fingerprint must never disappear silently or lower the gate: the kept finding
        // takes the higher severity and lists what was merged into it.
        if (severityRank(f.severity) < severityRank(prior.kept.severity)) prior.kept.severity = f.severity;
        if (prior.kept.flaky && !f.flaky) delete prior.kept.flaky;
        if ((f.detail ?? "") !== (prior.kept.detail ?? "")) prior.merged.push((f.detail ?? f.title).split("\n")[0].slice(0, 300));
        return false;
      }
      seen.set(f.fingerprint, { kept: f, merged: [] });
      const k = byFp.get(f.fingerprint);
      if (k && (!k.until || k.until >= today)) f.known = { reason: k.reason, since: k.since };
      return true;
    });
    for (const { kept, merged } of seen.values()) {
      if (!merged.length) continue;
      const listed = merged.slice(0, MERGED_LISTED).map((m) => `- ${m}`).join("\n");
      kept.detail = `${kept.detail ?? ""}\n\n${merged.length} more finding(s) with the same title and target were merged here:\n${listed}${merged.length > MERGED_LISTED ? `\n…and ${merged.length - MERGED_LISTED} more` : ""}`.trim();
    }
  }
  return results;
}

export function gate(results: PluginResult[], failOn: Severity) {
  const all = results.flatMap((r) => r.findings);
  const blocking = all.filter((f) => !f.known && !f.flaky && severityRank(f.severity) <= severityRank(failOn));
  return { all, blocking, errors: results.filter((r) => r.status === "errored"), newFindings: all.filter((f) => !f.known) };
}

/** Write every current finding into the known-issues file (used once when adopting the agent) */
export function writeBaseline(file: string, results: PluginResult[], existing: KnownIssue[]) {
  const map = new Map(existing.map((k) => [k.fingerprint, k]));
  const today = new Date().toISOString().slice(0, 10);
  for (const f of results.flatMap((r) => r.findings)) {
    if (!f.fingerprint || map.has(f.fingerprint)) continue;
    map.set(f.fingerprint, {
      fingerprint: f.fingerprint,
      title: `[${f.severity}] ${f.plugin}: ${f.title} (${f.target})`,
      reason: "baseline: existed when the QA agent was adopted",
      since: today,
    });
  }
  const issues = [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
  fs.writeFileSync(file, JSON.stringify({ issues }, null, 2) + "\n");
  return issues.length;
}
