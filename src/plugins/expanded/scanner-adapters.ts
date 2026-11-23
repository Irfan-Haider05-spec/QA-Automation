import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Finding, Severity } from "../../core/types.js";
import { checkedPlugin, issue, readJson } from "./support.js";
import { executeMobSF } from "../../core/mobsf-execution.js";

const exec = promisify(execFile);
const sarif = z.object({ version: z.literal("2.1.0"), runs: z.array(z.object({
  tool: z.object({ driver: z.object({ name: z.string() }) }),
  invocations: z.array(z.object({ executionSuccessful: z.boolean().optional() }).passthrough()).optional(),
  results: z.array(z.object({ ruleId: z.string().optional(), level: z.enum(["none", "note", "warning", "error"]).optional(),
    message: z.object({ text: z.string().optional(), markdown: z.string().optional() }),
    locations: z.array(z.object({ physicalLocation: z.object({ artifactLocation: z.object({ uri: z.string().optional() }).optional(), region: z.object({ startLine: z.number().optional(), startColumn: z.number().optional() }).optional() }).optional() })).optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    fingerprints: z.record(z.string(), z.unknown()).optional(), partialFingerprints: z.record(z.string(), z.unknown()).optional() }).passthrough()),
}) ).min(1) });

/**
 * SARIF file locations relative to the backend folder, the form changed files use. Scanners
 * write absolute paths, file:// URIs or paths relative to where they ran (the configuration
 * folder when VeriQ runs them); every form is tried, so changed-file filtering cannot miss.
 */
export function sarifPaths(uri: string, backendDir: string, configDir: string): string[] {
  let file = uri;
  if (/^file:/i.test(file)) { try { file = fileURLToPath(file); } catch { return [uri]; } }
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) return [uri];
  try { file = decodeURI(file); } catch { /* keep the raw form */ }
  const bases = path.isAbsolute(file) ? [""] : [configDir, backendDir];
  const out = new Set<string>();
  for (const base of bases) {
    const rel = path.relative(backendDir, path.resolve(base || backendDir, file)).split(path.sep).join("/");
    if (rel && !rel.startsWith("../") && rel !== ".." && !path.isAbsolute(rel)) out.add(rel);
  }
  return [...out];
}

/** A scanner-supplied content fingerprint when it is a real hash (Semgrep writes "requires login" without an account). */
function scannerFingerprint(r: { fingerprints?: Record<string, unknown>; partialFingerprints?: Record<string, unknown> }) {
  for (const value of [...Object.values(r.partialFingerprints ?? {}), ...Object.values(r.fingerprints ?? {})]) {
    if (typeof value === "string" && /^[0-9a-f][0-9a-f:._-]{15,}$/i.test(value)) return value;
  }
  return undefined;
}

const scannerSettings = z.object({ report: z.string().min(1),
  run: z.boolean().default(false), baseline: z.string().optional(),
  rules: z.string().optional(), target: z.string().default("."), timeoutMs: z.number().int().min(1000).max(600000).default(120000),
}).strict();

/** Reports may be generated in CI, keeping scanner installations out of hosted workers.
 * Optional execution uses fixed executables/arguments and no command shell. */
function scanner(name: "sast" | "container-iac", executable: "semgrep" | "trivy") {
  return checkedPlugin(name, "static", `Import ${executable} SARIF, optionally invoke the installed scanner`, scannerSettings, async (ctx, c) => {
    const reportFile = path.resolve(ctx.configDir, c.report);
    if (c.run) {
      const relative = path.relative(ctx.outDir, reportFile);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Generated scanner report must be inside outDir");
      const target = path.resolve(ctx.configDir, c.target);
      if (!fs.existsSync(target)) throw new Error("Scanner target does not exist");
      if (executable === "semgrep" && (!c.rules || !fs.existsSync(path.resolve(ctx.configDir, c.rules)))) throw new Error("Semgrep execution requires a local rules file");
      fs.mkdirSync(path.dirname(reportFile), { recursive: true });
      // A prior successful report must never mask a scanner failure.
      if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
      const args = executable === "semgrep"
        ? ["scan", "--config", path.resolve(ctx.configDir, c.rules!), "--metrics=off", "--disable-version-check", "--sarif", "--output", reportFile, target]
        : ["fs", "--scanners", "vuln,misconfig,secret", "--format", "sarif", "--output", reportFile, target];
      try { await exec(executable, args, { cwd: ctx.configDir, shell: false, windowsHide: true, timeout: c.timeoutMs, maxBuffer: 2 * 1024 * 1024 }); }
      catch { throw new Error(`${executable} failed; check its installation/rules/database. No stale report was accepted.`); }
    }
    const doc = sarif.parse(readJson(ctx, c.report));
    const baseline = c.baseline ? sarif.parse(readJson(ctx, c.baseline)) : undefined;
    const signature = (v: z.infer<typeof sarif>["runs"][number]["results"][number]) => `${v.ruleId}|${v.locations?.[0]?.physicalLocation?.artifactLocation?.uri}|${v.message.text ?? v.message.markdown}`;
    const known = new Set(baseline?.runs.flatMap((r) => r.results.map(signature)) ?? []);
    const findings: Finding[] = [];
    for (const run of doc.runs) {
      if (run.invocations?.some((i) => i.executionSuccessful === false)) throw new Error("SARIF records an unsuccessful scanner invocation");
      for (const result of run.results) {
        if (result.level === "none") continue;
        const loc = result.locations?.[0]?.physicalLocation;
        const uri = loc?.artifactLocation?.uri;
        const candidates = uri ? sarifPaths(uri, ctx.config.backend.dir, ctx.configDir) : [];
        // Shown relative to the backend folder: never a local machine path.
        const file = candidates[0] ?? uri ?? "scanner";
        if (ctx.changedFiles) {
          const changed = new Set(ctx.changedFiles.map((f) => f.replace(/\\/g, "/")));
          if (!candidates.some((c) => changed.has(c))) continue;
        }
        const severity: Severity = result.level === "error" ? "high" : result.level === "note" ? "low" : "medium";
        findings.push({ ...issue(name, `Scanner rule: ${result.ruleId ?? "unclassified"}`, `${file}:${loc?.region?.startLine ?? 0}`,
          // Scanner message/snippet can contain source secrets. Keep the rule ID
          // and location here; retain the scanner report under CI access control.
          `Reported by ${run.tool.driver.name}. Inspect the protected scanner report for details.`, severity),
          // Rule, file and position (or the scanner's own hash) identify one match; two matches
          // of one rule in one file are two findings.
          key: `${result.ruleId ?? "unclassified"}|${file}|${scannerFingerprint(result) ?? `${loc?.region?.startLine ?? 0}:${loc?.region?.startColumn ?? 0}`}`,
          evidence: { file, line: loc?.region?.startLine }, ...(known.has(signature(result)) ? { known: { reason: "Present in explicit scanner baseline" } } : {}) });
      }
    }
    return findings;
  });
}
export const sast = scanner("sast", "semgrep");
export const containerIac = scanner("container-iac", "trivy");

const mobileReport = z.object({
  code_analysis: z.object({ findings: z.record(z.string(), z.object({ metadata: z.object({ severity: z.string(), description: z.string().optional() }).passthrough(), files: z.record(z.string(), z.unknown()).optional() }).passthrough()) }),
  binary_analysis: z.object({ findings: z.record(z.string(), z.object({ severity: z.string() }).passthrough()) }).optional(),
  manifest_analysis: z.object({ manifest_findings: z.array(z.object({ rule: z.string().optional(), severity: z.string(), title: z.string().optional(), description: z.string().optional() }).passthrough()) }).optional(),
}).passthrough();
export const mobileStatic = checkedPlugin("mobile-static", "static", "Import MobSF reports or upload and statically scan an APK/IPA on an explicitly configured server",
  z.object({ report: z.string().min(1).optional(), execution: z.object({
    serverUrl: z.string().url(), binary: z.string().min(1).max(4096), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default("MOBSF_API_KEY"),
    allowRemote: z.boolean().default(false), timeoutMs: z.number().int().min(1000).max(900000).default(300000),
    pollIntervalMs: z.number().int().min(100).max(10000).default(1000), maxBinaryMiB: z.number().int().min(1).max(200).default(100),
  }).strict().optional() }).strict().refine(c => !!c.report !== !!c.execution, "Configure report import or execution, not both"), async (ctx, c) => {
    const doc = mobileReport.parse(c.execution ? await executeMobSF(ctx.configDir, c.execution) : readJson(ctx, c.report!)); const findings: Finding[] = [];
    if (c.execution?.binary.toLowerCase().endsWith('.ipa') && !doc.binary_analysis) throw new Error("MobSF IPA report lacks binary analysis coverage");
    const severity = (v: string): Severity => /high|critical/i.test(v) ? "high" : /warning|medium/i.test(v) ? "medium" : "low";
    const adverse = (v: string) => {
      if (!['critical', 'high', 'warning', 'medium', 'low', 'info', 'secure', 'good'].includes(v.toLowerCase())) throw new Error("Unknown MobSF severity; review scanner compatibility");
      return !['secure', 'good'].includes(v.toLowerCase());
    };
    for (const [id, value] of Object.entries(doc.code_analysis.findings)) if (adverse(value.metadata.severity)) findings.push(issue("mobile-static", `Mobile code rule: ${id}`, id,
      "See the access-controlled MobSF report; source snippets and embedded secrets are omitted.", severity(value.metadata.severity)));
    for (const [id, value] of Object.entries(doc.binary_analysis?.findings ?? {})) if (adverse(value.severity)) findings.push(issue("mobile-static", `Mobile binary rule: ${id}`, `binary:${id}`,
      "Review the protected MobSF binary analysis; extracted strings and source details are omitted.", severity(value.severity)));
    for (const [i, value] of (doc.manifest_analysis?.manifest_findings ?? []).entries()) if (adverse(value.severity)) findings.push(issue("mobile-static", `Mobile manifest rule: ${value.rule ?? i}`, value.rule ?? `manifest-${i}`,
      "Review the MobSF manifest finding and apply least-privilege application settings.", severity(value.severity)));
    return findings;
  });
