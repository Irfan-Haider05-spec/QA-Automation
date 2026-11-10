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
    .update([f.plugin, normalise(f.title), normalise(f.target)].join("|"))
    .digest("hex")
    .slice(0, 12);

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
    const seen = new Set<string>();
    r.findings = r.findings.filter((f) => {
      f.fingerprint = fingerprintOf(f);
      if (seen.has(f.fingerprint)) return false;
      seen.add(f.fingerprint);
      const k = byFp.get(f.fingerprint);
      if (k && (!k.until || k.until >= today)) f.known = { reason: k.reason, since: k.since };
      return true;
    });
  }
  return results;
}

export function gate(results: PluginResult[], failOn: Severity) {
  const all = results.flatMap((r) => r.findings);
  const blocking = all.filter((f) => !f.known && severityRank(f.severity) <= severityRank(failOn));
  return { all, blocking, newFindings: all.filter((f) => !f.known) };
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
