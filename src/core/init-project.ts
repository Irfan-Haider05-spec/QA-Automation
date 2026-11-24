/**
 * `qa init`: set VeriQ up on any project in one command.
 *
 * With a backend folder (an Express app in TypeScript or JavaScript), it finds the routes
 * index, the app file and the API prefix, runs route discovery to learn the login route and
 * the roles, and writes a starter configuration whose suites only contain checks that are
 * safe on a live system. Without one, it writes an OpenAPI-based starter. It also writes a
 * `.env.qa.example` (names only, never values), keeps `.env.qa` and `qa-out/` out of git,
 * and with `--ci` a GitHub workflow for pull requests. It never overwrites a file.
 */
import fs from "node:fs";
import path from "node:path";
import { discoverRoutes } from "../discovery/express-routes.js";
import { discoverMongoose } from "../discovery/mongoose-models.js";
import { buildOpenApi } from "../discovery/openapi.js";
import type { RouteInfo } from "./types.js";

export interface BackendLayout {
  dir: string;
  routesIndex: string;
  appFile?: string;
  apiPrefix: string;
  modulesDir: string;
  envExample?: string;
  healthPath: string;
}

export interface ProjectSetup {
  project: string;
  /** Absolute backend folder, or undefined for an OpenAPI-only setup */
  backend?: BackendLayout;
  routes: RouteInfo[];
  roles: string[];
  login?: { path: string; identifierField: string };
  /** Routes without auth whose path says they are public by nature (login, health, webhooks…) */
  publicRoutes: string[];
  /** Routes without auth that need a person's decision: listed as comments, so they stay reported */
  reviewRoutes: string[];
  mongooseModels: number;
  openapi?: string;
  warnings: string[];
}

const exists = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));
const first = (dir: string, candidates: string[]) => candidates.find((c) => exists(dir, c));

const ROUTE_INDEX = ["src/app/routes/index.ts", "src/routes/index.ts", "src/app/routes/index.js", "src/routes/index.js", "routes/index.js", "routes/index.ts", "src/routes.ts", "src/routes.js"];
const APP_FILE = ["src/app.ts", "src/app.js", "app.ts", "app.js", "src/server.ts", "src/server.js", "server.js", "src/index.ts", "src/index.js", "index.js"];
const MODULES = ["src/app/modules", "src/modules", "src/routes", "routes", "src"];

/** Where the routes index is mounted, read from `app.use("/api/v1", router)` in the app file. */
function apiPrefixFrom(appSource: string, routesIndex: string): string {
  const importNames = new Set<string>();
  const base = path.basename(routesIndex).replace(/\.(t|j)s$/, "");
  const dirName = path.basename(path.dirname(routesIndex));
  for (const m of appSource.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+)["']/g)) if (m[2].includes(dirName) || m[2].endsWith(base)) importNames.add(m[1]);
  for (const m of appSource.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) if (m[2].includes(dirName) || m[2].endsWith(base)) importNames.add(m[1]);
  const mounts = [...appSource.matchAll(/\.use\(\s*["'`](\/[^"'`]*)["'`]\s*,\s*(?:[\w.]+\s*,\s*)*(\w+)\s*\)/g)];
  const own = mounts.find((m) => importNames.has(m[2]));
  if (own) return own[1].replace(/\/+$/, "");
  const api = mounts.find((m) => /^\/api(\/|$)/.test(m[1]));
  return api ? api[1].replace(/\/+$/, "") : "";
}

export function detectBackend(dir: string): BackendLayout {
  const routesIndex = first(dir, ROUTE_INDEX);
  if (!routesIndex) throw new Error(`No Express routes index found in ${dir} (looked for ${ROUTE_INDEX.join(", ")}). Set backend.routesIndex by hand, or use --openapi.`);
  const appFile = first(dir, APP_FILE);
  const appSource = appFile ? fs.readFileSync(path.join(dir, appFile), "utf8") : "";
  const health = /["'`](\/(?:api\/)?(?:v\d+\/)?health(?:z|check)?)["'`]/.exec(appSource)?.[1];
  return {
    dir, routesIndex, appFile, apiPrefix: appFile ? apiPrefixFrom(appSource, routesIndex) : "",
    modulesDir: first(dir, MODULES) ?? "src",
    envExample: first(dir, [".env.example", ".env.sample", ".env.template"]),
    healthPath: health ?? "/health",
  };
}

const LOGIN = /(^|\/)(auth\/)?(login|signin|sign-in)$/i;
const PUBLIC_BY_NATURE = /(^|\/)(health|healthz|status|ping|login|signin|sign-in|logout|register|signup|sign-up|forgot-password|reset-password|verify[\w-]*|refresh(-token)?|resend[\w-]*|webhooks?|ipn|callback)(\/|$)/i;
const IDENTIFIER_FIELDS = ["identifier", "email", "username", "phone", "login"];

/** Discovery, login route, roles and the login body's identifier field (from its validation schema when known). */
export async function analyseProject(opts: { project: string; backendDir?: string; openapi?: string; workDir: string }): Promise<ProjectSetup> {
  const warnings: string[] = [];
  if (!opts.backendDir) return { project: opts.project, routes: [], roles: [], publicRoutes: [], reviewRoutes: [], mongooseModels: 0, openapi: opts.openapi ?? "./openapi.json", warnings };
  const backend = detectBackend(path.resolve(opts.backendDir));
  const found = discoverRoutes({ backendDir: backend.dir, routesIndex: backend.routesIndex, apiPrefix: backend.apiPrefix, appFile: backend.appFile });
  warnings.push(...found.warnings.slice(0, 10));
  const routes = found.routes;
  if (!routes.length) warnings.push("Route discovery found no routes: check backend.routesIndex and backend.apiPrefix in the generated config.");
  const roles = [...new Set(routes.flatMap((r) => r.roles))].sort();
  const loginRoute = routes.filter((r) => r.method === "POST" && LOGIN.test(r.apiPath)).sort((a, b) => Number(b.apiPath.includes("auth")) - Number(a.apiPath.includes("auth")))[0];
  let identifierField = "email";
  if (loginRoute?.validation) {
    try {
      const out = path.join(opts.workDir, `.veriq-init-${process.pid}.json`);
      const { file } = await buildOpenApi([loginRoute], { title: opts.project, outFile: out });
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.rmSync(file, { force: true });
      const op = doc.paths?.[loginRoute.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")]?.post;
      const props = Object.keys(op?.requestBody?.content?.["application/json"]?.schema?.properties ?? {});
      identifierField = IDENTIFIER_FIELDS.find((f) => props.includes(f)) ?? identifierField;
    } catch { warnings.push("Could not read the login route's validation schema; the login body uses `email`."); }
  }
  if (loginRoute && !loginRoute.validation) {
    // No schema: read the fields the handler takes from req.body in the route's own file.
    try {
      const src = fs.readFileSync(path.resolve(backend.dir, loginRoute.source.file), "utf8");
      const fields = new Set<string>();
      for (const m of src.matchAll(/\{([^{}]*)\}\s*=\s*req\.body/g)) for (const f of m[1].split(",")) fields.add(f.trim().split(/[\s:=]/)[0]);
      for (const m of src.matchAll(/req\.body\??\.(\w+)/g)) fields.add(m[1]);
      identifierField = IDENTIFIER_FIELDS.find((f) => fields.has(f)) ?? identifierField;
    } catch { /* keep the default */ }
  }
  if (!loginRoute) warnings.push("No POST …/login route was found: set login.path in the generated config.");
  // Only routes that are public by nature are accepted. Every other route without auth (an
  // export, an admin action) stays reported until a person decides: accepting it here would
  // hide exactly the findings VeriQ exists to show.
  const open = routes.filter((r) => !r.authRequired);
  const publicRoutes = open.filter((r) => PUBLIC_BY_NATURE.test(r.apiPath) || r.apiPath === "/").map((r) => `${r.method} ${r.apiPath}`);
  const reviewRoutes = open.map((r) => `${r.method} ${r.apiPath}`).filter((r) => !publicRoutes.includes(r));
  let mongooseModels = 0;
  try { mongooseModels = discoverMongoose(backend.dir).models.length; } catch { /* not a Mongoose project */ }
  return { project: opts.project, backend, routes, roles, login: loginRoute ? { path: loginRoute.path, identifierField } : undefined, publicRoutes, reviewRoutes, mongooseModels, warnings };
}

const accountName = (role: string) => role.toLowerCase().replace(/[^a-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""));
const envName = (role: string) => role.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
const q = (s: string) => JSON.stringify(s);

/** The accounts the configuration and .env.qa.example list: one per discovered role, or one generic user. */
export function accountsFor(setup: ProjectSetup) {
  const roles = setup.roles.length ? setup.roles : ["USER"];
  return roles.map((role) => ({ name: accountName(role) || "user", role, idEnv: `QA_${envName(role)}_ID`, passEnv: `QA_${envName(role)}_PASS` }));
}

export function configSource(setup: ProjectSetup, configFile: string): string {
  const accounts = accountsFor(setup);
  const lines: string[] = [];
  lines.push(`/**`, ` * VeriQ configuration for ${setup.project}, written by \`qa init\`. Review every value marked CHECK.`, ` * Secrets never go in this file: they come from environment variables (.env.qa locally,`, ` * repository secrets in CI). See .env.qa.example for the names.`, ` */`);
  lines.push(`const env = (k: string) => process.env[k] || undefined;`, ``, `export default {`, `  project: ${q(setup.project)},`);
  if (setup.backend) {
    const b = setup.backend;
    const rel = path.relative(path.dirname(path.resolve(configFile)), b.dir).split(path.sep).join("/") || ".";
    lines.push(`  backend: {`, `    dir: ${q(rel)},`, `    routesIndex: ${q(b.routesIndex)},`);
    if (b.appFile) lines.push(`    appFile: ${q(b.appFile)},`);
    lines.push(`    apiPrefix: ${q(b.apiPrefix)}, // CHECK: where the routes index is mounted`, `    healthPath: ${q(b.healthPath)},`, `    envExample: ${q(b.envExample ?? ".env.example")},`, `    modulesDir: ${q(b.modulesDir)},`, `  },`);
  } else {
    lines.push(`  backend: false,`, `  discovery: { format: "openapi", file: ${q(setup.openapi ?? "./openapi.json")} }, // or { format: "postman", file: "collection.json" }`);
  }
  lines.push(`  target: { baseUrl: env("QA_BASE_URL"), requestsPerMinute: 60, timeoutMs: 15000, slowMs: 2000 },`);
  const loginPath = setup.login?.path ?? `${setup.backend?.apiPrefix ?? ""}/auth/login`;
  const idField = setup.login?.identifierField ?? "email";
  lines.push(`  // CHECK: the login request and where its response holds the token`, `  login: { path: ${q(loginPath)}, tokenPath: "data.accessToken", bodyTemplate: { ${idField}: "{{identifier}}", password: "{{password}}" } },`);
  lines.push(`  // Dedicated QA accounts only, never real users. One per role found on the routes.`, `  accounts: {`);
  for (const a of accounts) lines.push(`    ${a.name}: { identifier: env(${q(a.idEnv)}), password: env(${q(a.passEnv)}), role: ${q(a.role)}, device: "web" },`);
  lines.push(`  },`);
  lines.push(`  // Routes meant to work without a token. Only routes that are public by nature (login,`, `  // health, webhooks…) are listed; any other route without auth is reported until you decide.`, `  publicRoutes: [`);
  for (const r of setup.publicRoutes.slice(0, 200)) lines.push(`    ${q(r)},`);
  if (setup.reviewRoutes.length) {
    lines.push(`    // CHECK: found WITHOUT auth middleware. Add auth to the route, or uncomment it here if it is meant to be public:`);
    for (const r of setup.reviewRoutes.slice(0, 200)) lines.push(`    // ${q(r)},`);
  }
  lines.push(`  ],`, `  privilegedPrefixes: ["/admin"], // CHECK: path prefixes only staff may use`);
  lines.push(`  cors: { allowedOrigins: (env("QA_CORS_ORIGINS") ?? "").split(",").filter(Boolean) },`);
  lines.push(`  // Writes only on a throwaway environment: both must be true, never on shared staging.`, `  allowMutations: env("QA_ALLOW_MUTATIONS") === "true",`, `  disposable: env("QA_DISPOSABLE") === "true",`);
  const staticChecks = setup.backend ? ["route-auth", "env-drift", "secrets", "deps", "validation-coverage", ...(setup.mongooseModels ? ["mongo-indexes"] : []), "log-hygiene"] : [];
  const liveChecks = ["health-cors", "api-auth", "api-smoke"];
  lines.push(`  suites: {`, `    // Pull requests: reads the source only, no running backend needed`, `    pr: ${JSON.stringify(staticChecks.length ? staticChecks : liveChecks)},`, `    // After a deploy: read-only requests with the QA accounts`, `    staging: ${JSON.stringify(liveChecks)},`, `    nightly: ${JSON.stringify([...new Set([...staticChecks, ...liveChecks, "load-smoke"])])},`, `    local: ${JSON.stringify([...new Set([...staticChecks, ...liveChecks])])},`, `  },`);
  // Checks that only run when they have an entry here; {} means their defaults.
  const enabled = staticChecks.filter((c) => c === "mongo-indexes" || c === "log-hygiene");
  lines.push(`  gate: { failOn: "high" },`, `  pluginSettings: { ${enabled.map((c) => `${q(c)}: {}`).join(", ")} },`, `  // Accepted findings (the baseline): qa run --suite pr --baseline`, `  knownIssuesFile: "qa-known-issues.json",`, `};`, ``);
  return lines.join("\n");
}

export function envExampleSource(setup: ProjectSetup): string {
  const lines = [
    `# VeriQ for ${setup.project}: copy to .env.qa (never commit .env.qa) and fill in.`,
    `# In CI, set the same names as repository secrets instead.`,
    ``,
    `# The running backend to test live (empty: only the source checks run)`,
    `QA_BASE_URL=`,
    `# Dashboard origins the API should allow, comma-separated`,
    `QA_CORS_ORIGINS=`,
    ``,
    `# Dedicated QA accounts (never real users)`,
  ];
  for (const a of accountsFor(setup)) lines.push(`${a.idEnv}=`, `${a.passEnv}=`);
  lines.push(``, `# Optional: the VeriQ platform (runs appear in the dashboard)`, `# QA_PLATFORM_URL=`, `# QA_PLATFORM_API_KEY=`, ``);
  return lines.join("\n");
}

export function workflowSource(setup: ProjectSetup, opts: { configPath: string; action: string }): string {
  const placeholder = opts.action.startsWith("YOUR-ORG/");
  return [
    `# VeriQ checks on every pull request (written by \`qa init --ci\`).`,
    `# Reads the source only: no running backend or secrets are needed.`,
    ...(placeholder ? [`# CHECK: replace YOUR-ORG/qa-agent@v1 with the repository and tag of your VeriQ copy.`] : []),
    `name: VeriQ`,
    `on:`,
    `  pull_request:`,
    ``,
    `permissions:`,
    `  contents: read`,
    `  pull-requests: write`,
    `  statuses: write`,
    ``,
    `jobs:`,
    `  pr:`,
    `    runs-on: ubuntu-latest`,
    `    timeout-minutes: 15`,
    `    steps:`,
    `      - uses: actions/checkout@v4`,
    `        with:`,
    `          fetch-depth: 0`,
    `      - uses: ${opts.action}`,
    `        with:`,
    `          suite: pr`,
    `          config: ${opts.configPath}`,
    `          changed-from: origin/\${{ github.base_ref }}`,
    ``,
  ].join("\n");
}

export interface InitResult { written: string[]; skipped: string[]; gitignore?: string[] }

/** Writes the files; existing ones are left alone and reported as skipped. */
export function writeProjectFiles(setup: ProjectSetup, opts: { configFile: string; workDir: string; ci: boolean; action: string }): InitResult {
  const result: InitResult = { written: [], skipped: [] };
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, text, { flag: "wx" }); result.written.push(file); }
    catch (e: any) { if (e?.code === "EEXIST") result.skipped.push(file); else throw e; }
  };
  const configFile = path.resolve(opts.workDir, opts.configFile);
  if (fs.existsSync(configFile)) throw new Error(`${configFile} already exists; init never overwrites a configuration`);
  write(configFile, configSource(setup, configFile));
  write(path.join(opts.workDir, ".env.qa.example"), envExampleSource(setup));
  if (opts.ci) {
    const configPath = path.relative(opts.workDir, configFile).split(path.sep).join("/");
    write(path.join(opts.workDir, ".github", "workflows", "veriq.yml"), workflowSource(setup, { configPath, action: opts.action }));
  }
  // Keep local secrets and reports out of git.
  const gitignore = path.join(opts.workDir, ".gitignore");
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = [".env.qa", "qa-out/"].filter((l) => !have.has(l) && !have.has(`/${l}`));
  if (missing.length) {
    const eol = current.includes("\r\n") ? "\r\n" : "\n";
    fs.writeFileSync(gitignore, `${current}${current && !current.endsWith("\n") ? eol : ""}# VeriQ: local secrets and reports${eol}${missing.join(eol)}${eol}`);
    result.gitignore = missing;
  }
  return result;
}
