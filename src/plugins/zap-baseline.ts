/**
 * Passive security scan of the deployed API and dashboards.
 *
 * Engine:
 *  - OWASP ZAP baseline (zap-baseline.py on PATH, or Docker with zap.docker: true):
 *    spiders each target passively and reports its alerts.
 *  - Built-in rules otherwise (no install needed), a few dozen read-only requests:
 *    files that must never be served (.env, .git, backups), error responses that leak
 *    stack traces or database errors, cookies without Secure/HttpOnly/SameSite,
 *    version numbers in Server headers, source maps and missing security headers on
 *    dashboard pages, plain HTTP that doesn't redirect to HTTPS, directory listings.
 *    (API response headers and CORS are covered by health-cors.)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Finding, QaPlugin, Severity } from "../core/types.js";
import type { RunContext } from "../core/context.js";

const PLUGIN = "zap-baseline";

// ── ZAP ──────────────────────────────────────────────────────────────────────
interface ZapAlert { pluginid: string; alert?: string; name?: string; riskcode: string; confidence?: string; desc?: string; solution?: string; cweid?: string; instances?: Array<{ uri: string; method?: string; param?: string; evidence?: string }> }

export function zapCommand(docker: boolean, image: string): string[] | null {
  if (docker) return spawnSync("docker", ["version"], { stdio: "ignore", timeout: 20000 }).status === 0 ? ["docker", "run", "--rm", "-v", "{out}:/zap/wrk:rw", image, "zap-baseline.py"] : null;
  for (const c of ["zap-baseline.py", "zap-baseline"]) {
    if (spawnSync(c, ["-h"], { stdio: "ignore", timeout: 30000 }).error === undefined) return [c];
  }
  return null;
}

const RISK: Record<string, Severity> = { "3": "high", "2": "medium", "1": "low", "0": "info" };
const strip = (html = "") => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** ZAP's JSON report (-J) → findings, one per alert type per site */
export function parseZapReport(json: any, ignore: string[]): Finding[] {
  const out: Finding[] = [];
  for (const site of json?.site ?? []) {
    const host = String(site["@name"] ?? "").replace(/^https?:\/\//, "");
    for (const a of (site.alerts ?? []) as ZapAlert[]) {
      const title = a.alert ?? a.name ?? `ZAP rule ${a.pluginid}`;
      if (ignore.includes(String(a.pluginid)) || ignore.includes(title)) continue;
      const inst = a.instances ?? [];
      out.push({
        plugin: PLUGIN,
        severity: RISK[String(a.riskcode)] ?? "low",
        category: "security",
        target: `${host} ${title}`,
        title: `${title}${inst.length > 1 ? ` (${inst.length} places)` : ""}`,
        detail: [strip(a.desc), a.solution && `Fix: ${strip(a.solution)}`, a.cweid && a.cweid !== "-1" ? `CWE-${a.cweid}` : ""].filter(Boolean).join("\n\n").slice(0, 1500),
        evidence: { url: inst[0]?.uri, log: inst.slice(0, 10).map((i) => `${i.method ?? "GET"} ${i.uri}${i.param ? ` [${i.param}]` : ""}${i.evidence ? ` → ${i.evidence.slice(0, 120)}` : ""}`).join("\n") || undefined },
      });
    }
  }
  return out;
}

function runZap(ctx: RunContext, cmd: string[], targets: string[]): { findings: Finding[]; errors: string[] } {
  const z = ctx.config.zap;
  const dir = path.resolve(ctx.outDir, "zap");
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o777); // the ZAP container runs as its own user and writes the report here
  const findings: Finding[] = [];
  const errors: string[] = [];
  targets.forEach((t, i) => {
    const file = `zap-${i}.json`;
    fs.rmSync(path.join(dir, file), { force: true }); // never read a previous run's report
    const args = cmd.map((c) => c.replace("{out}", dir));
    // -I: don't fail on warnings (we gate ourselves), -m: spider minutes, -J: JSON report
    // the report name is relative to ZAP's working folder (/zap/wrk in Docker, the cwd otherwise)
    const full = [...args.slice(1), "-t", t, "-m", String(z.spiderMinutes), "-I", "-J", file];
    const r = spawnSync(args[0], full, { cwd: dir, encoding: "utf8", timeout: (z.spiderMinutes + 5) * 60_000, maxBuffer: 64 * 1024 * 1024 });
    const report = path.join(dir, file);
    if (!fs.existsSync(report)) { errors.push(`${t}: ZAP wrote no report (exit ${r.status}) ${(r.stderr || r.stdout || "").slice(-300)}`); return; }
    findings.push(...parseZapReport(JSON.parse(fs.readFileSync(report, "utf8")), z.ignore));
  });
  return { findings, errors };
}

// ── Built-in rules ───────────────────────────────────────────────────────────
const SENSITIVE: Array<{ path: string; looks: (body: string) => boolean; title: string; severity: Severity }> = [
  { path: "/.env", looks: (b) => /^[A-Z][A-Z0-9_]{2,}\s*=/m.test(b) && !/<html/i.test(b), title: "Environment file (.env) is publicly readable", severity: "critical" },
  { path: "/.git/HEAD", looks: (b) => /^ref: refs\//.test(b.trim()), title: "Git repository (.git) is publicly readable", severity: "critical" },
  { path: "/.git/config", looks: (b) => /\[core\]/.test(b), title: "Git config (.git/config) is publicly readable", severity: "high" },
  { path: "/package.json", looks: (b) => /"dependencies"\s*:/.test(b), title: "package.json is publicly readable", severity: "low" },
  { path: "/.DS_Store", looks: (b) => b.startsWith("\u0000\u0000\u0000\u0001Bud1"), title: ".DS_Store file is publicly readable", severity: "low" },
  { path: "/backup.sql", looks: (b) => /(CREATE TABLE|INSERT INTO)/i.test(b), title: "Database dump (backup.sql) is publicly readable", severity: "critical" },
  { path: "/.npmrc", looks: (b) => /_authToken|registry=/.test(b), title: ".npmrc (may hold registry tokens) is publicly readable", severity: "high" },
];

const LEAKS: Array<[RegExp, string]> = [
  [/\n\s+at [\w.<>$]+ \(?(\/|[A-Z]:\\|node:|file:)/, "a stack trace"],
  [/node_modules[\\/]/, "server file paths"],
  [/(MongoServerError|CastError: Cast to ObjectId|E11000 duplicate key|MongooseError)/, "MongoDB/Mongoose error details"],
  [/(SequelizeDatabaseError|PrismaClient\w*Error|QueryFailedError|syntax error at or near|ER_PARSE_ERROR|SQLITE_ERROR)/, "SQL error details"],
  [/"stack"\s*:\s*"/, "a stack field"],
];

interface Probe { url: string; status: number; headers: Headers; text: string; error?: string }

async function get(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Probe> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), ...init });
    const buf = Buffer.from(await res.arrayBuffer());
    return { url, status: res.status, headers: res.headers, text: buf.subarray(0, 200_000).toString("latin1") };
  } catch (e) {
    return { url, status: 0, headers: new Headers(), text: "", error: (e as Error).message };
  }
}

export function cookieProblems(setCookie: string[], https: boolean): Array<{ name: string; missing: string[] }> {
  const out: Array<{ name: string; missing: string[] }> = [];
  for (const c of setCookie) {
    const [pair, ...attrs] = c.split(";").map((s) => s.trim());
    const name = pair.split("=")[0];
    const a = attrs.map((x) => x.toLowerCase());
    if (a.some((x) => x.startsWith("max-age=0") || x.startsWith("expires=thu, 01 jan 1970"))) continue; // a deletion
    const missing: string[] = [];
    if (https && !a.includes("secure")) missing.push("Secure");
    if (!a.includes("httponly")) missing.push("HttpOnly");
    if (!a.some((x) => x.startsWith("samesite="))) missing.push("SameSite");
    if (missing.length) out.push({ name, missing });
  }
  return out;
}

async function builtIn(ctx: RunContext): Promise<{ findings: Finding[]; requests: number }> {
  const cfg = ctx.config;
  const findings: Finding[] = [];
  let requests = 0;
  const pause = () => new Promise((r) => setTimeout(r, 60));
  const fetchP = async (url: string, init?: RequestInit) => { requests++; await pause(); return get(url, init, cfg.target.timeoutMs); };
  const add = (severity: Severity, target: string, title: string, url: string, detail?: string, log?: string, status?: number) =>
    findings.push({ plugin: PLUGIN, severity, category: "security", target, title, detail, evidence: { url, status, curl: `curl -i '${url}'`, log } });

  const api = cfg.target.baseUrl;
  const apps = cfg.web.apps.filter((a) => a.baseUrl).map((a) => ({ name: a.name, base: a.baseUrl!, origin: new URL(a.baseUrl!).origin, login: a.loginPath }));
  const origins = [...new Set([...(api ? [new URL(api).origin] : []), ...apps.map((a) => a.origin), ...cfg.zap.extraTargets.map((t) => new URL(t).origin)])];

  // 1. Files that must never be served (on every origin)
  for (const origin of origins) {
    const host = new URL(origin).host;
    const spa = await fetchP(`${origin}/qa-${Date.now().toString(36)}-nonexistent.txt`); // SPAs answer every path with index.html
    for (const f of SENSITIVE) {
      const r = await fetchP(origin + f.path);
      if (r.status !== 200 || !f.looks(r.text)) continue;
      if (spa.status === 200 && r.text === spa.text) continue;
      add(f.severity, `${host} ${f.path}`, f.title, r.url, "Block dotfiles and build files at the web server, remove the file from the deployed folder, and rotate anything secret it contains.", r.text.slice(0, 200), 200);
    }
    // directory listing on common upload/static folders
    for (const d of cfg.zap.listingPaths) {
      const r = await fetchP(origin + d);
      if (r.status === 200 && /<title>Index of \/|Directory listing for \//i.test(r.text)) {
        add("medium", `${host} ${d}`, `Directory listing is on at ${d}`, r.url, "Anyone can browse every file in this folder. Turn off directory indexes.");
      }
    }
    // 2. Plain HTTP must redirect to HTTPS
    if (origin.startsWith("https://")) {
      const plain = await fetchP(origin.replace(/^https:/, "http:") + "/");
      const loc = plain.headers.get("location") ?? "";
      if (!plain.error && plain.status >= 200 && plain.status < 300) {
        add("medium", `${host} http`, "Site is also served over plain HTTP without redirecting to HTTPS", plain.url, "Redirect every http:// request to https:// and keep HSTS on.");
      } else if (plain.status >= 300 && plain.status < 400 && !loc.startsWith("https://")) {
        add("low", `${host} http`, "Plain HTTP redirects somewhere other than HTTPS", plain.url, `Location: ${loc}`);
      }
    }
    // 3. Version numbers in Server headers
    const home = await fetchP(origin + "/");
    const server = home.headers.get("server") ?? "";
    if (/\d+\.\d+/.test(server)) add("low", `${host} header server`, `Server header reveals the version (${server})`, home.url, "Hide the version (nginx: server_tokens off).");
  }

  // 4. Error responses that leak internals (API)
  if (api) {
    const host = new URL(api).host;
    const probes: Array<[string, RequestInit, string]> = [
      [`${api}${cfg.backend.apiPrefix}/qa-nonexistent-${Date.now().toString(36)}`, {}, "unknown route"],
      [`${api}${cfg.login.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"identifier": ' }, "malformed JSON body"],
      [`${api}${cfg.login.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: { $gt: "" }, password: { $gt: "" }, device: "qa" }) }, "operator object in a login field"],
    ];
    const idRoute = ctx.routes.find((r) => r.method === "GET" && /\/:[A-Za-z]*[iI]d$/.test(r.path) && r.authRequired);
    if (idRoute && Object.keys(cfg.accounts).length) {
      const label = ctx.auth?.accountForRoles(idRoute.roles);
      const h = label ? await ctx.auth!.header(label) : undefined;
      if (h) probes.push([`${api}${idRoute.path.replace(/:[A-Za-z0-9_]+$/, "not-a-valid-id")}`, { headers: h }, `malformed id on ${idRoute.method} ${idRoute.apiPath}`]);
    }
    for (const [url, init, what] of probes) {
      const r = await fetchP(url, init);
      const leak = LEAKS.find(([re]) => re.test(r.text));
      if (leak) {
        add("medium", `${host} error ${what}`, `Error response reveals ${leak[1]} (${what})`, r.url,
          "Return a generic message in production and log the details on the server only.", r.text.slice(0, 400), r.status);
      }
    }
    // 5. Cookies the login sets
    const acc = Object.values(cfg.accounts)[0];
    if (acc) {
      const tpl = cfg.login.bodyTemplate ?? { identifier: "{{identifier}}", password: "{{password}}", device: "{{device}}" };
      const body = Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, v.replace("{{identifier}}", acc.identifier ?? "").replace("{{password}}", acc.password ?? "").replace("{{device}}", acc.device ?? "")]));
      const r = await fetchP(`${api}${cfg.login.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      for (const p of cookieProblems(r.headers.getSetCookie(), api.startsWith("https://"))) {
        add(p.missing.includes("HttpOnly") || p.missing.includes("Secure") ? "medium" : "low", `${host} cookie ${p.name}`, `Login cookie "${p.name}" is missing ${p.missing.join(", ")}`, r.url,
          "Session and refresh cookies need Secure (HTTPS only), HttpOnly (no JavaScript access) and SameSite (CSRF protection).");
      }
    }
  }

  // 6. Dashboards: security headers on the HTML, source maps
  for (const app of apps) {
    const host = new URL(app.base).host;
    const page = await fetchP(app.base + app.login);
    if (page.status !== 200) continue;
    const h = page.headers;
    const csp = h.get("content-security-policy") ?? "";
    const missing: string[] = [];
    if (!csp) missing.push("Content-Security-Policy");
    if (!h.get("x-frame-options") && !/frame-ancestors/.test(csp)) missing.push("X-Frame-Options (or CSP frame-ancestors)");
    if ((h.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") missing.push("X-Content-Type-Options: nosniff");
    if (!h.get("referrer-policy")) missing.push("Referrer-Policy");
    if (app.base.startsWith("https://") && !h.get("strict-transport-security")) missing.push("Strict-Transport-Security");
    if (missing.length) {
      add(missing.some((m) => m.startsWith("X-Frame") || m.startsWith("Content-Security")) ? "medium" : "low", `${app.name} headers`,
        `Dashboard "${app.name}" is missing security headers: ${missing.join(", ")}`, page.url,
        "Set them at the host (e.g. Cloudflare Pages _headers, nginx add_header). Without frame protection the dashboard can be framed for clickjacking.");
    }
    const pages = [page];
    const seed = cfg.web.apps.find((a) => a.name === app.name)?.seedRoutes[0];
    if (seed && seed !== app.login) pages.push(await fetchP(app.base + seed));
    const scripts = [...new Set(pages.flatMap((p) => [...p.text.matchAll(/<script[^>]+src=["']([^"']+\.js)["']/gi)].map((m) => new URL(m[1], p.url).href)))].slice(0, 4);
    for (const s of scripts) {
      const m = await fetchP(`${s}.map`);
      if (m.status === 200 && /"sources"\s*:/.test(m.text)) {
        add("low", `${app.name} source maps`, `Dashboard "${app.name}" serves source maps (original source code is public)`, m.url, "Build without public source maps (Vite: build.sourcemap false or 'hidden'), or upload them to your error tracker only.");
        break;
      }
    }
  }
  return { findings, requests };
}

export const zapBaselinePlugin: QaPlugin = {
  name: PLUGIN,
  layer: "security",
  description: "Passive security scan: OWASP ZAP baseline when installed, built-in rules otherwise",
  skipReason(ctx) {
    if (!ctx.config.target.baseUrl && !ctx.config.web.apps.some((a) => a.baseUrl) && !ctx.config.zap.extraTargets.length) return "no target URL or dashboard URL";
    return null;
  },
  async run(ctx) {
    const z = ctx.config.zap;
    const cmd = z.engine === "builtin" ? null : zapCommand(z.docker, z.image);
    if (z.engine === "zap" && !cmd) throw new Error("zap.engine is \"zap\" but zap-baseline.py isn't installed (or Docker isn't available with zap.docker: true)");
    if (cmd) {
      const targets = [...new Set([ctx.config.target.baseUrl, ...ctx.config.web.apps.map((a) => a.baseUrl), ...z.extraTargets].filter((t): t is string => !!t))];
      ctx.log.info(`zap-baseline: OWASP ZAP on ${targets.length} target(s), up to ${z.spiderMinutes} min each`);
      const { findings, errors } = runZap(ctx, cmd, targets);
      if (errors.length && !findings.length) throw new Error(errors.join("; "));
      const stats: Record<string, string | number> = { engine: "zap", targets: targets.length };
      if (errors.length) stats.errors = errors.length;
      return { findings, stats };
    }
    const { findings, requests } = await builtIn(ctx);
    return { findings, stats: { engine: "built-in", requests } };
  },
};
