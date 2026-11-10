/**
 * GitHub Actions integration (qa run --github):
 *
 * - git context of the run: repo, PR number, the PR's head commit (not the merge
 *   commit GitHub checks out), branch, link to the job
 * - why the run happened (pr / push / deploy / schedule / manual)
 * - job summary (GITHUB_STEP_SUMMARY), step outputs (GITHUB_OUTPUT)
 * - inline annotations on the PR's changed files for findings with a source line
 * - one sticky PR comment, updated on every push instead of piling up
 * - a "QA gate" commit status linking to the run on the platform
 *
 * Talks to the GitHub REST API with the job's GITHUB_TOKEN. Every GitHub call is
 * best effort: a missing permission is reported as a warning, never as a failed
 * quality gate.
 */
import fs from "node:fs";
import path from "node:path";
import type { RunSummary } from "./report.js";
import type { Finding, Severity } from "./types.js";
import { severityRank } from "./types.js";

export const COMMENT_MARKER = "<!-- qa-agent-report -->";
export type RunTrigger = "pr" | "push" | "deploy" | "schedule" | "manual";

export interface GithubContext {
  repo: string;
  serverUrl: string;
  apiUrl: string;
  eventName: string;
  sha?: string;
  ref?: string;
  prNumber?: number;
  baseRef?: string;
  runUrl?: string;
  workspace: string;
}

/** null when not running inside GitHub Actions */
export function githubContext(env: NodeJS.ProcessEnv = process.env): GithubContext | null {
  if (env.GITHUB_ACTIONS !== "true" || !env.GITHUB_REPOSITORY) return null;
  let event: any = {};
  try {
    if (env.GITHUB_EVENT_PATH) event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch { /* no payload: fall back to env vars */ }
  const pr = event.pull_request;
  const serverUrl = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  const prNumber = pr?.number ?? (env.QA_PR_NUMBER ? Number(env.QA_PR_NUMBER) : undefined);
  return {
    repo: env.GITHUB_REPOSITORY,
    serverUrl,
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    eventName: env.GITHUB_EVENT_NAME ?? "",
    // On pull_request GITHUB_SHA is a temporary merge commit; statuses and links belong on the PR's head commit
    sha: pr?.head?.sha ?? env.GITHUB_SHA,
    ref: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
    prNumber: Number.isFinite(prNumber) ? prNumber : undefined,
    baseRef: pr?.base?.ref ?? env.GITHUB_BASE_REF,
    runUrl: env.GITHUB_RUN_ID ? `${serverUrl}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined,
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
  };
}

export function triggerFrom(eventName: string, afterDeploy = false): RunTrigger {
  if (afterDeploy || eventName === "deployment_status" || eventName === "deployment") return "deploy";
  if (eventName === "pull_request" || eventName === "pull_request_target" || eventName === "merge_group") return "pr";
  if (eventName === "schedule") return "schedule";
  if (eventName === "push") return "push";
  return "manual";
}

export const gitInfo = (g: GithubContext) => ({
  sha: g.sha,
  ref: g.ref,
  pr: g.prNumber ? String(g.prNumber) : undefined,
  repo: g.repo,
  ciUrl: g.runUrl,
});

// ── Annotations ──────────────────────────────────────────────────────────────

const escData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s: string) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/**
 * Workflow commands that put findings on the code. Findings with a source file get
 * file/line (shown inline in the PR diff); others are listed on the job.
 * Blocking findings are errors, the rest warnings. Baseline (known) findings are skipped.
 */
export function annotations(s: RunSummary, opts: { backendDir: string; workspace: string; max?: number }): string[] {
  const findings = s.results.flatMap((r) => r.findings).filter((f) => !f.known);
  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return findings.slice(0, opts.max ?? 50).map((f) => annotation(f, s.gate.failOn, opts));
}

function annotation(f: Finding, failOn: Severity, opts: { backendDir: string; workspace: string }) {
  const level = severityRank(f.severity) <= severityRank(failOn) ? "error" : "warning";
  const props = [`title=${escProp(`QA ${f.severity}: ${f.title}`.slice(0, 200))}`];
  if (f.evidence?.file) {
    const file = path.relative(opts.workspace, path.resolve(opts.backendDir, f.evidence.file)).replace(/\\/g, "/");
    if (!file.startsWith("..")) {
      props.unshift(`file=${escProp(file)}`);
      if (f.evidence.line) props.splice(1, 0, `line=${f.evidence.line}`);
    }
  }
  const msg = [f.target, f.detail, f.fingerprint ? `fingerprint ${f.fingerprint} (${f.plugin})` : f.plugin].filter(Boolean).join("\n");
  return `::${level} ${props.join(",")}::${escData(msg)}`;
}

// ── Summary, outputs, comment, status ────────────────────────────────────────

export function prCommentBody(summaryMd: string, links: { runUrl?: string | null; ciUrl?: string }) {
  const parts = [summaryMd.trimEnd().replace(/\nFull report: `report\.html` in the run artifacts\.$/, "")];
  const l: string[] = [];
  if (links.runUrl) l.push(`[Open this run on the QA platform](${links.runUrl})`);
  if (links.ciUrl) l.push(`[Job log and report artifact](${links.ciUrl})`);
  if (l.length) parts.push(`\n${l.join(" · ")}`);
  return parts.join("\n") + "\n";
}

export function appendFileEnv(envVar: "GITHUB_STEP_SUMMARY" | "GITHUB_OUTPUT", text: string, env: NodeJS.ProcessEnv = process.env) {
  const f = env[envVar];
  if (!f) return false;
  fs.appendFileSync(f, text.endsWith("\n") ? text : text + "\n");
  return true;
}

export function writeOutputs(values: Record<string, string | number | null | undefined>, env: NodeJS.ProcessEnv = process.env) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v ?? ""}`);
  return appendFileEnv("GITHUB_OUTPUT", lines.join("\n"), env);
}

type FetchLike = typeof fetch;

async function gh(g: GithubContext, token: string, method: string, p: string, body?: unknown, f: FetchLike = fetch) {
  const res = await f(`${g.apiUrl}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "qa-agent",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 404 ? " (does the workflow grant this permission? see the action's README)" : "";
    throw new Error(`GitHub ${method} ${p} → ${res.status}: ${json?.message ?? text.slice(0, 160)}${hint}`);
  }
  return json;
}

/** Create the PR comment, or update the one this agent posted before. Returns what happened. */
export async function upsertPrComment(g: GithubContext, token: string, body: string, f: FetchLike = fetch): Promise<"created" | "updated"> {
  if (!g.prNumber) throw new Error("not a pull request");
  const marked = body.includes(COMMENT_MARKER) ? body : `${COMMENT_MARKER}\n${body}`;
  for (let page = 1; page <= 10; page++) {
    const comments: Array<{ id: number; body?: string }> = await gh(g, token, "GET", `/repos/${g.repo}/issues/${g.prNumber}/comments?per_page=100&page=${page}`, undefined, f);
    const mine = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    if (mine) {
      await gh(g, token, "PATCH", `/repos/${g.repo}/issues/comments/${mine.id}`, { body: marked }, f);
      return "updated";
    }
    if (comments.length < 100) break;
  }
  await gh(g, token, "POST", `/repos/${g.repo}/issues/${g.prNumber}/comments`, { body: marked }, f);
  return "created";
}

export async function setCommitStatus(
  g: GithubContext,
  token: string,
  s: { state: "success" | "failure" | "error"; description: string; targetUrl?: string | null; context?: string },
  f: FetchLike = fetch,
) {
  if (!g.sha) throw new Error("no commit sha");
  await gh(g, token, "POST", `/repos/${g.repo}/statuses/${g.sha}`, {
    state: s.state,
    description: s.description.slice(0, 140),
    context: s.context ?? "QA gate",
    ...(s.targetUrl ? { target_url: s.targetUrl } : {}),
  }, f);
}

export function statusFor(s: RunSummary): { state: "success" | "failure" | "error"; description: string } {
  if (s.gate.envError) return { state: "error", description: `Environment problem: ${s.gate.envError}` };
  if (s.gate.passed) return { state: "success", description: `Passed · ${s.suite} suite · no new ${s.gate.failOn}+ findings` };
  return { state: "failure", description: `${s.gate.blocking} new finding(s) at ${s.gate.failOn} or above · ${s.suite} suite` };
}
