import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { readDocument, resolveRef, importOpenApi } from "../../discovery/import.js";
import { SkipError, type Finding, type QaPlugin } from "../../core/types.js";
import { checkedPlugin, issue, readJson } from "./support.js";
import { executeProjectTests } from "../../core/external-test.js";
import { readJUnitFile } from "../../core/junit.js";
import { inputRestrictions, responseGuarantees, typesIncluded, validateComparisonSchema } from "./contract-schema.js";

export const validationCoverage: QaPlugin = {
  name: "validation-coverage", layer: "static", description: "Write routes without a discovered validation middleware or declared request schema",
  async run(ctx) {
    const routes = ctx.targetRoutes.filter((r) => ["POST", "PUT", "PATCH"].includes(r.method));
    if (!routes.length) throw new SkipError("No write routes in the selected inventory");
    return routes.filter((r) => !r.validation && !r.middlewares.some((m) => /validat|schema|zod|joi/i.test(m))).map((r) => ({
      ...issue(this.name, "No request validation discovered", `${r.method} ${r.apiPath}`, "Static discovery cannot prove handler-level validation. Review the route before treating this as a confirmed vulnerability.", "medium", "quality", "CWE-20"),
      confidence: "medium" as const, evidence: { file: r.source.file, line: r.source.line },
    }));
  },
};

/** Compare response properties conservatively. Composition is not flattened: an
 * unsupported schema fails the check rather than silently claiming compatibility. */
function removedProperties(baseDoc: any, headDoc: any, old: any, next: any, prefix: string, depth = 0): string[] {
  if (depth > 25) throw new Error("Contract schema recursion limit exceeded");
  old = resolveRef(baseDoc, old); next = resolveRef(headDoc, next);
  validateComparisonSchema(old); validateComparisonSchema(next);
  if (!old) return [];
  if ([old, next].some((s) => s && ["oneOf", "anyOf", "allOf"].some((k) => k in s))) throw new Error("Contract composition requires a bundled/flattened comparison schema");
  if (!next) return [prefix];
  const removed: string[] = [];
  if (!typesIncluded(next, old)) removed.push(`${prefix} (type changed)`);
  removed.push(...responseGuarantees(old, next, prefix));
  for (const [name, prop] of Object.entries(old.properties ?? {})) removed.push(...removedProperties(baseDoc, headDoc, prop, next.properties?.[name], `${prefix}.${name}`, depth + 1));
  if (old.items) removed.push(...removedProperties(baseDoc, headDoc, old.items, next.items, `${prefix}[]`, depth + 1));
  return removed;
}
export const apiContract = checkedPlugin("api-contract", "static", "Compare OpenAPI routes, required inputs and response properties against an explicit baseline",
  z.object({ baseline: z.string().min(1), current: z.string().min(1) }).strict(), async (ctx, c) => {
    const base = readDocument(path.resolve(ctx.configDir, c.baseline)), head = readDocument(path.resolve(ctx.configDir, c.current));
    importOpenApi(base); importOpenApi(head);
    const findings: Finding[] = [];
    for (const [p, item] of Object.entries(base.paths)) for (const method of ["get", "post", "put", "patch", "delete"]) {
      const old = resolveRef(base, resolveRef(base, item)?.[method]);
      if (!old) continue;
      const next = resolveRef(head, resolveRef(head, head.paths[p])?.[method]);
      const target = `${method.toUpperCase()} ${p}`;
      // One operation can break in several ways under one title (two new required parameters,
      // two removed responses); the exact title and detail keep each one a separate finding.
      const breaking = (title: string, detail: string) => findings.push({ ...issue("api-contract", title, target, detail, "high", "regression"), key: `${title}|${detail}` });
      if (!next) { breaking("API operation removed", "A baseline operation no longer exists."); continue; }
      const oldBody = resolveRef(base, old.requestBody), newBody = resolveRef(head, next.requestBody);
      if (newBody?.required && !oldBody?.required) breaking("Request body became required", "Previously valid requests without a body may fail.");
      const parameters = (doc: any, item: any, operation: any) => [...new Map([...(resolveRef(doc, item)?.parameters ?? []), ...(operation.parameters ?? [])].map(v => { const param = resolveRef(doc, v); return [`${param.in}:${param.name}`, param] as const; })).values()];
      const oldParams = parameters(base, item, old);
      const newParams = parameters(head, head.paths[p], next);
      for (const param of newParams) if (param.required && !oldParams.some((v) => v.in === param.in && v.name === param.name && v.required)) breaking("New required parameter", `${param.in}: ${param.name}`);
      for (const param of oldParams) {
        const current = newParams.find(v => v.in === param.in && v.name === param.name);
        if (current) { const narrowed = inputRestrictions(base, head, param.schema, current.schema, `${param.in}:${param.name}`); if (narrowed.length) breaking('Parameter schema became more restrictive', narrowed.slice(0, 50).join(', ')); }
      }
      const nextBody = resolveRef(head, next.requestBody);
      for (const [mime, media] of Object.entries(oldBody?.content ?? {})) {
        if (!nextBody?.content?.[mime]) { breaking('Request media type removed', mime); continue; }
        const narrowed = inputRestrictions(base, head, (media as any).schema, nextBody.content[mime].schema, `request ${mime}`);
        if (narrowed.length) breaking('Request schema became more restrictive', narrowed.slice(0, 50).join(', '));
      }
      for (const [code, response] of Object.entries(old.responses ?? {})) {
        if (!/^2\d\d$/.test(code)) continue;
        const oldResponse = resolveRef(base, response), newResponse = resolveRef(head, next.responses?.[code]);
        if (!newResponse) { breaking(`Response ${code} removed`, "Successful response contract changed."); continue; }
        for (const [mime, media] of Object.entries(oldResponse.content ?? {})) {
          if (!newResponse.content?.[mime]) { breaking('Response media type removed', `${code} ${mime}`); continue; }
          const removed = removedProperties(base, head, (media as any).schema, newResponse.content?.[mime]?.schema, `${code} ${mime}`);
          if (removed.length) breaking("Response fields removed or changed", removed.slice(0, 50).join(", "));
        }
      }
    }
    return findings;
  });

export const bundleBudget = checkedPlugin("bundle-budget", "static", "Bounded JavaScript bundle size and gzip growth budgets",
  z.object({ directory: z.string(), maxBytes: z.number().int().positive(), maxGzipBytes: z.number().int().positive(), baselineGzipBytes: z.number().int().nonnegative().optional(), maxGrowthPercent: z.number().nonnegative().default(10) }).strict(),
  async (ctx, c) => {
    const root = path.resolve(ctx.configDir, c.directory); let bytes = 0, gzipBytes = 0, files = 0;
    const visit = (dir: string, depth: number) => {
      if (depth > 30) throw new Error("Bundle nesting limit exceeded");
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("Bundle tree must not contain symlinks");
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(file, depth + 1);
        else if (/\.(m?js)$/.test(entry.name)) {
          const size = fs.statSync(file).size;
          if (size > 50 * 1024 * 1024 || ++files > 10000) throw new Error("Bundle inspection size limit exceeded");
          const data = fs.readFileSync(file); bytes += size; gzipBytes += gzipSync(data).length;
        }
      }
    };
    visit(root, 0);
    if (!files) throw new Error("No JavaScript bundles found; build the project first");
    const findings: Finding[] = [];
    if (bytes > c.maxBytes || gzipBytes > c.maxGzipBytes) findings.push(issue("bundle-budget", "JavaScript bundle budget exceeded", c.directory, `${bytes} raw bytes; ${gzipBytes} gzip bytes.`, "high", "performance"));
    if (c.baselineGzipBytes !== undefined && gzipBytes > c.baselineGzipBytes * (1 + c.maxGrowthPercent / 100)) findings.push(issue("bundle-budget", "JavaScript bundle growth exceeded", c.directory, `Baseline ${c.baselineGzipBytes}; current ${gzipBytes} gzip bytes.`, "high", "performance"));
    return { findings, stats: { files, bytes, gzipBytes } };
  });

export const testResults = checkedPlugin("test-results", "static", "Import or explicitly execute local project tests and verify fresh JUnit/coverage results",
  z.object({ junit: z.string(), coverage: z.string().optional(), execution: z.object({ command: z.string().min(1).max(4096), args: z.array(z.string().max(8192)).max(100), timeoutMs: z.number().int().min(100).max(3600000).default(120000) }).strict().optional(), minLinePercent: z.number().min(0).max(100).default(0), baselineLinePercent: z.number().min(0).max(100).optional(), maxDrop: z.number().min(0).max(100).default(0) }).strict(),
  async (ctx, c) => {
    let exitCode = 0;
    if (c.execution) {
      const result = await executeProjectTests({ ...c.execution, cwd: ctx.configDir, outDir: ctx.outDir, coverage: !!c.coverage });
      c.junit = result.junit; if (c.coverage) c.coverage = result.coverage;
      exitCode = result.exitCode;
    }
    const findings: Finding[] = []; let failures = 0, flaky = 0;
    const cases = readJUnitFile(path.resolve(ctx.configDir, c.junit));
    const tests = cases.length;
    for (const t of cases) {
      if (t.outcome === "failed") { failures++; findings.push({ ...issue("test-results", "Project test failed", t.name, "See the original JUnit report; captured output omitted to prevent credential disclosure.", "high", "regression"), key: t.name }); }
      else if (t.retried) { flaky++; findings.push({ ...issue("test-results", "Project test passed after retry", t.name, "JUnit retry history records a transient failure.", "medium", "quality"), key: t.name, flaky: true }); }
    }
    if (!tests) throw new Error("JUnit report contains no test cases");
    if (exitCode !== 0 && failures === 0) throw new Error("Project test process failed but JUnit reports no failures; refusing a false pass");
    if (c.coverage) {
      const coverage = z.object({ total: z.object({ lines: z.object({ pct: z.number().min(0).max(100) }) }) }).parse(readJson(ctx, c.coverage));
      const pct = coverage.total.lines.pct;
      if (pct < c.minLinePercent || (c.baselineLinePercent !== undefined && pct < c.baselineLinePercent - c.maxDrop)) findings.push(issue("test-results", "Line coverage below policy", "coverage", `Current ${pct}%; minimum ${c.minLinePercent}%; baseline ${c.baselineLinePercent ?? "not configured"}.`, "high", "quality"));
    }
    return { findings, stats: { tests, failures, flaky } };
  });

const componentSchema: z.ZodType<any> = z.lazy(() => z.object({ name: z.string(), version: z.string().optional(),
  licenses: z.array(z.object({ license: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(), expression: z.string().optional() })).optional(),
  components: z.array(componentSchema).optional() }));
export const licenseSbom = checkedPlugin("license-sbom", "static", "Inspect CycloneDX SBOM against the project's explicit license allowlist",
  z.object({ file: z.string(), allowedLicenses: z.array(z.string()).min(1) }).strict(), async (ctx, c) => {
    const bom = z.object({ bomFormat: z.literal("CycloneDX"), specVersion: z.string(), components: z.array(componentSchema).min(1) }).parse(readJson(ctx, c.file));
    const findings: Finding[] = []; let components = 0;
    const visit = (items: any[], depth = 0) => {
      if (depth > 30) throw new Error("SBOM nesting limit exceeded");
      for (const item of items) {
        components++;
        const licenses = (item.licenses ?? []).map((v: any) => v.expression ?? v.license?.id ?? v.license?.name).filter(Boolean);
        // SPDX expressions must be explicitly allowed as complete expressions; do
        // not incorrectly split OR/AND/WITH into universal legal conclusions.
        if (!licenses.length || licenses.some((v: string) => !c.allowedLicenses.includes(v))) findings.push(issue("license-sbom", "Dependency license requires review", `${item.name}@${item.version ?? "unknown"}`, licenses.length ? `Declared: ${licenses.join(", ")}. Not on this project's allowlist.` : "No license declared in the supplied SBOM.", "medium", "quality"));
        visit(item.components ?? [], depth + 1);
      }
    };
    visit(bom.components);
    return { findings, stats: { components } };
  });
