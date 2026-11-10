/**
 * Notifications: channel rules and secrecy, which runs notify whom, Slack /
 * signed webhook / email delivery, retries with backoff, test messages, and the
 * address checks that stop the platform from calling internal services.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { startApi, signup, addMember, sampleRun, type TestApi } from "./helpers.js";
import { dispatchTick, MAX_ATTEMPTS } from "../src/lib/notify/dispatch.js";
import { Vault } from "../src/lib/crypto.js";
import { isPrivateAddress } from "../src/lib/outbound.js";

interface Hit { path: string; headers: http.IncomingHttpHeaders; body: string }
const hits: Hit[] = [];
let receiver: http.Server;
let recvUrl = "";
const mails: Array<{ to: string[]; data: string }> = [];
let smtp: SMTPServer;
let smtpPort = 0;

let api: TestApi;
let vault: Vault;
let o: Awaited<ReturnType<typeof signup>>;
let p1: string;
let p2: string;
let key1: string;
let key2: string;
const ch = (path = "") => `/orgs/${o.orgId}/notifications${path}`;
const tick = () => dispatchTick(api.db, vault, { SMTP_URL: `smtp://127.0.0.1:${smtpPort}`, MAIL_FROM: "QA <qa@test.invalid>", ALLOW_PRIVATE_WEBHOOKS: true });
const upload = (key: string, body: object) => api.call("POST", "/runner/runs", { token: key, body });
const since = (n: number) => hits.slice(n);

before(async () => {
  receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ path: req.url!, headers: req.headers, body });
      if (req.url === "/fail") { res.writeHead(500); res.end("upstream down"); return; }
      if (req.url === "/redirect") { res.writeHead(302, { location: "http://169.254.169.254/" }); res.end(); return; }
      res.writeHead(200); res.end("ok");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
  recvUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  smtp = new SMTPServer({
    authOptional: true, disabledCommands: ["STARTTLS"],
    onData(stream, session, cb) {
      let data = "";
      stream.on("data", (c) => (data += c));
      stream.on("end", () => { mails.push({ to: session.envelope.rcptTo.map((r) => r.address), data }); cb(); });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
  smtpPort = (smtp.server.address() as AddressInfo).port;

  api = await startApi({ ALLOW_PRIVATE_WEBHOOKS: "true", APP_URL: "https://qa.example.com", SMTP_URL: `smtp://127.0.0.1:${smtpPort}` });
  vault = new Vault(api.vaultKey);
  o = await signup(api, "notify");
  p1 = (await api.call("POST", `/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Shop API" } })).body.project.id;
  p2 = (await api.call("POST", `/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Blog" } })).body.project.id;
  key1 = (await api.call("POST", `/orgs/${o.orgId}/projects/${p1}/api-keys`, { token: o.token, body: { name: "ci" } })).body.key;
  key2 = (await api.call("POST", `/orgs/${o.orgId}/projects/${p2}/api-keys`, { token: o.token, body: { name: "ci" } })).body.key;
});
after(async () => {
  await api.close();
  receiver.close();
  await new Promise<void>((r) => smtp.close(() => r()));
});

let slackId = "";
let hookId = "";
let signingSecret = "";

test("channels: create Slack, webhook and email; secrets are never returned", async () => {
  const s = await api.call("POST", ch(), { token: o.token, body: { name: "#qa-alerts", kind: "slack", url: `${recvUrl}/slack/T000/B000/abcd1234`, events: ["run.failed", "run.recovered", "run.failed"] } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.deepEqual(s.body.channel.events, ["run.failed", "run.recovered"]);
  assert.match(s.body.channel.targetHint, /…1234$/);
  slackId = s.body.channel.id;

  const w = await api.call("POST", ch(), { token: o.token, body: { name: "Ops webhook", kind: "webhook", url: `${recvUrl}/hook`, events: ["run.failed", "issue.regression", "job.error"], projectIds: [p1] } });
  assert.equal(w.status, 201);
  assert.match(w.body.signingSecret, /^whsec_/);
  signingSecret = w.body.signingSecret;
  hookId = w.body.channel.id;

  const e = await api.call("POST", ch(), { token: o.token, body: { name: "Client PM", kind: "email", recipients: ["PM@Client.test", "lead@client.test"], events: ["run.failed", "run.env_error"] } });
  assert.equal(e.status, 201);
  assert.deepEqual(e.body.channel.recipients, ["pm@client.test", "lead@client.test"]);

  const list = await api.call("GET", ch(), { token: o.token });
  assert.equal(list.body.channels.length, 3);
  assert.equal(list.body.emailAvailable, true);
  const text = JSON.stringify(list.body);
  assert.equal(text.includes("/slack/T000") || text.includes(signingSecret) || text.includes("secret_blob"), false);
  const audit = JSON.stringify((await api.call("GET", `/orgs/${o.orgId}/audit`, { token: o.token })).body);
  assert.equal(audit.includes("/slack/T000") || audit.includes(signingSecret), false);
});

test("channels: validation and permissions", async () => {
  const bad = (body: object) => api.call("POST", ch(), { token: o.token, body: { name: "x", events: ["run.failed"], ...body } });
  assert.equal((await bad({ kind: "slack" })).status, 422);
  assert.equal((await bad({ kind: "webhook", url: "not a url" })).status, 400);
  assert.equal((await bad({ kind: "webhook", url: "ftp://example.com/x" })).status, 400);
  assert.equal((await bad({ kind: "webhook", url: "https://user:pw@example.com/x" })).status, 400);
  assert.equal((await bad({ kind: "email", recipients: [] })).status, 400);
  assert.equal((await bad({ kind: "slack", url: `${recvUrl}/s`, events: [] })).status, 400);
  assert.equal((await bad({ kind: "slack", url: `${recvUrl}/s`, events: ["run.started"] })).status, 400);
  assert.equal((await bad({ kind: "webhook", url: `${recvUrl}/x`, projectIds: ["00000000-0000-4000-8000-000000000000"] })).status, 404);
  const dev = await addMember(api, o, "developer");
  assert.equal((await api.call("POST", ch(), { token: dev.token, body: { name: "x", kind: "slack", url: `${recvUrl}/s`, events: ["run.failed"] } })).status, 403);
  assert.equal((await api.call("GET", ch(), { token: dev.token })).status, 200);
  assert.equal((await api.call("DELETE", ch(`/${slackId}`), { token: dev.token })).status, 403);
  const other = await signup(api, "other");
  assert.equal((await api.call("GET", ch(), { token: other.token })).status, 404);
});

test("outbound address rules (production settings)", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
  const prod = await startApi({ SMTP_URL: "" });
  try {
    const u = await signup(prod, "prod");
    const post = (body: object) => prod.call("POST", `/orgs/${u.orgId}/notifications`, { token: u.token, body: { name: "x", events: ["run.failed"], ...body } });
    assert.match((await post({ kind: "webhook", url: "http://example.com/hook" })).body.error.message, /https/);
    assert.match((await post({ kind: "webhook", url: "https://127.0.0.1/hook" })).body.error.message, /private or local/);
    assert.match((await post({ kind: "webhook", url: "https://169.254.169.254/latest/meta-data" })).body.error.message, /private or local/);
    assert.match((await post({ kind: "webhook", url: "https://[::1]/x" })).body.error.message, /private or local/);
    assert.match((await post({ kind: "slack", url: "https://example.com/hooks/x" })).body.error.message, /hooks\.slack\.com/);
    const mail = await post({ kind: "email", recipients: ["a@b.test"] });
    assert.equal(mail.status, 422);
    assert.match(mail.body.error.message, /Email isn't set up/);
    assert.equal((await prod.call("GET", `/orgs/${u.orgId}/notifications`, { token: u.token })).body.emailAvailable, false);
  } finally { await prod.close(); }
});

test("a failed run notifies the matching channels: Slack, signed webhook, email", async () => {
  const before = hits.length;
  const r = await upload(key1, { ...sampleRun([{ fp: "notify-c1", severity: "critical" }, { fp: "notify-h1" }]), environmentId: undefined, git: { ref: "main", sha: "abcdef1234" } });
  assert.equal(r.status, 201);
  assert.equal(r.body.newIssueIds, undefined, "internal ids aren't part of the upload response");
  // Blog (p2) failing: only Slack and email (the webhook is limited to Shop API)
  await upload(key2, sampleRun([{ fp: "blog-1" }]));
  const t = await tick();
  assert.equal(t.sent, 5, JSON.stringify(t));

  const slack = since(before).filter((h) => h.path.startsWith("/slack"));
  assert.equal(slack.length, 2);
  const msg = JSON.parse(slack.find((h) => h.body.includes("Shop API"))!.body);
  assert.match(msg.text, /QA gate failed: Shop API/);
  assert.match(JSON.stringify(msg.blocks), /\*critical\*/);
  assert.equal(msg.blocks.at(-1).elements[0].url, `https://qa.example.com/o/${o.orgId}/projects/${p1}/runs/${r.body.runId}`);

  const hook = since(before).filter((h) => h.path === "/hook");
  assert.equal(hook.length, 1);
  const h = hook[0];
  const expected = crypto.createHmac("sha256", signingSecret).update(`${h.headers["x-qa-timestamp"]}.${h.body}`).digest("hex");
  assert.equal(h.headers["x-qa-signature"], `sha256=${expected}`);
  assert.equal(h.headers["x-qa-event"], "run.failed");
  const body = JSON.parse(h.body);
  assert.equal(body.project.name, "Shop API");
  assert.equal(body.run.blocking, 2);
  assert.equal(body.issues[0].severity, "critical");
  assert.match(body.issues[0].url, /\/issues\//);
  assert.equal(JSON.stringify(body).includes("curl"), false, "no raw evidence in notifications");

  // Account emails (sign-up confirmations) go through the same SMTP server: count alerts only
  const alerts = mails.filter((m) => !/Subject: (Confirm your email address|Reset your password)/.test(m.data));
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts[0].to.sort(), ["lead@client.test", "pm@client.test"]);
  assert.match(alerts[0].data, /Subject: QA gate failed: (Shop API|Blog)/);
  // Delivered → listed as sent, channel shows the time
  const d = (await api.call("GET", ch(`/${slackId}/deliveries`), { token: o.token })).body.deliveries;
  assert.ok(d.every((x: any) => x.status === "sent"));
  assert.ok((await api.call("GET", ch(), { token: o.token })).body.channels.find((c: any) => c.id === slackId).lastDeliveryAt);
});

test("recovery and regressions; local runs stay quiet unless asked", async () => {
  let n = hits.length;
  await upload(key1, sampleRun([]));
  await tick();
  const rec = since(n).filter((h) => h.path.startsWith("/slack"));
  assert.equal(rec.length, 1);
  assert.match(JSON.parse(rec[0].body).text, /passing again: Shop API/);
  assert.match(JSON.parse(rec[0].body).text, /2 issue\(s\) fixed/);

  // A second passing run in a row is not news
  n = hits.length;
  await upload(key1, sampleRun([]));
  await tick();
  assert.equal(since(n).length, 0);

  // Fixed issue comes back: regression (webhook) + failed (Slack, webhook, email)
  n = hits.length;
  await upload(key1, sampleRun([{ fp: "notify-c1", severity: "critical" }]));
  await tick();
  const events = since(n).filter((h) => h.path === "/hook").map((h) => h.headers["x-qa-event"]).sort();
  assert.deepEqual(events, ["issue.regression", "run.failed"]);
  const reg = JSON.parse(since(n).find((h) => h.headers["x-qa-event"] === "issue.regression")!.body);
  assert.match(reg.summary, /1 issue\(s\) marked fixed were found again/);

  // A laptop run (source cli) doesn't notify anyone…
  n = hits.length;
  await upload(key1, { ...sampleRun([{ fp: "local-1" }]), source: "cli" });
  await tick();
  assert.equal(since(n).length, 0);
  // …unless the channel opts in
  await api.call("PATCH", ch(`/${slackId}`), { token: o.token, body: { includeLocal: true } });
  await upload(key1, { ...sampleRun([{ fp: "local-2" }]), source: "cli" });
  await tick();
  assert.equal(since(n).filter((h) => h.path.startsWith("/slack")).length, 1);
});

test("failed deliveries retry with backoff, then give up; a turned-off channel stops", async () => {
  const f = await api.call("POST", ch(), { token: o.token, body: { name: "Flaky", kind: "webhook", url: `${recvUrl}/fail`, events: ["run.failed"], projectIds: [p2] } });
  await upload(key2, sampleRun([{ fp: "blog-2" }]));
  const due = () => api.db.raw("update notification_deliveries set next_attempt_at = now() - interval '1 second' where channel_id = $1 and status = 'queued'", [f.body.channel.id]);
  await tick();
  let [d] = (await api.call("GET", ch(`/${f.body.channel.id}/deliveries`), { token: o.token })).body.deliveries;
  assert.equal(d.status, "queued");
  assert.equal(d.attempts, 1);
  assert.match(d.lastError, /Answered 500: upstream down/);
  assert.ok(new Date(d.nextAttemptAt).getTime() > Date.now() + 30_000, "next try about a minute later");
  for (let i = 2; i <= MAX_ATTEMPTS; i++) { await due(); await tick(); }
  [d] = (await api.call("GET", ch(`/${f.body.channel.id}/deliveries`), { token: o.token })).body.deliveries;
  assert.equal(d.status, "failed");
  assert.equal(d.attempts, MAX_ATTEMPTS);
  assert.match((await api.call("GET", ch(), { token: o.token })).body.channels.find((c: any) => c.id === f.body.channel.id).lastError, /500/);

  // Redirects aren't followed (they could lead to internal addresses)
  const r = await api.call("POST", ch(), { token: o.token, body: { name: "Redirector", kind: "webhook", url: `${recvUrl}/redirect`, events: ["run.failed"], projectIds: [p2] } });
  const t = await api.call("POST", ch(`/${r.body.channel.id}/test`), { token: o.token });
  assert.equal(t.status, 422);
  assert.match(t.body.error.message, /Redirects aren't followed 302/);

  // Queued, then the channel is turned off: the message is dropped, not sent
  await upload(key2, sampleRun([{ fp: "blog-3" }]));
  await api.call("PATCH", ch(`/${f.body.channel.id}`), { token: o.token, body: { enabled: false } });
  const n = hits.length;
  await due();
  await tick();
  assert.equal(since(n).filter((h) => h.path === "/fail").length, 0);
  const latest = (await api.call("GET", ch(`/${f.body.channel.id}/deliveries`), { token: o.token })).body.deliveries[0];
  assert.equal(latest.status, "failed");
  assert.equal(latest.lastError, "Channel turned off");
  // A turned-off channel gets no new messages at all
  const before = (await api.call("GET", ch(`/${f.body.channel.id}/deliveries`), { token: o.token })).body.deliveries.length;
  await upload(key2, sampleRun([{ fp: "blog-4" }]));
  assert.equal((await api.call("GET", ch(`/${f.body.channel.id}/deliveries`), { token: o.token })).body.deliveries.length, before);
});

test("test message, edit and delete", async () => {
  const n = hits.length;
  const t = await api.call("POST", ch(`/${slackId}/test`), { token: o.token });
  assert.deepEqual(t.body, { ok: true });
  assert.match(JSON.parse(since(n)[0].body).text, /^\[Test\] QA gate failed: Sample project/);
  // Changing the webhook URL keeps its signing secret
  await api.call("PATCH", ch(`/${hookId}`), { token: o.token, body: { url: `${recvUrl}/hook2`, name: "Ops webhook v2" } });
  const m = hits.length;
  await api.call("POST", ch(`/${hookId}/test`), { token: o.token });
  const h = since(m)[0];
  assert.equal(h.path, "/hook2");
  assert.equal(h.headers["x-qa-signature"], `sha256=${crypto.createHmac("sha256", signingSecret).update(`${h.headers["x-qa-timestamp"]}.${h.body}`).digest("hex")}`);
  assert.equal((await api.call("PATCH", ch(`/${hookId}`), { token: o.token, body: {} })).status, 400);
  assert.equal((await api.call("DELETE", ch(`/${hookId}`), { token: o.token })).status, 204);
  assert.equal((await api.call("GET", ch(`/${hookId}/deliveries`), { token: o.token })).status, 404);
});
