/**
 * The notification dispatcher: sends queued deliveries, retrying failures with
 * backoff (1 min, 5 min, 30 min, 2 h) and giving up after 5 attempts. Safe with
 * several API instances (deliveries are claimed with SKIP LOCKED).
 */
import type { Db } from "../../db/index.js";
import { withContext } from "../../db/index.js";
import type { Config } from "../../config.js";
import type { Vault } from "../crypto.js";
import type { NotifyPayload } from "./events.js";
import { sendNotification } from "./send.js";

export const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 5, 30, 120];

interface DeliveryRow { id: string; org_id: string; channel_id: string; payload: NotifyPayload; attempts: number }

export async function dispatchTick(db: Db, vault: Vault, config: Pick<Config, "SMTP_URL" | "MAIL_FROM" | "ALLOW_PRIVATE_WEBHOOKS">, limit = 20) {
  const due = await withContext(db, {}, (q) => q<DeliveryRow>("select * from qa_claim_deliveries($1)", [limit]));
  let sent = 0;
  let failed = 0;
  await Promise.all(due.map(async (d) => {
    const channel = await withContext(db, { orgId: d.org_id }, async (q) => {
      const [c] = await q<{ id: string; kind: "slack" | "email" | "webhook"; recipients: string[] | null; secret_blob: string | null; enabled: boolean }>(
        "select id, kind, recipients, secret_blob, enabled from notification_channels where id = $1",
        [d.channel_id],
      );
      return c;
    });
    let error: string | null = null;
    if (!channel?.enabled) error = "Channel turned off";
    else {
      try {
        const secret = channel.secret_blob ? JSON.parse(vault.decrypt(channel.secret_blob, `${d.org_id}:${channel.id}`)) : null;
        await sendNotification({ kind: channel.kind, recipients: channel.recipients, secret }, d.payload, d.id, config);
      } catch (e: any) {
        error = String(e?.message ?? e).slice(0, 500);
      }
    }
    await withContext(db, { orgId: d.org_id }, async (q) => {
      if (!error) {
        sent++;
        await q("update notification_deliveries set status = 'sent', sent_at = now(), last_error = null where id = $1", [d.id]);
        await q("update notification_channels set last_delivery_at = now(), last_error = null where id = $1", [d.channel_id]);
        return;
      }
      const giveUp = d.attempts >= MAX_ATTEMPTS || error === "Channel turned off";
      if (giveUp) failed++;
      await q(
        `update notification_deliveries set status = $2, last_error = $3, next_attempt_at = now() + make_interval(mins => $4) where id = $1`,
        [d.id, giveUp ? "failed" : "queued", error, BACKOFF_MIN[Math.min(d.attempts - 1, BACKOFF_MIN.length - 1)]],
      );
      if (channel) await q("update notification_channels set last_error = $2 where id = $1", [d.channel_id, error]);
    });
  }));
  return { claimed: due.length, sent, failed };
}

export function startDispatcher(db: Db, vault: Vault, config: Config, log: (m: string) => void = console.log) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await dispatchTick(db, vault, config);
      if (r.claimed) log(`notifications: ${r.sent} sent, ${r.failed} failed, ${r.claimed - r.sent - r.failed} to retry`);
    } catch (e: any) {
      log(`notifications error: ${e?.message ?? e}`);
    } finally {
      running = false;
    }
  }, config.NOTIFY_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
