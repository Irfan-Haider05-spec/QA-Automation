/**
 * Delivering one message to one channel. Throws with a readable reason on
 * failure; the dispatcher decides about retries.
 *
 * Webhooks are signed: X-QA-Signature = "sha256=" + HMAC-SHA256(signingSecret, `${timestamp}.${body}`),
 * with the timestamp in X-QA-Timestamp, so receivers can check origin and freshness.
 */
import crypto from "node:crypto";
import { mailer } from "../mail.js";
import type { Config } from "../../config.js";
import { assertOutboundUrl } from "../outbound.js";
import { emailMessage, slackMessage, webhookBody } from "./format.js";
import type { NotifyPayload } from "./events.js";

export interface ChannelForSend {
  kind: "slack" | "email" | "webhook";
  recipients: string[] | null;
  /** Decrypted secret_blob */
  secret: { url: string; signingSecret?: string } | null;
}


async function post(url: string, body: string, headers: Record<string, string>, allowPrivate: boolean, slack = false) {
  await assertOutboundUrl(url, { allowPrivate, slack });
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "QA-Platform-Notifier/1", ...headers }, body, redirect: "manual", signal: AbortSignal.timeout(10000) });
  } catch (e: any) {
    throw new Error(`Couldn't connect: ${e?.cause?.code ?? e?.message ?? e}`);
  }
  if (res.status >= 300) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`${res.status >= 300 && res.status < 400 ? "Redirects aren't followed" : "Answered"} ${res.status}${text ? `: ${text}` : ""}`);
  }
}

export async function sendNotification(c: ChannelForSend, p: NotifyPayload, deliveryId: string, config: Pick<Config, "SMTP_URL" | "MAIL_FROM" | "ALLOW_PRIVATE_WEBHOOKS">) {
  if (c.kind === "slack") {
    return post(c.secret!.url, JSON.stringify(slackMessage(p)), {}, config.ALLOW_PRIVATE_WEBHOOKS, true);
  }
  if (c.kind === "webhook") {
    const body = JSON.stringify(webhookBody(p, deliveryId));
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac("sha256", c.secret!.signingSecret ?? "").update(`${ts}.${body}`).digest("hex");
    return post(c.secret!.url, body, { "x-qa-event": p.event, "x-qa-delivery": deliveryId, "x-qa-timestamp": ts, "x-qa-signature": `sha256=${sig}` }, config.ALLOW_PRIVATE_WEBHOOKS);
  }
  if (!config.SMTP_URL) throw new Error("Email isn't set up on this platform (SMTP_URL)");
  const m = emailMessage(p);
  try {
    await mailer(config.SMTP_URL).sendMail({ from: config.MAIL_FROM, to: c.recipients!, subject: m.subject, text: m.text, html: m.html });
  } catch (e: any) {
    throw new Error(`Mail server refused: ${e?.response ?? e?.message ?? e}`);
  }
}
