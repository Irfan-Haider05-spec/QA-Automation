/**
 * Secret scanning of tracked files. Uses gitleaks when it is installed,
 * otherwise a built-in rule set. Matches are redacted in the report.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import picomatch from "picomatch";
import type { Finding, QaPlugin, Severity } from "../core/types.js";

interface Rule { id: string; re: RegExp; severity: Severity; title: string }

const RULES: Rule[] = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, severity: "critical", title: "Private key committed" },
  { id: "aws-access-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, severity: "critical", title: "AWS access key id committed" },
  { id: "stripe-live", re: /\b(sk|rk)_live_[0-9a-zA-Z]{16,}/, severity: "critical", title: "Stripe live secret key committed" },
  { id: "stripe-test", re: /\b(sk|rk)_test_[0-9a-zA-Z]{16,}/, severity: "high", title: "Stripe test secret key committed" },
  { id: "mongo-uri-creds", re: /mongodb(?:\+srv)?:\/\/[^\s:'"`<>/]+:[^\s@'"`<>]{3,}@[^\s'"`]+/, severity: "critical", title: "MongoDB connection string with credentials committed" },
  { id: "redis-uri-creds", re: /rediss?:\/\/[^\s:'"`<>/]*:[^\s@'"`<>]{6,}@[^\s'"`]+/, severity: "high", title: "Redis URL with password committed" },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/, severity: "high", title: "Google API key committed" },
  { id: "twilio-key", re: /\bSK[0-9a-fA-F]{32}\b/, severity: "high", title: "Twilio API key committed" },
  { id: "jwt-literal", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, severity: "medium", title: "Hard-coded JWT found" },
  { id: "generic-secret", re: /\b(?:secret|password|passwd|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[:=]\s*['"`]([^'"`\s]{12,})['"`]/i, severity: "high", title: "Hard-coded secret value" },
];

const PLACEHOLDER = /your[_-]|change[_-]?me|example|placeholder|xxxx|<[^>]+>|\$\{|\{\{[^}]+\}\}|process\.env|dummy|sample|test_secret|temporary_secret|not[_-]?set/i;

const redact = (s: string) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`);

function trackedFiles(dir: string): string[] {
  try {
    return execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (["node_modules", ".git", "dist"].includes(e.name)) continue;
        const p = path.join(d, e.name);
        e.isDirectory() ? walk(p) : out.push(path.relative(dir, p));
      }
    };
    walk(dir);
    return out;
  }
}

export const secretsPlugin: QaPlugin = {
  name: "secrets",
  layer: "static",
  description: "Committed credentials and .env files",
  async run(ctx) {
    const dir = ctx.config.backend.dir;
    const ignore = picomatch(["**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/*.min.js", "**/.env.example", ...ctx.config.secrets.ignorePaths], { dot: true });
    const files = trackedFiles(dir).filter((f) => !ignore(f));
    const findings: Finding[] = [];

    for (const f of files) {
      const base = path.basename(f);
      if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base)) {
        findings.push({ plugin: this.name, severity: "critical", category: "security", target: f, title: "Environment file is committed to git", detail: "Remove it from the repo, add it to .gitignore and rotate every value in it.", evidence: { file: f } });
      }
    }

    let usedGitleaks = false;
    const gl = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
    if (gl.status === 0) {
      usedGitleaks = true;
      const report = path.join(os.tmpdir(), `gitleaks-${process.pid}.json`);
      spawnSync("gitleaks", ["detect", "--no-git", "--redact", "-s", dir, "-f", "json", "-r", report, "--exit-code", "0"], { encoding: "utf8" });
      if (fs.existsSync(report)) {
        for (const l of JSON.parse(fs.readFileSync(report, "utf8") || "[]")) {
          const rel = path.relative(dir, path.resolve(dir, l.File)).replace(/\\/g, "/");
          if (ignore(rel)) continue;
          findings.push({ plugin: this.name, severity: "high", category: "security", target: `${rel}:${l.StartLine}`, title: `Secret found by gitleaks (${l.RuleID})`, evidence: { file: rel, line: l.StartLine, log: l.Match } });
        }
      }
    } else {
      for (const f of files) {
        const abs = path.join(dir, f);
        let st: fs.Stats;
        try { st = fs.statSync(abs); } catch { continue; }
        if (!st.isFile() || st.size > 1_000_000) continue;
        const buf = fs.readFileSync(abs);
        if (buf.includes(0)) continue; // binary
        const lines = buf.toString("utf8").split("\n");
        lines.forEach((ln, i) => {
          for (const rule of RULES) {
            const m = ln.match(rule.re);
            if (!m) continue;
            const value = m[1] && rule.id === "generic-secret" ? m[1] : m[0];
            if (PLACEHOLDER.test(value) || PLACEHOLDER.test(ln.slice(Math.max(0, (m.index ?? 0) - 20), (m.index ?? 0) + m[0].length + 20)) && rule.id === "generic-secret") continue;
            findings.push({
              plugin: this.name, severity: rule.severity, category: "security", target: `${f}:${i + 1}`,
              title: rule.title, detail: `Rule ${rule.id}. Rotate the value, then remove it from code and git history.`,
              evidence: { file: f, line: i + 1, log: redact(value) },
            });
            break;
          }
        });
      }
    }
    return { findings, stats: { filesScanned: files.length, engine: usedGitleaks ? "gitleaks" : "built-in rules" } };
  },
};
