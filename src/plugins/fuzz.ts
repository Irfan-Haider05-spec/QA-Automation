/**
 * Property-based API fuzzing with Schemathesis against the generated OpenAPI
 * spec. Reads the JUnit report and turns each failing operation into a finding.
 * GET-only unless allowMutations is on; auth endpoints are always excluded so
 * the fuzzer cannot log the QA account out mid-run.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Finding, QaPlugin } from "../core/types.js";

function schemathesisCommand(): string[] | null {
  for (const cmd of [["schemathesis"], ["st"], ["uvx", "schemathesis"]]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "--version"], { encoding: "utf8", timeout: 240000 });
    if (r.status === 0) return cmd;
  }
  return null;
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

export function parseJunit(xml: string) {
  const out: Array<{ name: string; message: string; body: string }> = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = decode(m[1].match(/name="([^"]*)"/)?.[1] ?? "unknown");
    const fail = (m[2] ?? "").match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
    if (!fail) continue;
    out.push({ name, message: decode(fail[2].match(/message="([^"]*)"/)?.[1] ?? ""), body: decode(fail[3] ?? "").trim() });
  }
  return out;
}

export const fuzzPlugin: QaPlugin = {
  name: "api-fuzz",
  layer: "api",
  description: "Schemathesis property-based fuzzing from the generated OpenAPI spec",
  needs: ["baseUrl", "openapi"],
  async run(ctx) {
    const cmd = schemathesisCommand();
    if (!cmd) throw new Error("Schemathesis not found. Install with `pip install schemathesis` (or `uv tool install schemathesis`).");
    const auth = ctx.auth!;
    const account = ctx.config.fuzz.account;
    const token = ctx.config.accounts[account] ? await auth.token(account) : undefined;
    const junit = path.join(ctx.outDir, "schemathesis-junit.xml");
    fs.rmSync(junit, { force: true });
    const args = [
      ...cmd.slice(1), "run", ctx.openapiPath!,
      "--url", ctx.config.target.baseUrl!,
      "--checks", "not_a_server_error",
      "--max-examples", String(ctx.config.fuzz.maxExamples),
      "--rate-limit", `${ctx.config.target.requestsPerMinute}/m`,
      "--request-timeout", String(Math.ceil(ctx.config.target.timeoutMs / 1000)),
      "--exclude-path-regex", "/auth/|logout|delete|webhook|kuickpay",
      "--report", "junit", "--report-junit-path", junit,
      "--no-color", "--generation-deterministic", "--seed", "42",
    ];
    if (!ctx.config.allowMutations) args.push("--include-method", "GET");
    else args.push("--exclude-method", "DELETE");
    if (token) args.push("--header", `Authorization: Bearer ${token}`);
    ctx.log.debug(`schemathesis ${args.filter((a) => !a.startsWith("Authorization")).join(" ")}`);
    const res = spawnSync(cmd[0], args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 18 * 60 * 1000 });
    if (!fs.existsSync(junit)) throw new Error(`Schemathesis produced no report (exit ${res.status}): ${(res.stderr || res.stdout).slice(-600)}`);
    const failures = parseJunit(fs.readFileSync(junit, "utf8"));
    const findings: Finding[] = failures.map((f) => {
      const key = f.name.replace(/\{([^}]+)\}/g, ":$1").replace(new RegExp(`^(\\w+)\\s+${ctx.config.backend.apiPrefix.replace(/\//g, "\\/")}`), "$1 ");
      // Schemathesis 4.x writes "- ST101 Server error" in older releases and "- Server error" in newer ones
      const check = (f.body.match(/^- (?:ST\d+ )?([^\n]+)/m)?.[1] ?? f.message) || "server error";
      const apiMsg = f.body.match(/`(\{[\s\S]*?\})`/)?.[1];
      let reason = "";
      try { reason = apiMsg ? JSON.parse(apiMsg).message ?? "" : ""; } catch { /* not JSON */ }
      const curl = f.body.match(/curl [^\n]+/)?.[0]?.replace(/Bearer [A-Za-z0-9._-]+/g, "Bearer $QA_TOKEN");
      return {
        plugin: this.name, severity: "high", category: "regression", target: key,
        title: `Fuzzer: ${check}${reason ? ` (${String(reason).slice(0, 100)})` : ""}`,
        detail: "Schemathesis generated an input that made the route return 5xx. The reproduction below is the minimal failing request.",
        evidence: { curl, log: f.body.slice(0, 1500).replace(/Bearer [A-Za-z0-9._-]+/g, "Bearer $QA_TOKEN") },
      };
    });
    return { findings, stats: { failingOperations: failures.length, account: token ? account : "anonymous" } };
  },
};
