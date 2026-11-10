/**
 * Outgoing email (SMTP_URL). One shared transport; account emails and email
 * notification channels both send through here.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "../config.js";

let transport: { url: string; t: Transporter } | null = null;
export const mailer = (url: string) => {
  if (transport?.url !== url) transport = { url, t: nodemailer.createTransport(url) };
  return transport.t;
};

export interface Mail { to: string | string[]; subject: string; text: string; html?: string }

export async function sendMail(config: Pick<Config, "SMTP_URL" | "MAIL_FROM">, m: Mail) {
  if (!config.SMTP_URL) throw new Error("SMTP_URL is not set");
  await mailer(config.SMTP_URL).sendMail({ from: config.MAIL_FROM, to: m.to, subject: m.subject, text: m.text, html: m.html });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A short transactional email with one button */
export function actionMail(o: { to: string; subject: string; greeting: string; lines: string[]; button: string; url: string; footer: string }): Mail {
  const text = [o.greeting, "", ...o.lines, "", `${o.button}: ${o.url}`, "", o.footer].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2937;max-width:520px;margin:24px auto;padding:0 16px">
<p>${esc(o.greeting)}</p>${o.lines.map((l) => `<p>${esc(l)}</p>`).join("")}
<p style="margin:28px 0"><a href="${esc(o.url)}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">${esc(o.button)}</a></p>
<p style="font-size:13px;color:#6b7280">If the button doesn't work, paste this link into your browser:<br>${esc(o.url)}</p>
<p style="font-size:13px;color:#6b7280">${esc(o.footer)}</p></body></html>`;
  return { to: o.to, subject: o.subject, text, html };
}
