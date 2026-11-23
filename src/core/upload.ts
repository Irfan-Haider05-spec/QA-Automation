/**
 * Talking to the QA platform with a project API key:
 *
 * - uploadRun: POST /api/v1/runner/runs. The platform turns findings into issues,
 *   tracks fixes and regressions across runs, and shows the run on the dashboard.
 * - reportDeployment: POST /api/v1/runner/deployments, before a post-deploy run,
 *   so the run is linked to the version it checked.
 * - fetchAccounts: test-account logins stored in the platform's vault, for keys
 *   with the credentials:read permission. Fills config.accounts so CI needs no
 *   copy of the passwords.
 */
import type { RunSummary } from "./report.js";
import type { AccountConfig } from "./config.js";
import type { ProjectProfile } from "./profile.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readBoundedText } from "@qa/shared/http";

export interface PlatformOptions {
  url: string;
  apiKey: string;
}

export interface UploadOptions extends PlatformOptions {
  environmentId?: string;
  source?: "cli" | "ci" | "hosted";
  trigger?: "pr" | "push" | "deploy" | "schedule" | "manual";
  deploymentId?: string;
  profile?: ProjectProfile;
}

export interface UploadResult {
  runId: string;
  status: string;
  newIssues: number;
  fixedIssues: number;
  reopenedIssues: number;
  orgId: string;
  projectId: string;
  /** Link to the run on the dashboard (null if the platform has no APP_URL set) */
  runUrl: string | null;
}

async function call<T>(o: PlatformOptions, method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${o.url.replace(/\/+$/, "")}/api/v1${p}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${o.apiKey}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
    redirect: "error",
  });
  const text = await readBoundedText(res, 8 * 1024 * 1024);
  let json: any;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`platform answered ${res.status}: ${json?.error?.message ?? text.slice(0, 200)}`);
  return json as T;
}

/** The platform stores shorter text than a local report allows; the full text stays in report.json. */
const SHORTENED = "\n…[shortened; full text in report.json]";
const clip = (value: string | undefined, max: number) =>
  value === undefined || value.length <= max ? value : value.slice(0, max - SHORTENED.length) + SHORTENED;

/** Findings in the platform's upload shape: text within its limits, engine-only fields removed. */
export function uploadResults(summary: RunSummary) {
  return summary.results.map((r) => ({
    ...r,
    reason: clip(r.reason, 2000),
    findings: r.findings.map(({ key: _key, ...f }) => ({
      ...f, title: clip(f.title, 500)!, target: clip(f.target, 500)!, detail: clip(f.detail, 5000), remediation: clip(f.remediation, 5000),
    })),
  }));
}

export async function uploadRun(summary: RunSummary, o: UploadOptions): Promise<UploadResult> {
  const r = await call<UploadResult>(o, "POST", "/runner/runs", {
    ...summary,
    results: uploadResults(summary),
    target: summary.target ?? undefined,
    environmentId: o.environmentId,
    source: o.source ?? (process.env.GITHUB_ACTIONS === "true" ? "ci" : "cli"),
    trigger: o.trigger,
    deploymentId: o.deploymentId,
    profile: o.profile,
  });
  return { ...r, runUrl: r.runUrl ?? null };
}

/** Upload only report-linked screenshots and generated Lighthouse reports. Paths
 * are resolved on disk to reject both traversal and symlink escapes. */
export async function uploadArtifacts(summary: RunSummary, outDir: string, runId: string, o: PlatformOptions): Promise<number> {
  return sendArtifacts(summary, outDir, (payload) => call(o, "POST", `/runner/runs/${encodeURIComponent(runId)}/artifacts`, payload));
}

export interface ArtifactPayload { name: string; sha256: string; data: string }
export async function sendArtifacts(summary: RunSummary, outDir: string, send: (payload: ArtifactPayload) => Promise<unknown>): Promise<number> {
  const root = fs.realpathSync(outDir);
  const names = new Set(summary.results.flatMap((r) => r.findings.flatMap((f) => f.evidence?.image ? [f.evidence.image.replace(/\\/g, "/")] : [])));
  const lighthouse = path.join(root, "lighthouse");
  if (fs.existsSync(lighthouse)) for (const file of fs.readdirSync(lighthouse)) if (/^[a-zA-Z0-9_.-]+\.html$/.test(file)) names.add(`lighthouse/${file}`);
  if (names.size > 100) throw new Error("More than 100 evidence files; keep the full CI artifact and reduce page/flow limits");
  const payloads = [...names].map((name) => {
    if (path.isAbsolute(name) || name.split("/").some((s) => s === ".." || s === "." || !s) || !/\.(png|jpe?g|webp|html)$/i.test(name)) throw new Error("Unsafe evidence path");
    const file = fs.realpathSync(path.resolve(root, name));
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Evidence file escapes the report directory");
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > 5242880) throw new Error("Evidence file must be between 1 byte and 5 MiB");
    return { name, file };
  });
  let uploaded = 0;
  for (const { name, file } of payloads) {
    const data = fs.readFileSync(file);
    await send({ name, sha256: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") });
    uploaded++;
  }
  return uploaded;
}

export async function reportDeployment(
  o: PlatformOptions,
  d: { environmentId?: string; sha?: string; ref?: string; version?: string; url?: string; description?: string },
): Promise<{ id: string }> {
  const r = await call<{ deployment: { id: string } }>(o, "POST", "/runner/deployments", { ...d, source: process.env.GITHUB_ACTIONS === "true" ? "ci" : "cli" });
  return r.deployment;
}

export interface PlatformAccount { name: string; role: string; identifier: string; device: string | null; secret: string }

export async function fetchAccounts(o: PlatformOptions, environmentId: string): Promise<PlatformAccount[]> {
  const r = await call<{ credentials: PlatformAccount[] }>(o, "GET", `/runner/environments/${environmentId}/credentials`);
  return r.credentials;
}

/**
 * Merge platform accounts into the config. Values already set in the config
 * (usually from env vars) win; accounts the config doesn't mention are added.
 * Returns the names that received a login from the platform.
 */
export function mergeAccounts(accounts: Record<string, AccountConfig>, fromPlatform: PlatformAccount[]): string[] {
  const filled: string[] = [];
  for (const p of fromPlatform) {
    const cur = accounts[p.name];
    if (!cur) {
      accounts[p.name] = { identifier: p.identifier, password: p.secret, role: p.role, device: p.device ?? "" };
      filled.push(p.name);
      continue;
    }
    let used = false;
    if (!cur.identifier) { cur.identifier = p.identifier; used = true; }
    if (!cur.password) { cur.password = p.secret; used = true; }
    if (!cur.device && p.device) cur.device = p.device;
    if (used) filled.push(p.name);
  }
  return filled;
}
