/**
 * Compares environment variables the code reads with the ones .env.example
 * documents. Catches the "code reads DATABASE_URL, deploy sets MONGODB_URI"
 * class of boot failures before they reach a server.
 */
import fs from "node:fs";
import path from "node:path";
import type { Finding, QaPlugin } from "../core/types.js";

const SYNONYMS: Record<string, string> = {
  MONGODB: "DB", MONGO: "DB", DATABASE: "DB", URI: "URL", KEY: "SECRET", EXPIRES: "EXPIRE", EXPIRY: "EXPIRE",
  PHONE: "", PASS: "PASSWORD", PWD: "PASSWORD",
};
/** Tokens too common to prove two names mean the same thing on their own */
const GENERIC = new Set(["SECRET", "URL", "ID", "PASSWORD", "TOKEN", "NAME", "NUMBER", "API", "IN", "EXPIRE"]);
const tokens = (k: string) => new Set(k.split("_").map((t) => SYNONYMS[t] ?? t).filter(Boolean));
const similarity = (a: string, b: string) => {
  const A = tokens(a), B = tokens(b);
  const shared = [...A].filter((x) => B.has(x));
  if (!shared.some((t) => !GENERIC.has(t))) return 0;
  return shared.length / Math.max(1, new Set([...A, ...B]).size);
};

function walk(dir: string, out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

export const envDriftPlugin: QaPlugin = {
  name: "env-drift",
  layer: "static",
  description: "Env vars read by code vs documented in .env.example",
  async run(ctx) {
    const dir = ctx.config.backend.dir;
    const exampleFile = path.join(dir, ctx.config.backend.envExample);
    if (!fs.existsSync(exampleFile)) {
      return [{ plugin: this.name, severity: "medium", category: "config", target: ctx.config.backend.envExample, title: ".env.example is missing" }];
    }
    const documented = new Set(
      fs.readFileSync(exampleFile, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1]).filter((x): x is string => !!x),
    );
    const used = new Map<string, { file: string; line: number }>();
    const required = new Set<string>();
    const srcDir = fs.existsSync(path.join(dir, "src")) ? path.join(dir, "src") : dir;
    for (const f of walk(srcDir)) {
      const text = fs.readFileSync(f, "utf8");
      const lines = text.split("\n");
      lines.forEach((ln, i) => {
        for (const m of ln.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g)) {
          const k = m[1] ?? m[2];
          if (!used.has(k)) used.set(k, { file: path.relative(dir, f).replace(/\\/g, "/"), line: i + 1 });
        }
      });
      // Arrays of required keys, e.g. env.validation.ts → requiredEnvVars = ["DATABASE_URL", ...]
      if (/required/i.test(text) && /env/i.test(path.basename(f))) {
        for (const m of text.matchAll(/["']([A-Z][A-Z0-9_]{2,})["']/g)) required.add(m[1]);
      }
    }
    const ignore = new Set(ctx.config.envDrift.ignoreKeys);
    const undocumented = [...used.keys()].filter((k) => !documented.has(k) && !ignore.has(k));
    const unused = [...documented].filter((k) => !used.has(k) && !ignore.has(k));
    const findings: Finding[] = [];
    const pairedUnused = new Set<string>();

    for (const k of undocumented) {
      const loc = used.get(k)!;
      const best = unused.map((u) => ({ u, s: similarity(k, u) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s >= 0.5) {
        pairedUnused.add(best.u);
        findings.push({
          plugin: this.name, severity: "high", category: "config", target: k,
          title: `Likely env name mismatch: code reads ${k}, .env.example documents ${best.u}`,
          detail: `Anyone who configures a server from .env.example sets ${best.u}, but the code reads ${k}${required.has(k) ? " and refuses to boot without it" : ""}. Rename one side so they match.`,
          evidence: loc,
        });
      } else {
        findings.push({
          plugin: this.name, severity: required.has(k) ? "high" : "medium", category: "config", target: k,
          title: required.has(k) ? `Required env var ${k} is not documented in .env.example` : `Env var ${k} is read by code but not documented in .env.example`,
          evidence: loc,
        });
      }
    }
    for (const k of unused) {
      if (pairedUnused.has(k)) continue;
      findings.push({ plugin: this.name, severity: "low", category: "config", target: k, title: `.env.example documents ${k} but no code reads it` });
    }
    return { findings, stats: { readByCode: used.size, documented: documented.size, required: required.size } };
  },
};
