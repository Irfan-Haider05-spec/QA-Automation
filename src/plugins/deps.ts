/**
 * Known-vulnerable dependencies via `npm audit` (reads package-lock.json only,
 * no install needed). Severities are shifted down one level so long-standing
 * advisories do not block every PR; critical advisories still block at the
 * default gate (high).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Finding, QaPlugin, Severity } from "../core/types.js";

const MAP: Record<string, Severity> = { critical: "high", high: "medium", moderate: "low", low: "info", info: "info" };

export const depsPlugin: QaPlugin = {
  name: "deps",
  layer: "static",
  description: "npm audit on the backend lockfile",
  skipReason(ctx) {
    return fs.existsSync(path.join(ctx.config.backend.dir, "package-lock.json")) ? null : "no package-lock.json in backend";
  },
  async run(ctx) {
    const res = spawnSync("npm", ["audit", "--json", "--package-lock-only", "--omit=dev"], { cwd: ctx.config.backend.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
    let data: any;
    try { data = JSON.parse(res.stdout); } catch { throw new Error(`npm audit gave no JSON: ${(res.stderr || res.stdout).slice(0, 300)}`); }
    if (data.error) throw new Error(`npm audit failed: ${data.error.summary ?? JSON.stringify(data.error).slice(0, 200)}`);
    const findings: Finding[] = [];
    for (const [name, v] of Object.entries<any>(data.vulnerabilities ?? {})) {
      // Only report packages that carry an advisory themselves (skip "via another package" entries)
      const advisories = (v.via ?? []).filter((x: any) => typeof x === "object");
      if (!advisories.length) continue;
      const titles = [...new Set(advisories.map((a: any) => a.title))].slice(0, 3).join("; ");
      const fix = v.fixAvailable === true ? "fix available via npm audit fix" : v.fixAvailable?.name ? `fix: upgrade ${v.fixAvailable.name} to ${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? " (major)" : ""}` : "no fix available yet";
      findings.push({
        plugin: this.name, severity: MAP[v.severity] ?? "low", category: "security", target: name,
        title: `Vulnerable dependency ${name} (${v.severity})`,
        detail: `${titles}. Affected range ${v.range}. ${fix}.`,
        evidence: { log: advisories.map((a: any) => a.url).filter(Boolean).join("\n") },
      });
    }
    const m = data.metadata?.vulnerabilities ?? {};
    return { findings, stats: { critical: m.critical ?? 0, high: m.high ?? 0, moderate: m.moderate ?? 0, low: m.low ?? 0 } };
  },
};
