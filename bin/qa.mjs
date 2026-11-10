#!/usr/bin/env node
// Thin launcher so `npx qa ...` (or `node path/to/qa-agent/bin/qa.mjs ...`) works
// without a build step, from any directory: tsx is resolved from this package,
// not from the current folder.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tsx = import.meta.resolve("tsx");
const r = spawnSync(process.execPath, ["--import", tsx, path.join(root, "src/cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 2);
