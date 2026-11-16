import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { z } from "zod";
import type { QaPlugin } from "./types.js";

export const PLUGIN_API_VERSION = 1 as const;
export function definePlugin<T>(plugin: QaPlugin & { apiVersion: 1; settingsSchema: z.ZodType<T> }) { return plugin; }

export const findingSchema = z.object({
  plugin: z.string().min(1), severity: z.enum(["critical", "high", "medium", "low", "info"]),
  title: z.string().min(1).max(1000), target: z.string().max(2000), detail: z.string().max(20000).optional(),
  category: z.enum(["regression", "security", "config", "performance", "env", "quality"]),
  evidence: z.object({ url: z.string().optional(), curl: z.string().optional(), status: z.number().optional(),
    responseSnippet: z.string().optional(), file: z.string().optional(), line: z.number().optional(),
    log: z.string().optional(), image: z.string().optional() }).optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(), cwe: z.array(z.string()).optional(),
  owasp: z.array(z.string()).optional(), remediation: z.string().optional(), flaky: z.boolean().optional(),
  known: z.object({ reason: z.string(), since: z.string().optional() }).optional(),
});

/** Loading a plugin is explicit trusted code execution, like loading qa.config.ts. */
export async function loadPlugins(builtins: QaPlugin[], modules: string[], configDir: string, settings: Record<string, unknown>) {
  const registry = new Map(builtins.map((p) => [p.name, p]));
  const require = createRequire(path.join(configDir, "qa.config.ts"));
  for (const specifier of modules) {
    if (/^[a-z]+:\/\//i.test(specifier)) throw new Error("Remote plugin URLs are not allowed");
    const file = path.isAbsolute(specifier) || specifier.startsWith(".") ? path.resolve(configDir, specifier) : require.resolve(specifier);
    const mod = await import(pathToFileURL(file).href);
    const plugin = mod.default;
    if (!plugin || plugin.apiVersion !== 1 || typeof plugin.run !== "function" || !/^[a-z][a-z0-9-]{1,63}$/.test(plugin.name)
      || !["static", "api", "web", "security", "perf"].includes(plugin.layer) || typeof plugin.description !== "string"
      || typeof plugin.settingsSchema?.parse !== "function") throw new Error(`Invalid v1 plugin: ${specifier}`);
    if (registry.has(plugin.name)) throw new Error(`Duplicate plugin name: ${plugin.name}`);
    settings[plugin.name] = plugin.settingsSchema.parse(settings[plugin.name] ?? {});
    registry.set(plugin.name, plugin);
  }
  return registry;
}
