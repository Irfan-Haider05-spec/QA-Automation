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
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`platform answered ${res.status}: ${json?.error?.message ?? text.slice(0, 200)}`);
  return json as T;
}

export async function uploadRun(summary: RunSummary, o: UploadOptions): Promise<UploadResult> {
  const r = await call<UploadResult>(o, "POST", "/runner/runs", {
    ...summary,
    target: summary.target ?? undefined,
    environmentId: o.environmentId,
    source: o.source ?? (process.env.GITHUB_ACTIONS === "true" ? "ci" : "cli"),
    trigger: o.trigger,
    deploymentId: o.deploymentId,
    profile: o.profile,
  });
  return { ...r, runUrl: r.runUrl ?? null };
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
