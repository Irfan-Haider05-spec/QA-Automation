import type { QaConfig } from "./config.js";
import type { Logger, RouteInfo, Suite } from "./types.js";
import { HttpClient } from "./http.js";
import { AuthProvider } from "./auth.js";

export interface RunContext {
  suite: Suite;
  config: QaConfig;
  configDir: string;
  outDir: string;
  /** Every route found in the backend source */
  routes: RouteInfo[];
  /** Routes selected for this run (all, or only those touched by the diff) */
  targetRoutes: RouteInfo[];
  /** null = no diff selection (run everything) */
  changedFiles: string[] | null;
  openapiPath?: string;
  /** Names of the plugins in this run (web plugins share one crawl and need to know which extras to collect) */
  selectedPlugins: string[];
  /** Write new visual baselines instead of comparing */
  updateVisual: boolean;
  http?: HttpClient;
  auth?: AuthProvider;
  log: Logger;
}

export function makeLogger(verbose: boolean): Logger {
  const ts = () => new Date().toISOString().slice(11, 19);
  return {
    info: (m) => console.log(`[${ts()}] ${m}`),
    warn: (m) => console.warn(`[${ts()}] WARN ${m}`),
    debug: (m) => { if (verbose) console.log(`[${ts()}] debug ${m}`); },
  };
}
