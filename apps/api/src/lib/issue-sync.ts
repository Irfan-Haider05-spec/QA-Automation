import { readBoundedText } from "@qa/shared/http";
import { withContext, type Db } from "../db/index.js";
import type { Config } from "../config.js";

type SyncConfig = Pick<Config, "ISSUE_GATEWAY_URL" | "ISSUE_GATEWAY_TOKEN">;
export type IssueTransport = (payload: Record<string, unknown>, deliveryId: string) => Promise<{ url: string }>;
export function issueTransport(config: SyncConfig): IssueTransport {
  return async (payload, deliveryId) => {
    const response = await fetch(config.ISSUE_GATEWAY_URL!, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${config.ISSUE_GATEWAY_TOKEN}`, "content-type": "application/json", "idempotency-key": deliveryId }, body: JSON.stringify(payload) });
    const text = await readBoundedText(response, 20000);
    if (!response.ok) throw new Error("Issue gateway rejected delivery");
    const result = JSON.parse(text);
    return { url: result.url };
  };
}
export async function issueSyncTick(db: Db, config: SyncConfig, send = issueTransport(config)) {
  if (!config.ISSUE_GATEWAY_URL || !config.ISSUE_GATEWAY_TOKEN) return { sent: 0, failed: 0 };
  const jobs = await withContext(db, {}, (q) => q("select * from qa_claim_issue_sync(10)"));
  let sent = 0, failed = 0;
  for (const job of jobs) {
    let remoteUrl: string | null = null;
    try {
      const [active] = await withContext(db, { orgId: job.org_id }, (q) => q("select 1 from issue_integrations where project_id = $1 and destination = $2 and enabled", [job.project_id, job.destination]));
      if (!active) throw new Error("Integration disabled or changed");
      const result = await send({ version: 1, orgId: job.org_id, projectId: job.project_id, issueId: job.issue_id, destination: job.destination, issue: job.payload }, job.id);
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2000) throw new Error("Invalid issue URL");
      remoteUrl = url.href;
    } catch { /* Never persist provider bodies, URLs with secrets or network internals. */ }
    await withContext(db, { orgId: job.org_id }, (q) => q("update issue_sync_jobs set status=$2, remote_url=$3, last_error=$4, next_attempt_at=now()+make_interval(mins=>$5) where id=$1 and status='sending' and attempts=$6", [job.id, remoteUrl ? "sent" : job.attempts >= 5 ? "failed" : "queued", remoteUrl, remoteUrl ? null : "Issue delivery failed; check integration configuration", Math.min(120, 2 ** job.attempts), job.attempts]));
    if (remoteUrl) sent++; else failed++;
  }
  return { sent, failed };
}
export function startIssueSync(db: Db, config: SyncConfig) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await issueSyncTick(db, config); } catch { console.error("[issue-sync] Delivery tick failed"); }
    finally { running = false; }
  }, 15000);
  timer.unref();
  return () => clearInterval(timer);
}
