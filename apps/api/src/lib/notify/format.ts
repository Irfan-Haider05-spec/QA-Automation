/** One notification, three shapes: Slack blocks, an email, a webhook body */
import type { NotifyPayload } from "./events.js";

const TITLE: Record<NotifyPayload["event"], string> = {
  "run.failed": "QA gate failed",
  "run.recovered": "QA gate passing again",
  "run.env_error": "QA couldn't reach the environment",
  "issue.regression": "Fixed issues came back",
  "job.error": "Hosted QA run couldn't run",
};
const EMOJI: Record<NotifyPayload["event"], string> = { "run.failed": ":red_circle:", "run.recovered": ":large_green_circle:", "run.env_error": ":large_orange_circle:", "issue.regression": ":repeat:", "job.error": ":warning:" };

export function headline(p: NotifyPayload) {
  return `${p.test ? "[Test] " : ""}${TITLE[p.event]}: ${p.project.name}${p.environment ? ` (${p.environment})` : ""}`;
}

/** One sentence of what happened */
export function summary(p: NotifyPayload): string {
  const r = p.run;
  switch (p.event) {
    case "run.failed": return `${r!.blocking} blocking finding(s) in the ${r!.suite} suite · ${r!.newIssues} new issue(s)${r!.reopenedIssues ? `, ${r!.reopenedIssues} came back` : ""}.`;
    case "run.recovered": return `The ${r!.suite} suite passes again${r!.fixedIssues ? ` · ${r!.fixedIssues} issue(s) fixed` : ""}.`;
    case "run.env_error": return `The ${r!.suite} suite stopped: ${r!.envError ?? "the target didn't answer"}.`;
    case "issue.regression": return `${r!.reopenedIssues} issue(s) marked fixed were found again in the ${r!.suite} suite.`;
    case "job.error": return `The ${p.job!.suite} run didn't start or finish: ${p.job!.error}`;
  }
}

function origin(p: NotifyPayload) {
  const r = p.run;
  if (!r) return "Hosted runner";
  const parts = [r.trigger === "pr" && r.git?.pr ? `PR #${r.git.pr}` : r.trigger ?? r.source, r.git?.ref, r.git?.sha?.slice(0, 7)].filter(Boolean);
  return parts.join(" · ");
}

export function slackMessage(p: NotifyPayload) {
  const blocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: `${EMOJI[p.event]} *${headline(p)}*\n${summary(p)}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `${p.org.name} · ${origin(p)}` }] },
  ];
  if (p.issues?.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: p.issues.map((i) => `• *${i.severity}* ${i.url ? `<${i.url}|${esc(i.title)}>` : esc(i.title)}  \`${esc(i.target)}\``).join("\n") } });
  }
  if (p.run?.url) blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open run" }, url: p.run.url }] });
  return { text: `${headline(p)}: ${summary(p)}`, blocks };
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = (s: string) => esc(s).replace(/"/g, "&quot;");

export function emailMessage(p: NotifyPayload) {
  const lines = [summary(p), "", `${p.org.name} · ${origin(p)}`];
  if (p.issues?.length) lines.push("", ...p.issues.map((i) => `- [${i.severity}] ${i.title} (${i.target})${i.url ? ` ${i.url}` : ""}`));
  if (p.run?.url) lines.push("", `Open the run: ${p.run.url}`);
  const color = p.event === "run.recovered" ? "#1f8a4c" : p.event === "run.failed" || p.event === "issue.regression" ? "#c0352b" : "#b45309";
  const body = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6fa;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#141b2d">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #dfe3eb;border-radius:8px;border-left:4px solid ${color}">
<tr><td style="padding:20px 24px">
<h1 style="margin:0 0 8px;font-size:18px">${html(headline(p))}</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${html(summary(p))}</p>
<p style="margin:0 0 16px;font-size:13px;color:#5a6478">${html(`${p.org.name} · ${origin(p)}`)}</p>
${p.issues?.length ? `<ul style="margin:0 0 16px;padding-left:18px;font-size:14px;line-height:1.6">${p.issues.map((i) => `<li><b>${html(i.severity)}</b> ${i.url ? `<a href="${html(i.url)}" style="color:#2747d6">${html(i.title)}</a>` : html(i.title)} <code style="font-size:12px;color:#5a6478">${html(i.target)}</code></li>`).join("")}</ul>` : ""}
${p.run?.url ? `<a href="${html(p.run.url)}" style="display:inline-block;background:#2747d6;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:14px">Open run</a>` : ""}
</td></tr></table>
<p style="max-width:560px;margin:12px auto 0;font-size:12px;color:#5a6478">You get this because a QA notification channel in ${html(p.org.name)} includes this address.</p>
</body></html>`;
  return { subject: headline(p), text: lines.join("\n"), html: body };
}

export const webhookBody = (p: NotifyPayload, deliveryId: string) => ({ id: deliveryId, ...p, headline: headline(p), summary: summary(p) });
