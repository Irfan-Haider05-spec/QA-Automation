import fs from "node:fs";
import type { RunContext } from "../../core/context.js";
import { SkipError, type Finding, type QaPlugin, type RouteInfo } from "../../core/types.js";
import { apiScenariosSchema, loadScenarios, type Scenario } from "./api-scenarios.js";
import { configured, settings } from "./support.js";

/**
 * Static check of API scenario files against the backend's discovered routes, run without a
 * target (pull requests). It finds the scenario mistakes that would otherwise surface only
 * on staging as confusing failures: a path or method the backend does not have, a step that
 * expects success from a route its account may not call, an account that is not configured,
 * a body missing fields the route's validation requires, and a {{variable}} used before
 * anything defines it. Expectations of refusal (401/403/404) are never questioned: a scenario
 * that expects a protected route to refuse is exactly how a missing check is caught live.
 */

const BUILT_IN = new Set(["unique", "uniqueDigits", "now", "today"]);
const TEMPLATE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

export interface LintProblem { file: string; scenario: string; step: string; message: string }
export interface LintInput {
  routes: RouteInfo[];
  /** Account name → role, from the configuration */
  accounts: Record<string, string | undefined>;
  /** JSON Schema of each route's JSON body, keyed by `METHOD /full/path/:param` */
  bodySchemas?: Map<string, any>;
}

const segments = (p: string) => p.split("?")[0].split("/").filter(Boolean);

/** A scenario segment with templates, as a pattern: `{{id}}` or `v-{{n}}` can become any text there. */
const TEMPLATE_SPLIT = /\{\{\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}\}/;
const segmentPattern = (segment: string) =>
  new RegExp(`^${segment.split(TEMPLATE_SPLIT).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+")}$`);

/**
 * How well a route fits: an exact segment counts most, a template on a `:param` next (an id
 * saved from a response fills a parameter), a template that could only equal a literal
 * segment (`{{id}}` against `/search`) least.
 */
function score(want: string[], have: string[]): number | undefined {
  if (have.length !== want.length) return undefined;
  let total = 0;
  for (let i = 0; i < have.length; i++) {
    const templated = want[i].includes("{{");
    if (have[i].startsWith(":")) { total += templated ? 1 : 0; continue; }
    if (templated) { if (!segmentPattern(want[i]).test(have[i])) return undefined; continue; }
    if (have[i] !== want[i]) return undefined;
    total += 2;
  }
  return total;
}

/**
 * The most specific route a scenario path can reach: a template matches any value, `:param`
 * any segment. The path may be the full mounted path or relative to the API prefix (when
 * the target URL already ends with the prefix).
 */
export function matchRoute(method: string, scenarioPath: string, routes: RouteInfo[]): RouteInfo | undefined {
  const want = segments(scenarioPath);
  let best: { route: RouteInfo; literal: number } | undefined;
  for (const route of routes) {
    if (route.method !== method) continue;
    const literal = score(want, segments(route.path)) ?? score(want, segments(route.apiPath));
    if (literal !== undefined && (!best || literal > best.literal)) best = { route, literal };
  }
  return best?.route;
}

const expectsSuccess = (status: number | number[] | undefined) =>
  status === undefined || (Array.isArray(status) ? status : [status]).every((s) => s >= 200 && s < 300);

function templatesIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32) return out;
  if (typeof value === "string") for (const m of value.matchAll(TEMPLATE)) out.push(m[1]);
  else if (Array.isArray(value)) for (const v of value) templatesIn(v, out, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) templatesIn(v, out, depth + 1);
  return out;
}

export function lintScenarios(scenarios: Scenario[], input: LintInput): LintProblem[] {
  const problems: LintProblem[] = [];
  for (const s of scenarios) {
    const defined = new Set([...BUILT_IN, ...Object.keys(s.vars)]);
    const phases: [string, typeof s.steps][] = [["step", s.steps], ["cleanup", s.cleanup]];
    for (const [phase, steps] of phases) {
      for (const [i, st] of steps.entries()) {
        const label = `${phase} ${i + 1}${st.name ? ` "${st.name}"` : ""}`;
        const add = (message: string) => problems.push({ file: s.file, scenario: s.name, step: label, message });
        // Steps run in order, then cleanup, so cleanup may use anything a step saved (a failed
        // step leaves it unset and the runner skips that cleanup step).
        for (const name of new Set(templatesIn([st.request, st.db, st.expect]))) {
          if (name.startsWith("env.")) continue;
          if (!defined.has(name)) add(`uses {{${name}}}, which no earlier step saves and the scenario's vars do not define`);
        }
        if (st.request) {
          const account = st.account === null ? null : st.account ?? s.account ?? null;
          if (account !== null && !Object.hasOwn(input.accounts, account)) add(`uses account "${account}", which is not in the configuration's accounts`);
          const route = matchRoute(st.request.method, st.request.path, input.routes);
          if (!route) {
            const sameMethod = input.routes.filter((r) => matchRoute(r.method, st.request!.path, [r]) !== undefined).map((r) => r.method);
            add(`calls ${st.request.method} ${st.request.path}, which the backend does not define${sameMethod.length ? ` (that path exists for ${[...new Set(sameMethod)].join(", ")})` : ""}`);
          } else if (expectsSuccess(st.expect?.status)) {
            const role = account ? input.accounts[account] : undefined;
            if (route.authRequired && account === null) add(`expects success from ${route.method} ${route.apiPath} without an account, but the route requires authentication (${route.source.file}:${route.source.line})`);
            else if (route.authRequired && role && route.roles.length && !route.roles.includes(role)) {
              add(`expects success as ${account} (role ${role}), but ${route.method} ${route.apiPath} allows only ${route.roles.join(", ")} (${route.source.file}:${route.source.line})`);
            }
            const schema = input.bodySchemas?.get(`${route.method} ${route.path}`);
            const body = st.request.json;
            if (schema && body && typeof body === "object" && !Array.isArray(body)) {
              const keys = Object.keys(body);
              const missing = (Array.isArray(schema.required) ? schema.required : []).filter((k: string) => !keys.includes(k));
              if (missing.length) add(`sends a body without ${missing.join(", ")}, which the route's validation (${route.validation?.exportName ?? "schema"}) requires`);
              // Extra fields are not reported: a zod object strips unknown keys unless it is
              // strict, and the generated schema cannot tell the two apart.
            }
          }
        }
        for (const name of Object.keys(st.save ?? {})) defined.add(name);
      }
    }
  }
  return problems;
}

/** Body schemas from the OpenAPI document VeriQ generates from the routes' zod validation. */
export function bodySchemasFrom(openapiPath: string | undefined, routes: RouteInfo[]): Map<string, any> {
  const out = new Map<string, any>();
  if (!openapiPath || !fs.existsSync(openapiPath)) return out;
  let doc: any;
  try { doc = JSON.parse(fs.readFileSync(openapiPath, "utf8")); } catch { return out; }
  for (const r of routes) {
    if (!r.validation) continue;
    const op = doc?.paths?.[r.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")]?.[r.method.toLowerCase()];
    const schema = op?.requestBody?.content?.["application/json"]?.schema;
    if (schema && op.requestBody.required) out.set(`${r.method} ${r.path}`, schema);
  }
  return out;
}

export const scenarioLintPlugin: QaPlugin = {
  name: "scenario-lint", apiVersion: 1, layer: "static", needs: [],
  description: "Checks API scenario files against the backend's discovered routes without a target: unknown paths, accounts and variables, success expected from routes the account may not call, missing required body fields",
  skipReason: (ctx) => configured(ctx, "api-scenarios"),
  usesTarget: () => false,
  async run(ctx: RunContext) {
    const c = settings(ctx, "api-scenarios", apiScenariosSchema);
    if (!ctx.routes.length) throw new SkipError("No backend routes were discovered, so scenario paths cannot be checked (configure backend.dir or import routes)");
    const scenarios = loadScenarios(ctx.configDir, Array.isArray(c.files) ? c.files : [c.files], c.database?.type);
    const accounts = Object.fromEntries(Object.entries(ctx.config.accounts ?? {}).map(([name, a]) => [name, (a as { role?: string }).role]));
    const problems = lintScenarios(scenarios, { routes: ctx.routes, accounts, bodySchemas: bodySchemasFrom(ctx.openapiPath, ctx.routes) });
    const findings: Finding[] = problems.map((p) => ({
      plugin: "scenario-lint", severity: "medium", category: "config", confidence: "high",
      title: "Scenario does not match the backend", target: `${p.file} › ${p.scenario} › ${p.step}`, key: `${p.file}|${p.scenario}|${p.step}|${p.message}`,
      detail: `The ${p.step} of scenario "${p.scenario}" ${p.message}.`,
      remediation: "Correct the scenario, or the route if the scenario describes the intended behaviour. Live runs report the same step as a failure that is harder to read.",
    }));
    const steps = scenarios.reduce((n, s) => n + s.steps.length + s.cleanup.length, 0);
    return { findings, stats: { scenarios: scenarios.length, steps, routes: ctx.routes.length, problems: problems.length } };
  },
};
