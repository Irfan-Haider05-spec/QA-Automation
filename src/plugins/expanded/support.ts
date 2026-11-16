import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RunContext } from "../../core/context.js";
import { SkipError, type Finding, type QaPlugin, type Severity } from "../../core/types.js";
import type { HttpRequest, HttpResponse } from "../../core/http.js";

export const localPath = z.string().min(1).max(2048).refine((p) => p.startsWith("/") && !p.startsWith("//") && !/[\\\r\n]/.test(p), "Expected a same-origin absolute path");
export const requestSchema = z.object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), path: localPath,
  account: z.string().optional(), json: z.unknown().optional() }).strict();
export const activeCaseSchema = requestSchema.extend({ expectedStatuses: z.array(z.number().int().min(100).max(599)).min(1).max(20) });

export function settings<S extends z.ZodTypeAny>(ctx: RunContext, name: string, schema: S): z.output<S> {
  return schema.parse(ctx.config.pluginSettings?.[name] ?? {});
}
export function configured(ctx: RunContext, name: string) {
  return Object.hasOwn(ctx.config.pluginSettings ?? {}, name) ? null : `Configure pluginSettings["${name}"] to enable this check`;
}
export function disposable(ctx: RunContext) {
  if (!ctx.config.allowMutations || !ctx.config.disposable) throw new SkipError("Requires allowMutations AND disposable with explicitly provisioned QA data");
}
export function issue(plugin: string, title: string, target: string, detail: string, severity: Severity = "high", category: Finding["category"] = "security", cwe?: string): Finding {
  return { plugin, title, target, detail, severity, category, confidence: "high", ...(cwe ? { cwe: [cwe] } : {}),
    remediation: category === "security" ? "Enforce the expected policy on the server and add a regression test for this case." : "Correct the reported behavior and rerun the same check." };
}
export function readJson(ctx: RunContext, file: string): unknown {
  const resolved = path.resolve(ctx.configDir, file);
  if (fs.statSync(resolved).size > 20 * 1024 * 1024) throw new Error("Report exceeds 20 MiB");
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}
export async function request(ctx: RunContext, spec: z.output<typeof requestSchema>, extras: Partial<HttpRequest> = {}): Promise<HttpResponse> {
  if (!ctx.http) throw new Error("HTTP client unavailable");
  let headers: Record<string, string> | undefined;
  if (spec.account) {
    headers = await ctx.auth?.header(spec.account);
    if (!headers) throw new Error(`QA account ${spec.account} could not authenticate`);
  }
  const res = await ctx.http.send({ method: spec.method, path: spec.path, json: spec.json, retry: false, ...extras, headers: { ...headers, ...extras.headers } });
  if (res.networkError) throw new Error(`Probe failed: ${res.networkError}`);
  return res;
}
export function checkedPlugin<S extends z.ZodTypeAny>(name: string, layer: QaPlugin["layer"], description: string, schema: S,
  run: (ctx: RunContext, config: z.output<S>) => ReturnType<QaPlugin["run"]>, needs: QaPlugin["needs"] = []): QaPlugin {
  return { name, apiVersion: 1, layer, description, needs,
    skipReason: (ctx) => configured(ctx, name), run: (ctx) => run(ctx, settings(ctx, name, schema)) };
}
