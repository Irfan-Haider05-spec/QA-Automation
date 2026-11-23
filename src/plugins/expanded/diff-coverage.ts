import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { RunContext } from "../../core/context.js";
import type { Finding } from "../../core/types.js";
import { checkedPlugin, issue } from "./support.js";

/**
 * Changed-lines (diff) coverage: of the executable lines a change adds or modifies,
 * how many did the project's own tests run?
 *
 * Inputs are the project's LCOV report (c8, nyc, Jest, Vitest, `flutter test --coverage`)
 * and `git diff base...HEAD`. Only lines LCOV marks as executable (DA records) count;
 * comments, blank lines and type-only lines do not. A changed source file that LCOV does
 * not mention at all is reported, never silently skipped, because its lines could not be
 * measured. Stale or empty reports and unknown base refs error instead of passing.
 *
 * git runs without a shell, without external diff drivers, textconv or fsmonitor, so a
 * repository's own config cannot make this check execute programs.
 */

const run = promisify(execFile);
const MAX_DIFF_BYTES = 32 * 1024 * 1024;
const MAX_LCOV_BYTES = 64 * 1024 * 1024;
const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".dart"];
export const DEFAULT_EXCLUDE = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "test/**", "tests/**", "**/*.d.ts", "**/*.g.dart", "**/*.freezed.dart"];

const gitRef = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._\/@^~{}-]*$/, "Use a branch, tag or commit (letters, digits, . _ / - @ ^ ~)");
const glob = z.string().min(1).max(300).refine((g) => !g.startsWith("/") && !g.split("/").includes(".."), "Globs are relative to the repository");

export const diffCoverageSchema = z.object({
  lcov: z.string().min(1).max(1024),
  base: gitRef.default("origin/main"),
  head: gitRef.default("HEAD"),
  repoDir: z.string().min(1).max(1024).optional(),
  minPercent: z.number().min(0).max(100).default(80),
  include: z.array(glob).max(50).default([]),
  /** Added to the default excludes (tests, .d.ts, generated Dart) unless defaultExcludes is false. */
  exclude: z.array(glob).max(50).default([]),
  defaultExcludes: z.boolean().default(true),
  extensions: z.array(z.string().regex(/^\.[A-Za-z0-9]{1,10}$/)).min(1).max(30).default(DEFAULT_EXTENSIONS),
  missingFiles: z.enum(["fail", "report"]).default("fail"),
  timeoutMs: z.number().int().min(1000).max(300000).default(60000),
}).strict();
type Config = z.output<typeof diffCoverageSchema>;

/** Translate a small glob (`*`, `**`, `?`) into an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const slash = pattern[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Changed (added or modified) line numbers per file, from `git diff --unified=0`. */
export function parseUnifiedDiff(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") { current = undefined; continue; }
      const name = unquote(target).replace(/^b\//, "");
      current = files.get(name) ?? new Set<number>();
      files.set(name, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n++) current.add(n);
    }
  }
  for (const [name, lines] of files) if (!lines.size) files.delete(name);
  return files;
}

/** git C-quotes unusual paths ("a\tb.ts"); undo the common escapes. */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  return p.slice(1, -1).replace(/\\([\\"tn])/g, (_, ch) => ({ t: "\t", n: "\n", '"': '"', "\\": "\\" })[ch as "t"] ?? ch)
    .replace(/(?:\\[0-7]{3})+/g, (run) => Buffer.from(run.split("\\").slice(1).map((o) => parseInt(o, 8))).toString("utf8"));
}

/** Executable lines and hit counts per source file from an LCOV report. */
export function parseLcov(text: string, repoDir: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let current: Map<number, number> | undefined;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const source = line.slice(3);
      const absolute = path.resolve(repoDir, source);
      const relative = path.relative(repoDir, absolute).split(path.sep).join("/");
      current = relative.startsWith("..") || path.isAbsolute(relative) ? undefined : (files.get(relative) ?? new Map());
      if (current) files.set(relative, current);
    } else if (line.startsWith("DA:")) {
      const match = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(line);
      if (!match) throw new Error(`LCOV line ${index + 1} is not a valid DA record`);
      if (current) current.set(Number(match[1]), Math.max(current.get(Number(match[1])) ?? 0, Number(match[2])));
    } else if (line === "end_of_record") current = undefined;
  });
  return files;
}

/** "3-5, 9, 12-13" from a sorted list of line numbers. */
export function lineRanges(lines: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    parts.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j;
  }
  return parts.join(", ");
}

async function git(repoDir: string, args: string[], timeoutMs: number): Promise<string> {
  // No shell; repository config cannot run external diff drivers, textconv or fsmonitor.
  const safe = ["-c", "core.fsmonitor=false", "-c", "core.quotePath=true", "-c", "diff.external=", "-C", repoDir, ...args];
  try {
    const { stdout } = await run("git", safe, { timeout: timeoutMs, maxBuffer: MAX_DIFF_BYTES, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, windowsHide: true });
    return stdout;
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new Error("git is not installed or not on PATH");
    if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("The diff is larger than 32 MiB; narrow include/exclude");
    if (e?.killed) throw new Error("git timed out");
    throw new Error(`git ${args[0]} failed`);
  }
}

export interface FileResult { file: string; executable: number; covered: number; uncovered: string }

export async function diffCoverage(ctx: RunContext, c: Config): Promise<{ findings: Finding[]; stats: Record<string, number | string> }> {
  const repoDir = path.resolve(ctx.configDir, c.repoDir ?? ".");
  if (!fs.statSync(repoDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error("repoDir is not a directory");
  const lcovFile = path.resolve(ctx.configDir, c.lcov);
  const lcovStat = fs.statSync(lcovFile, { throwIfNoEntry: false });
  if (!lcovStat?.isFile()) throw new Error("LCOV report not found; run the tests with LCOV coverage first");
  if (lcovStat.size > MAX_LCOV_BYTES) throw new Error("LCOV report exceeds 64 MiB");

  // Resolve both refs before diffing: a shallow CI checkout lacks the base commit.
  const resolve = async (ref: string) => (await git(repoDir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], c.timeoutMs).catch(() => "")).trim();
  const [baseSha, headSha] = await Promise.all([resolve(c.base), resolve(c.head)]);
  if (!/^[0-9a-f]{40,64}$/.test(baseSha)) throw new Error(`Base ref ${c.base} is not available; fetch it (CI: actions/checkout with fetch-depth: 0)`);
  if (!/^[0-9a-f]{40,64}$/.test(headSha)) throw new Error(`Head ref ${c.head} is not available`);

  // A report older than the commit it should describe cannot speak for that commit.
  const headTime = Number((await git(repoDir, ["show", "-s", "--format=%ct", headSha], c.timeoutMs)).trim()) * 1000;
  if (lcovStat.mtimeMs + 1000 < headTime) throw new Error("The LCOV report is older than the head commit; rerun the tests with coverage");

  const diff = await git(repoDir, ["diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--diff-filter=AMR", `${baseSha}...${headSha}`, "--"], c.timeoutMs);
  const changed = parseUnifiedDiff(diff);
  const lcov = parseLcov(fs.readFileSync(lcovFile, "utf8"), repoDir);
  if (![...lcov.values()].some((lines) => lines.size)) throw new Error("The LCOV report contains no line data for files in this repository");

  const included = c.include.map(globToRegExp), excluded = [...(c.defaultExcludes ? DEFAULT_EXCLUDE : []), ...c.exclude].map(globToRegExp);
  const results: FileResult[] = [];
  const missing: string[] = [];
  let considered = 0;
  for (const [file, lines] of [...changed].sort(([a], [b]) => a.localeCompare(b))) {
    if (!c.extensions.includes(path.extname(file))) continue;
    if (included.length && !included.some((r) => r.test(file))) continue;
    if (excluded.some((r) => r.test(file))) continue;
    considered++;
    // A changed file that is newer than the report was not measured in its current form.
    const stat = fs.statSync(path.join(repoDir, file), { throwIfNoEntry: false });
    if (stat && stat.mtimeMs > lcovStat.mtimeMs + 1000) throw new Error("A changed file is newer than the LCOV report; rerun the tests with coverage");
    const hits = lcov.get(file);
    if (!hits) { missing.push(file); continue; }
    const executable = [...lines].filter((n) => hits.has(n)).sort((a, b) => a - b);
    if (!executable.length) continue;
    const uncovered = executable.filter((n) => hits.get(n) === 0);
    results.push({ file, executable: executable.length, covered: executable.length - uncovered.length, uncovered: lineRanges(uncovered) });
  }

  const executable = results.reduce((n, r) => n + r.executable, 0);
  const covered = results.reduce((n, r) => n + r.covered, 0);
  const percent = executable ? Math.round((covered / executable) * 10000) / 100 : 100;
  const worst = results.filter((r) => r.uncovered).sort((a, b) => (a.covered / a.executable) - (b.covered / b.executable));

  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.outDir, "diff-coverage.json"), JSON.stringify({
    base: c.base, baseSha, head: c.head, headSha, minPercent: c.minPercent, percent, executable, covered,
    files: results.slice(0, 500), filesTruncated: results.length > 500, missingFromReport: missing.slice(0, 500),
  }, null, 2));

  const findings: Finding[] = [];
  if (executable && percent < c.minPercent) {
    const list = worst.slice(0, 20).map((r) => `${r.file} (${r.covered}/${r.executable}): ${r.uncovered}`).join("\n");
    const f = issue("diff-coverage", "Changed lines are under-tested", `${c.base}...${c.head}`,
      `${covered} of ${executable} changed executable lines ran in tests (${percent}%; minimum ${c.minPercent}%). Uncovered changed lines:\n${list}${worst.length > 20 ? `\n…and ${worst.length - 20} more files (see diff-coverage.json)` : ""}`, "high", "quality");
    findings.push({ ...f, remediation: "Add tests that exercise the listed changed lines, then rerun the tests with coverage." });
  }
  if (missing.length) {
    const f = issue("diff-coverage", "Changed source files are missing from the coverage report", `${c.base}...${c.head}`,
      `${missing.length} changed file(s) had no coverage data, so their lines could not be measured:\n${missing.slice(0, 20).join("\n")}${missing.length > 20 ? `\n…and ${missing.length - 20} more` : ""}`,
      c.missingFiles === "fail" ? "high" : "low", "quality");
    findings.push({ ...f, remediation: "Make the coverage tool include all source files (for example c8 --all, Jest collectCoverageFrom), or exclude files without runtime code (types, generated code)." });
  }
  return { findings, stats: { base: c.base, changedFiles: changed.size, consideredFiles: considered, executableChangedLines: executable, coveredChangedLines: covered, percent, missingFromReport: missing.length } };
}

export const diffCoveragePlugin = checkedPlugin("diff-coverage", "static", "Coverage of the executable lines a change adds or modifies (LCOV + git diff), with a minimum percent",
  diffCoverageSchema, (ctx, c) => diffCoverage(ctx, c));
