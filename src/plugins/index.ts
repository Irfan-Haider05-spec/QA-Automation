import type { QaPlugin } from "../core/types.js";
import { routeAuthPlugin } from "./route-auth.js";
import { envDriftPlugin } from "./env-drift.js";
import { secretsPlugin } from "./secrets.js";
import { depsPlugin } from "./deps.js";
import { healthCorsPlugin } from "./health-cors.js";
import { apiAuthPlugin } from "./api-auth.js";
import { apiSmokePlugin } from "./api-smoke.js";
import { tenantIsolationPlugin } from "./tenant-isolation.js";
import { fuzzPlugin } from "./fuzz.js";
import { webCrawlPlugin } from "./web-crawl.js";
import { webA11yPlugin } from "./web-a11y.js";
import { webVisualPlugin } from "./web-visual.js";
import { socketFanoutPlugin } from "./socket-fanout.js";
import { loadSmokePlugin } from "./load-smoke.js";
import { zapBaselinePlugin } from "./zap-baseline.js";
import { lighthousePlugin } from "./lighthouse.js";
import { flowsPlugin } from "./flows.js";
import { mobilePlugin } from "./mobile.js";

/** Registry. To add a tool: write a plugin file, add it here, list it in a suite in qa.config.ts. */
export const PLUGINS: QaPlugin[] = [
  routeAuthPlugin,
  envDriftPlugin,
  secretsPlugin,
  depsPlugin,
  healthCorsPlugin,
  apiAuthPlugin,
  apiSmokePlugin,
  tenantIsolationPlugin,
  fuzzPlugin,
  webCrawlPlugin,
  webA11yPlugin,
  webVisualPlugin,
  socketFanoutPlugin,
  loadSmokePlugin,
  zapBaselinePlugin,
  lighthousePlugin,
  flowsPlugin,
  mobilePlugin,
];

export const pluginByName = new Map(PLUGINS.map((p) => [p.name, p]));
