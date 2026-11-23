import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RunContext } from "../../core/context.js";
import { SkipError, type Finding } from "../../core/types.js";
import { readJUnitFile, type JUnitCase } from "../../core/junit.js";
import { CLOCK_SKEW_MS, resolveStorePath, withLock, writeFileAtomic } from "../../core/observation-history.js";
import { globToRegExp } from "./diff-coverage.js";
import { checkedPlugin, issue } from "./support.js";

/**
 * Flaky-test detection from the project's own JUnit results over many runs.
 *
 * Each run adds the current JUnit report(s) to a bounded local history, keyed by the
 * commit that was tested. A test is reported when:
 *  1. it failed and passed on the same clean commit (strong evidence: the code did not change),
 *  2. the report itself says it passed only after a retry (Surefire/Gradle flakyFailure etc.),
 *  3. its result keeps changing across recent runs (minFlips or more pass/fail changes; suspected).
 * Plain failures are the test-results check's job and are not repeated here.
 */

const MAX_TESTS = 50_000;
const MAX_NAME = 1000;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const LISTED = 50;
const relPattern = z.string().min(1).max(1024).refine((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes(".."), "Use a path relative to the configuration directory");

export const flakyTestsSchema = z.object({
  junit: z.union([relPattern, z.array(relPattern).min(1).max(50)]).optional(),
  record: z.boolean().default(true),
  store: z.string().min(1).max(1024).default(".veriq/test-history.json"),
  maxRuns: z.number().int().min(10).max(2000).default(200),
  window: z.number().int().min(2).max(2000).default(30),
  minRuns: z.number().int().min(2).max(2000).default(5),
  minFlips: z.number().int().min(2).max(100).default(3),
  maxFlakyTests: z.number().int().min(0).optional(),
  repoDir: z.string().min(1).max(1024).optional(),
}).strict()
  .refine((c) => !c.record || c.junit, "junit is required when record is true (set record: false to only analyze the history)")
  .refine((c) => c.minRuns <= c.window, "minRuns cannot exceed window")
  .refine((c) => c.window <= c.maxRuns, "window cannot exceed maxRuns");
type Config = z.output<typeof flakyTestsSchema>;

/** Per-run outcome codes: Pass, Fail, Retried-then-passed, Mixed (same name both passed and failed), Skipped, absent. */
export type Code = "P" | "F" | "R" | "M" | "S" | ".";
const runSchema = z.object({
  at: z.string().datetime(),
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).optional(),
  dirty: z.boolean(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  outcomes: z.string().regex(/^[PFRMS.]*$/),
}).strict();
export type HistoryRun = z.output<typeof runSchema>;
const storeSchema = z.object({ version: z.literal(1), tests: z.array(z.string().max(MAX_NAME)).max(MAX_TESTS * 4), runs: z.array(runSchema) }).strict()
  .refine((s) => s.runs.every((r) => r.outcomes.length === s.tests.length), "every run must have one outcome per test")
  .refine((s) => new Set(s.tests).size === s.tests.length, "test names must be unique");
export type History = z.output<typeof storeSchema>;

/** Combine all entries for one test name in one run. Several entries with different results become M. */
export function codeFor(entries: JUnitCase[]): Code {
  const ran = entries.filter((e) => e.outcome !== "skipped");
  if (!ran.length) return "S";
  const failed = ran.some((e) => e.outcome === "failed"), passed = ran.some((e) => e.outcome === "passed");
  if (failed && passed) return "M";
  if (failed) return "F";
  return ran.some((e) => e.retried) ? "R" : "P";
}

export function runOutcomes(cases: JUnitCase[]) {
  const byName = new Map<string, JUnitCase[]>();
  for (const c of cases) {
    const name = c.name.slice(0, MAX_NAME);
    byName.set(name, [...(byName.get(name) ?? []), c]);
  }
  if (byName.size > MAX_TESTS) throw new Error(`The JUnit reports contain more than ${MAX_TESTS} distinct tests`);
  const codes = new Map<string, Code>();
  let duplicateNames = 0;
  for (const [name, entries] of byName) { codes.set(name, codeFor(entries)); if (entries.length > 1) duplicateNames++; }
  return { codes, duplicateNames };
}

/** Add one run to the history, keeping the newest maxRuns and dropping tests no kept run mentions. */
export function addRun(history: History, run: Omit<HistoryRun, "outcomes">, codes: Map<string, Code>, maxRuns: number): History {
  const tests = [...history.tests];
  const index = new Map(tests.map((t, i) => [t, i]));
  for (const name of codes.keys()) if (!index.has(name)) { index.set(name, tests.length); tests.push(name); }
  const pad = (o: string) => o.padEnd(tests.length, ".");
  const current = Array.from({ length: tests.length }, () => ".");
  for (const [name, code] of codes) current[index.get(name)!] = code;
  const runs = [...history.runs.map((r) => ({ ...r, outcomes: pad(r.outcomes) })), { ...run, outcomes: current.join("") }]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-maxRuns);
  const keep = tests.map((_, i) => runs.some((r) => r.outcomes[i] !== "."));
  return {
    version: 1,
    tests: tests.filter((_, i) => keep[i]),
    runs: runs.map((r) => ({ ...r, outcomes: [...r.outcomes].filter((_, i) => keep[i]).join("") })),
  };
}

export function readStore(file: string, nowMs: number): History {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (e: any) { if (e.code === "ENOENT") return { version: 1, tests: [], runs: [] }; throw new Error("Test history cannot be read"); }
  if (!stat.isFile()) throw new Error("Test history must be a regular file, not a link or directory");
  if (stat.size > MAX_STORE_BYTES) throw new Error("Test history exceeds 64 MiB; lower maxRuns or move the file");
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("Test history is not valid JSON; fix or move the file"); }
  const parsed = storeSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Test history is invalid; fix or move the file (content not shown)");
  if (parsed.data.runs.some((r) => Date.parse(r.at) > nowMs + CLOCK_SKEW_MS)) throw new Error("Test history has a run in the future; check the system clock");
  return { ...parsed.data, runs: [...parsed.data.runs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) };
}

export type FlakyKind = "same-commit" | "retried" | "changing";
export interface FlakyTest {
  test: string; kind: FlakyKind; runs: number; passed: number; failed: number; retried: number; mixed: number;
  changes: number; conflictingCommits: string[]; lastFailedRunsAgo: number | null;
}

const classOf = (c: Code) => (c === "P" || c === "R" ? "pass" : c === "F" ? "fail" : c === "M" ? "mixed" : null);

/** Analyse the newest `window` runs. */
export function analyse(history: History, c: Pick<Config, "window" | "minRuns" | "minFlips">) {
  const runs = history.runs.slice(-c.window);
  const flaky: FlakyTest[] = [];
  history.tests.forEach((test, i) => {
    const seq: { code: Code; run: HistoryRun }[] = [];
    for (const run of runs) { const code = run.outcomes[i] as Code; if (classOf(code)) seq.push({ code, run }); }
    if (!seq.length) return;
    const count = (k: Code) => seq.filter((s) => s.code === k).length;
    let changes = 0;
    for (let k = 1; k < seq.length; k++) if (classOf(seq[k].code) !== classOf(seq[k - 1].code)) changes++;
    const byCommit = new Map<string, Set<string>>();
    for (const s of seq) if (s.run.commit && !s.run.dirty) byCommit.set(s.run.commit, (byCommit.get(s.run.commit) ?? new Set()).add(classOf(s.code)!));
    const conflictingCommits = [...byCommit].filter(([, set]) => set.size > 1).map(([commit]) => commit);
    const lastFail = seq.map((s) => s.code).lastIndexOf("F");
    const kind: FlakyKind | undefined = conflictingCommits.length ? "same-commit" : count("R") ? "retried"
      : changes >= c.minFlips && seq.length >= c.minRuns ? "changing" : undefined;
    if (!kind) return;
    flaky.push({ test, kind, runs: seq.length, passed: count("P"), failed: count("F"), retried: count("R"), mixed: count("M"), changes,
      conflictingCommits, lastFailedRunsAgo: lastFail < 0 ? null : seq.length - 1 - lastFail });
  });
  const rank: Record<FlakyKind, number> = { "same-commit": 0, retried: 1, changing: 2 };
  flaky.sort((a, b) => rank[a.kind] - rank[b.kind] || b.changes - a.changes || b.failed + b.mixed - (a.failed + a.mixed) || a.test.localeCompare(b.test));
  return { runsAnalysed: runs.length, flaky };
}

function git(repoDir: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.fsmonitor=false", "-C", repoDir, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout));
  });
}

/** The tested commit and whether tracked files differ from it. Without git, the commit is unknown. */
export async function testedCommit(repoDir: string): Promise<{ commit?: string; dirty: boolean; commitTimeMs?: number }> {
  if (!fs.existsSync(path.join(repoDir, ".git"))) return { dirty: false };
  const head = (await git(repoDir, ["rev-parse", "--verify", "HEAD^{commit}"]))?.trim();
  if (!head || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return { dirty: false };
  const status = await git(repoDir, ["status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=all"]);
  const time = Number((await git(repoDir, ["show", "-s", "--format=%ct", head]))?.trim()) * 1000;
  return { commit: head, dirty: status === undefined || status.trim() !== "", commitTimeMs: Number.isFinite(time) ? time : undefined };
}

/** Expand report paths and simple globs (`*`, `**`, `?`) inside the configuration directory. */
export function expandReports(root: string, patterns: string[], label = "JUnit file"): string[] {
  const base = path.resolve(root);
  const found = new Set<string>();
  for (const pattern of patterns) {
    const posix = pattern.split(path.sep).join("/");
    if (!/[*?]/.test(posix)) { found.add(path.resolve(base, posix)); continue; }
    const segments = posix.split("/");
    const firstGlob = segments.findIndex((s) => /[*?]/.test(s));
    const start = path.resolve(base, ...segments.slice(0, firstGlob));
    const re = globToRegExp(posix);
    const matches: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 12) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile() && re.test(path.relative(base, full).split(path.sep).join("/"))) {
          matches.push(full);
          if (matches.length + found.size > MAX_FILES) throw new Error(`More than ${MAX_FILES} files match ${pattern}; narrow the pattern`);
        }
      }
    };
    walk(start, 0);
    if (!matches.length) throw new Error(`No ${label} matches ${pattern}`);
    matches.forEach((m) => found.add(m));
  }
  return [...found].sort();
}

const label: Record<FlakyKind, string> = {
  "same-commit": "Flaky test: failed and passed on the same commit",
  retried: "Flaky test: passed only after a retry",
  changing: "Suspected flaky test: result keeps changing",
};

function describe(f: FlakyTest, window: number) {
  const parts = [`Last ${f.runs} recorded run(s) (window ${window}): ${f.passed} passed, ${f.failed} failed`];
  if (f.retried) parts.push(`${f.retried} passed only after a retry`);
  if (f.mixed) parts.push(`${f.mixed} with both passing and failing entries under this name`);
  parts.push(`${f.changes} result change(s)`);
  if (f.conflictingCommits.length) parts.push(`both results on commit ${f.conflictingCommits.slice(0, 3).map((c) => c.slice(0, 12)).join(", ")}${f.conflictingCommits.length > 3 ? ` and ${f.conflictingCommits.length - 3} more` : ""}`);
  if (f.lastFailedRunsAgo !== null) parts.push(f.lastFailedRunsAgo === 0 ? "failed in the latest run" : `last failed ${f.lastFailedRunsAgo} run(s) ago`);
  return parts.join("; ") + ".";
}

export async function flakyTests(ctx: RunContext, c: Config) {
  const repoDir = path.resolve(ctx.configDir, c.repoDir ?? ".");
  const storeFile = resolveStorePath(ctx.configDir, c.store, ".json");
  const now = Date.now();
  let recorded: "added" | "already-recorded" | "not-recording";
  let duplicateNames = 0, testsInRun = 0;

  let history: History;
  if (c.record) {
    const files = expandReports(ctx.configDir, Array.isArray(c.junit) ? c.junit : [c.junit!]);
    const tested = await testedCommit(repoDir);
    const hash = createHash("sha256");
    const cases: JUnitCase[] = [];
    let total = 0;
    for (const file of files) {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile()) throw new Error(`JUnit report ${path.relative(ctx.configDir, file)} not found`);
      // Results older than the tested commit belong to other code; recording them under this commit would be false evidence.
      if (tested.commitTimeMs && stat.mtimeMs + 1000 < tested.commitTimeMs) throw new Error(`JUnit report ${path.relative(ctx.configDir, file)} is older than the latest commit; rerun the tests`);
      total += stat.size;
      if (total > MAX_TOTAL_BYTES) throw new Error("JUnit reports exceed 200 MiB in total");
      hash.update(path.relative(ctx.configDir, file)).update("\u0000").update(fs.readFileSync(file)).update("\u0000");
      cases.push(...readJUnitFile(file));
    }
    if (!cases.length) throw new Error("JUnit reports contain no test cases");
    const digest = hash.digest("hex");
    const { codes, duplicateNames: dup } = runOutcomes(cases);
    duplicateNames = dup; testsInRun = codes.size;
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    ({ history, recorded } = await withLock(storeFile, () => {
      const current = readStore(storeFile, now);
      if (current.runs.some((r) => r.hash === digest)) return { history: current, recorded: "already-recorded" as const };
      const next = addRun(current, { at: new Date(now).toISOString(), ...(tested.commit ? { commit: tested.commit } : {}), dirty: tested.dirty, hash: digest }, codes, c.maxRuns);
      const body = JSON.stringify(next) + "\n";
      if (Buffer.byteLength(body) > MAX_STORE_BYTES) throw new Error("Test history would exceed 64 MiB; lower maxRuns");
      writeFileAtomic(storeFile, body);
      return { history: next, recorded: "added" as const };
    }));
  } else { history = readStore(storeFile, now); recorded = "not-recording"; }

  const { runsAnalysed, flaky } = analyse(history, c);
  const confirmed = flaky.filter((f) => f.kind !== "changing").length;
  const stats = { runsInHistory: history.runs.length, runsAnalysed, testsInRun, flakyTests: flaky.length, confirmed, suspected: flaky.length - confirmed, duplicateNames, recorded };

  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.outDir, "flaky-tests.json"), JSON.stringify({ ...stats, window: c.window, minFlips: c.minFlips, flaky: flaky.slice(0, 2000), truncated: flaky.length > 2000 }, null, 2));

  // Cross-run evidence needs enough runs; report how far along the history is instead of passing.
  if (!confirmed && runsAnalysed < c.minRuns) {
    throw new SkipError(`Test history has ${runsAnalysed} of the ${c.minRuns} runs needed to judge result changes${recorded === "added" ? " (this run was recorded)" : recorded === "already-recorded" ? " (this report was already recorded; rerun the tests to add a run)" : ""}; no test passed only after a retry`);
  }

  const findings: Finding[] = flaky.slice(0, LISTED).map((f) => ({
    ...issue("flaky-tests", label[f.kind], f.test, describe(f, c.window), "medium", "quality"), key: f.test,
    confidence: f.kind === "changing" ? "medium" as const : "high" as const,
    remediation: "Find the shared state, ordering, timing or external dependency that makes this test nondeterministic, fix it, and keep the retry count at zero; quarantine it only with an owner and a date.",
  }));
  if (flaky.length > LISTED) findings.push(issue("flaky-tests", "More flaky tests than listed", "test history", `${flaky.length - LISTED} more flaky test(s) are in flaky-tests.json.`, "low", "quality"));
  if (c.maxFlakyTests !== undefined && flaky.length > c.maxFlakyTests) {
    findings.push({ ...issue("flaky-tests", "Flaky tests exceed the allowed number", "test history", `${flaky.length} flaky test(s) (${confirmed} confirmed, ${flaky.length - confirmed} suspected); the limit is ${c.maxFlakyTests}.`, "high", "quality"),
      remediation: "Fix the listed flaky tests until the count is within maxFlakyTests." });
  }
  return { findings, stats };
}

export const flakyTestsPlugin = checkedPlugin("flaky-tests", "static", "Tests that fail and pass on the same code, pass only after retries, or keep changing result across recorded JUnit runs",
  flakyTestsSchema, (ctx, c) => flakyTests(ctx, c));
