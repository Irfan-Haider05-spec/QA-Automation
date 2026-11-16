import fs from "node:fs";
import path from "node:path";
import { runBoundedProcess } from "./bounded-process.js";

/** Trusted local execution only. Separate args; private fresh report directory;
 * output is never logged because project tools may print credentials. */
export async function executeProjectTests(options: { command: string; args: string[]; cwd: string; outDir: string; timeoutMs: number; coverage: boolean }) {
  if (!options.args.some(a => a.includes("{junit}"))) throw new Error("Test arguments must include {junit} for a fresh report");
  if (options.coverage && !options.args.some(a => a.includes("{coverage}"))) throw new Error("Test arguments must include {coverage}");
  fs.mkdirSync(options.outDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(options.outDir, "project-test-"));
  const junit = path.join(dir, "junit.xml"), coverage = path.join(dir, "coverage.json");
  const args = options.args.map(a => a.replaceAll("{junit}", junit).replaceAll("{coverage}", coverage));
  const code = await runBoundedProcess({ ...options, args });
  try {
    for (const file of [junit, ...(options.coverage ? [coverage] : [])]) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 20 * 1024 * 1024) throw new Error("Project tests produced an invalid report");
    }
    return { junit, coverage, exitCode: code };
  } catch { throw new Error("Project tests did not produce fresh regular reports"); }
}
