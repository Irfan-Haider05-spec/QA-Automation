import { execFileSync } from "node:child_process";
import path from "node:path";
import picomatch from "picomatch";
import type { RouteInfo } from "./types.js";
import type { QaConfig } from "./config.js";

/**
 * Files changed between a base ref and HEAD, relative to the backend folder.
 * --relative matters when the backend is a subfolder of the repo (monorepos):
 * git would otherwise report repo-root paths that never match the routes.
 * Changes outside the backend folder are left out.
 */
export function changedFiles(backendDir: string, baseRef: string): string[] {
  const run = (args: string[]) => execFileSync("git", ["-C", backendDir, ...args], { encoding: "utf8" });
  let out: string;
  try {
    out = run(["diff", "--relative", "--name-only", `${baseRef}...HEAD`]);
  } catch {
    // Shallow clones may lack the merge base; fall back to a two-dot diff
    out = run(["diff", "--relative", "--name-only", baseRef, "HEAD"]);
  }
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * Pick the routes a diff can affect.
 * - A change to a global file (app.ts, middlewares, config...) selects all routes.
 * - A change inside src/app/modules/<name>/ selects routes defined in that module.
 * - Changes outside src (docs, CI) select nothing for the API plugins.
 */
export function selectRoutes(routes: RouteInfo[], files: string[], config: QaConfig) {
  const isGlobal = picomatch(config.globalPaths.length ? config.globalPaths : ["**/*"]);
  const modulesDir = config.backend.modulesDir.replace(/\/+$/, "") + "/";
  if (files.some((f) => isGlobal(f))) return { routes, reason: "global file changed" };
  const touchedModules = new Set<string>();
  for (const f of files) {
    if (!f.startsWith(modulesDir)) continue;
    const rest = f.slice(modulesDir.length).split("/");
    // modules can be nested one level (e.g. merchant/promotionMerchant)
    touchedModules.add(rest[0]);
    if (rest.length > 2) touchedModules.add(rest.slice(0, 2).join("/"));
  }
  const selected = routes.filter((r) => {
    const rel = path.relative(config.backend.dir, path.resolve(config.backend.dir, r.source.file)).replace(/\\/g, "/");
    if (!rel.startsWith(modulesDir)) return false;
    const parts = rel.slice(modulesDir.length).split("/");
    return touchedModules.has(parts[0]) || touchedModules.has(parts.slice(0, 2).join("/"));
  });
  return { routes: selected, reason: `${touchedModules.size} module(s) changed` };
}
