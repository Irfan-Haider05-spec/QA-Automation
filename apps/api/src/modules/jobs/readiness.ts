/**
 * Can the hosted runner test this environment, and with which checks?
 * Shared by "Run now", schedules and the dashboard's status endpoint, so the
 * UI shows exactly the reasons the API would give.
 */
import type { Query } from "../../db/index.js";

export interface Readiness {
  canRun: boolean;
  api: boolean;
  web: boolean;
  /** Plain-language reasons the run can't start or will be limited */
  reasons: string[];
}

export async function readiness(q: Query, projectId: string, env: { id: string; name: string; verified_at: Date | null; api_base_url: string | null; web_apps: unknown[] | null }): Promise<Readiness> {
  const [profile] = await q<{ routes_count: number }>("select routes_count from project_profiles where project_id = $1", [projectId]);
  const [{ n: accounts }] = await q<{ n: number }>("select count(*)::int as n from credentials where environment_id = $1", [env.id]);
  const reasons: string[] = [];
  const verified = !!env.verified_at;
  if (!verified) reasons.push(`Verify the domain of ${env.name} first: hosted runs only test sites you've proven you control.`);
  const api = !!env.api_base_url && !!profile;
  if (env.api_base_url && !profile) reasons.push("API checks need the route list: let CI send one run to the platform first (the CI setup tab has the workflow).");
  if (!env.api_base_url) reasons.push(`${env.name} has no API URL, so only dashboards can be checked.`);
  const web = (env.web_apps ?? []).length > 0;
  if ((api || web) && accounts === 0) reasons.push("No test accounts on this environment: only checks that need no login will run.");
  if (!api && !web) reasons.push("Nothing to test yet: add an API URL (and run CI once) or a dashboard to this environment.");
  return { canRun: verified && (api || web), api, web, reasons };
}
