/**
 * Mobile app flows with Maestro (Flutter, React Native, native): each YAML flow
 * in mobile.flowsDir runs on a connected device or emulator; every failed flow
 * becomes a finding with Maestro's message and its failure screenshot.
 *
 * Test-account logins reach the flows as variables: mobile.env maps a variable
 * to "{{account.identifier}}" / "{{account.password}}", e.g.
 *   env: { MERCHANT_EMAIL: "{{merchantA.identifier}}", MERCHANT_PASSWORD: "{{merchantA.password}}" }
 * and the flow types ${MERCHANT_EMAIL}. Flutter widgets need Semantics labels
 * (or keys exposed as identifiers) for Maestro to find them.
 *
 * Skipped (not failed) when Maestro isn't installed or no device is connected.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SkipError, type Finding, type QaPlugin } from "../core/types.js";
import type { RunContext } from "../core/context.js";

export interface JUnitCase { name: string; suite: string; seconds: number; failure?: string }

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? decode(m[1]) : undefined; };

/** Minimal JUnit XML reader (Maestro's --format junit): testcases with their failure/error text */
export function parseJUnit(xml: string): JUnitCase[] {
  const out: JUnitCase[] = [];
  for (const suite of xml.matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g)) {
    const suiteName = attr(suite[1], "name") ?? "";
    for (const tc of suite[2].matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const body = tc[3] ?? "";
      const fail = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
      out.push({
        name: attr(tc[1], "name") ?? attr(tc[1], "id") ?? "flow",
        suite: suiteName,
        seconds: Number(attr(tc[1], "time") ?? 0),
        failure: fail ? decode((attr(fail[2], "message") ?? "") + (fail[3] ? `\n${fail[3].trim()}` : "")).trim() || "failed" : undefined,
      });
    }
  }
  return out;
}

/** "{{merchantA.identifier}}" → the account's value */
export function fillEnv(env: Record<string, string>, accounts: RunContext["config"]["accounts"]): { vars: Record<string, string>; missing: string[] } {
  const vars: Record<string, string> = {};
  const missing: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    vars[k] = v.replace(/\{\{(\w+)\.(identifier|password)\}\}/g, (_, acc: string, field: "identifier" | "password") => {
      const val = accounts[acc]?.[field];
      if (!val) { missing.push(`${k} (${acc}.${field})`); return ""; }
      return val;
    });
  }
  return { vars, missing };
}

const NO_DEVICE = /no (connected )?devices?|device .* not (found|connected)|not connected to any device|Please start an emulator|No device was found/i;

function findScreenshot(dir: string, flow: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const all: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : /\.png$/i.test(e.name) && all.push(p); } };
  walk(dir);
  const key = flow.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return all.find((p) => /❌|fail/i.test(path.basename(p)) && path.basename(p).toLowerCase().replace(/[^a-z0-9]+/g, "").includes(key)) ?? all.find((p) => /❌|fail/i.test(path.basename(p)));
}

export const mobilePlugin: QaPlugin = {
  name: "mobile",
  layer: "web",
  description: "Maestro flows on a device or emulator (Flutter and other mobile apps)",
  skipReason(ctx) {
    const dir = path.resolve(ctx.configDir, ctx.config.mobile.flowsDir);
    if (!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => /\.ya?ml$/.test(f))) return `no Maestro flows in ${ctx.config.mobile.flowsDir}`;
    const v = spawnSync(ctx.config.mobile.maestroPath, ["--version"], { encoding: "utf8", timeout: 60000 });
    if (v.error || v.status !== 0) return `Maestro isn't installed (${ctx.config.mobile.maestroPath}); see https://maestro.dev`;
    return null;
  },
  async run(ctx) {
    const M = ctx.config.mobile;
    const dir = path.resolve(ctx.configDir, M.flowsDir);
    const out = path.join(ctx.outDir, "mobile");
    const debug = path.join(out, "debug");
    fs.rmSync(out, { recursive: true, force: true }); // never read a previous run's results
    fs.mkdirSync(debug, { recursive: true });
    const junit = path.join(out, "junit.xml");
    const { vars, missing } = fillEnv(M.env, ctx.config.accounts);
    if (missing.length) throw new SkipError(`no login for ${missing.join(", ")}`);

    const args = [
      ...(M.device ? ["--device", M.device] : []),
      "test", dir, "--format", "junit", "--output", junit, "--debug-output", debug,
      ...(M.includeTags.length ? ["--include-tags", M.includeTags.join(",")] : []),
      ...(M.excludeTags.length ? ["--exclude-tags", M.excludeTags.join(",")] : []),
      ...Object.entries({ ...(M.appId ? { APP_ID: M.appId } : {}), ...vars }).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ];
    ctx.log.info(`mobile: maestro test ${path.relative(ctx.configDir, dir)}${M.device ? ` on ${M.device}` : ""}`);
    const r = spawnSync(M.maestroPath, args, { encoding: "utf8", timeout: M.timeoutMin * 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MAESTRO_CLI_NO_ANALYTICS: "1" } });
    const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    if (!fs.existsSync(junit)) {
      if (NO_DEVICE.test(output)) throw new SkipError("no device or emulator connected (start one, or set mobile.device)");
      throw new Error(`Maestro produced no results (exit ${r.status}): ${output.trim().split("\n").slice(-4).join(" ").slice(0, 400)}`);
    }
    const cases = parseJUnit(fs.readFileSync(junit, "utf8"));
    const findings: Finding[] = [];
    for (const c of cases.filter((x) => x.failure)) {
      const shot = findScreenshot(debug, c.name);
      findings.push({
        plugin: this.name, severity: M.severity, category: "regression", target: `mobile ${c.name}`,
        title: `Mobile flow "${c.name}" failed: ${c.failure!.split("\n")[0].slice(0, 160)}`,
        detail: c.failure!.slice(0, 1500),
        evidence: { file: path.relative(ctx.configDir, path.join(dir, `${c.name}.yaml`)), image: shot ? path.relative(ctx.outDir, shot) : undefined, log: output.trim().split("\n").slice(-15).join("\n") },
      });
    }
    for (const c of cases.filter((x) => !x.failure && M.maxSeconds && x.seconds > M.maxSeconds)) {
      findings.push({ plugin: this.name, severity: "low", category: "performance", target: `mobile ${c.name} duration`, title: `Mobile flow "${c.name}" took ${Math.round(c.seconds)} s (limit ${M.maxSeconds} s)` });
    }
    return { findings, stats: { flows: cases.length, passed: cases.filter((c) => !c.failure).length, failed: cases.filter((c) => c.failure).length } };
  },
};
