/**
 * Realtime (Socket.IO) checks.
 *
 *  1. A connection without a token is refused (disconnected, or an auth error event).
 *  2. A connection with a tampered token is refused.
 *  3. A real account's token connects on every instance URL and stays connected.
 *  4. Fan-out: the account is connected once on every instance; the configured
 *     trigger request is sent; the event must reach every one of those sockets.
 *     An event that arrives only on the instance that handled the request means
 *     the instances don't share events (e.g. no Redis adapter).
 *  5. Isolation: a second account (the tenant-isolation attacker) is connected while
 *     each trigger runs; it must not receive anything (e.g. io.emit to everyone).
 *  6. Optional per-user connection cap: connecting one socket more than the cap
 *     must close an older one.
 *
 * Instance URLs: list each backend process (e.g. two ports behind one Redis in CI),
 * or repeat a load-balanced URL so several connections may land on different instances.
 * A trigger that writes data (anything but GET) runs only when allowMutations is on.
 */
import { io, type Socket } from "socket.io-client";
import picomatch from "picomatch";
import type { Finding, QaPlugin } from "../core/types.js";
import type { RunContext } from "../core/context.js";

type Outcome = "connected" | "refused" | "timeout";

interface Probe {
  socket: Socket;
  /** connected and still open after the settle time */
  outcome: Promise<Outcome>;
  reason: () => string;
  received: (event: string, ms: number) => Promise<boolean>;
  /** Every event received from now on */
  record: () => string[];
}

function probe(url: string, ctx: RunContext, token: string | undefined): Probe {
  const s = ctx.config.socket!;
  const opts: Parameters<typeof io>[1] = {
    path: s.path,
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    timeout: s.connectTimeoutMs,
  };
  if (token !== undefined) {
    if (s.tokenIn === "auth") opts.auth = { [s.tokenKey]: token };
    else if (s.tokenIn === "header") opts.extraHeaders = { [s.tokenKey]: token };
    else opts.query = { [s.tokenKey]: token };
  }
  const socket = io(url, opts);
  let why = "";
  const authErrors = new Set(s.authErrorEvents);
  const outcome = new Promise<Outcome>((resolve) => {
    let connected = false;
    const settle = setTimeout(() => resolve(connected ? "connected" : "timeout"), s.connectTimeoutMs + s.settleMs);
    socket.on("connect", () => { connected = true; });
    socket.on("connect_error", (e) => { why = e.message; clearTimeout(settle); resolve("refused"); });
    socket.on("disconnect", (r) => { why ||= `disconnected (${r})`; clearTimeout(settle); resolve("refused"); });
    socket.onAny((event, payload) => {
      if (authErrors.has(event)) { why = `${event}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`; }
    });
  });
  // Event names may be globs, e.g. "salesActivation::*"
  const received = (event: string, ms: number) =>
    new Promise<boolean>((resolve) => {
      const match = picomatch(event);
      const t = setTimeout(() => { socket.offAny(on); resolve(false); }, ms);
      const on = (name: string) => { if (match(name)) { clearTimeout(t); socket.offAny(on); resolve(true); } };
      socket.onAny(on);
    });
  const record = () => {
    const seen: string[] = [];
    socket.onAny((name: string) => { if (!authErrors.has(name)) seen.push(name); });
    return seen;
  };
  return { socket, outcome, reason: () => why, received, record };
}

/** Change the signature part so a server that verifies tokens must refuse it */
export function tamper(token: string): string {
  const last = token.slice(-6);
  const swapped = [...last].map((c) => (c === "A" ? "B" : "A")).join("");
  return token.slice(0, -6) + swapped;
}

export const socketFanoutPlugin: QaPlugin = {
  name: "socket-fanout",
  layer: "api",
  description: "Socket.IO: tokens required, every instance accepts real users, events reach subscribers on every instance",
  needs: ["baseUrl", "accounts"],
  skipReason(ctx) {
    const s = ctx.config.socket;
    if (!s) return "no socket settings in the config (socket)";
    if (!s.urls.length) return "no socket URL (set socket.urls or target.baseUrl)";
    if (!ctx.config.accounts[s.account]) return `socket account "${s.account}" has no login`;
    return null;
  },
  async run(ctx) {
    const s = ctx.config.socket!;
    const findings: Finding[] = [];
    const stats = { instances: new Set(s.urls).size, connectedInstances: 0, delivered: 0, fanoutChecked: "no" as string };
    const open: Socket[] = [];
    const close = () => { for (const so of open.splice(0)) so.close(); };
    const label = (u: string) => `socket ${u.replace(/^https?:\/\//, "")}`;
    const ev = (url: string, extra = "") => ({ url: `${url}${s.path}`, log: extra || undefined });

    try {
      const token = await ctx.auth!.token(s.account);
      if (!token) {
        return { findings: [{ plugin: this.name, severity: "high", category: "regression", target: `socket login ${s.account}`, title: `Couldn't log in as ${s.account} for the socket checks`, detail: ctx.auth!.loginError(s.account) }], stats };
      }
      const first = s.urls[0];

      // 1 + 2: no token, tampered token
      for (const [kind, tok] of [["without a token", undefined], ["with a tampered token", tamper(token)]] as const) {
        const p = probe(first, ctx, tok);
        open.push(p.socket);
        const o = await p.outcome;
        if (o === "connected") {
          findings.push({
            plugin: this.name, severity: "high", category: "security", target: `${label(first)} auth`,
            title: `Socket stays connected ${kind}`,
            detail: `The server accepted a Socket.IO connection ${kind} and kept it open. Anyone could listen for realtime events.`,
            evidence: ev(first),
          });
        }
        close();
      }

      // 3: a real token on every instance
      const live: Array<{ url: string; p: Probe }> = [];
      for (const url of s.urls) {
        const p = probe(url, ctx, token);
        open.push(p.socket);
        const o = await p.outcome;
        if (o === "connected") { live.push({ url, p }); stats.connectedInstances++; continue; }
        findings.push({
          plugin: this.name, severity: "high", category: "regression", target: label(url),
          title: o === "timeout" ? "Socket connection timed out" : "Socket refused a logged-in user",
          detail: p.reason() || undefined, evidence: ev(url, p.reason()),
        });
      }

      // 4 + 5: fan-out and isolation, per trigger
      const triggers = s.triggers;
      let attacker: Probe | undefined;
      let attackerSeen: string[] = [];
      if (triggers.length && live.length && s.attacker && s.attacker !== s.account) {
        const at = await ctx.auth!.token(s.attacker);
        if (at) {
          const p = probe(first, ctx, at);
          open.push(p.socket);
          if ((await p.outcome) === "connected") { attacker = p; attackerSeen = p.record(); }
        }
      }
      const checked: string[] = [];
      for (const t of triggers) {
        if (!live.length) break;
        if (t.method !== "GET" && !ctx.config.allowMutations) {
          checked.push(`${t.event}: skipped (writes data, allowMutations is off)`);
          continue;
        }
        const before = attackerSeen.length;
        const waits = live.map(({ url, p }) => p.received(t.event, s.eventTimeoutMs).then((ok) => ({ url, ok })));
        const who = t.account ?? s.account;
        const headers = await ctx.auth!.header(who);
        const req = { method: t.method, path: t.path, headers, json: t.body, tokenLabel: who };
        const res = await ctx.http!.send(req);
        const results = await Promise.all(waits);
        const delivered = results.filter((r) => r.ok).length;
        stats.delivered += delivered;
        checked.push(`${t.event}: ${delivered}/${results.length}`);
        const curlEv = { url: res.url, status: res.status, curl: ctx.http!.curl(req) };
        if (res.status >= 400 || res.networkError) {
          findings.push({
            plugin: this.name, severity: "medium", category: "config", target: `socket trigger ${t.method} ${t.path}`,
            title: `Socket trigger request failed (${res.networkError ?? `HTTP ${res.status}`})`,
            detail: "Fix socket.triggers in the config so the realtime checks can run.", evidence: curlEv,
          });
          continue;
        }
        if (!delivered) {
          findings.push({
            plugin: this.name, severity: "high", category: "regression", target: `socket event ${t.event}`,
            title: `Event "${t.event}" never arrived after ${t.method} ${t.path}`,
            detail: `No connected socket received it within ${s.eventTimeoutMs} ms.`, evidence: curlEv,
          });
        } else {
          for (const r of results.filter((x) => !x.ok)) {
            findings.push({
              plugin: this.name, severity: "high", category: "regression", target: `socket event ${t.event} @ ${r.url.replace(/^https?:\/\//, "")}`,
              title: `Event "${t.event}" didn't reach the socket on another instance`,
              detail: `It arrived on ${delivered} of ${results.length} connections. Instances don't share events: check the Socket.IO adapter (e.g. Redis) on every instance.`,
              evidence: { url: `${r.url}${s.path}`, curl: ctx.http!.curl(req) },
            });
          }
        }
        if (attacker) {
          await new Promise((r) => setTimeout(r, 300)); // late broadcasts
          const leaked = [...new Set(attackerSeen.slice(before))];
          if (leaked.length) {
            findings.push({
              plugin: this.name, severity: "high", category: "security", target: `socket event ${t.event} isolation`,
              title: `Realtime event for ${who} also reached ${s.attacker}`,
              detail: `While ${t.method} ${t.path} ran as ${who}, ${s.attacker}'s socket received: ${leaked.slice(0, 5).join(", ")}. Send events to the user's own sockets or room, not to every connection (io.emit).`,
              evidence: { ...curlEv, log: leaked.join("\n") },
            });
          }
        }
      }
      stats.fanoutChecked = checked.join("; ") || "no triggers";
      close();

      // 6: per-user connection cap
      if (s.maxConnectionsPerUser && stats.connectedInstances) {
        const n = s.maxConnectionsPerUser + 1;
        const ps: Probe[] = [];
        for (let i = 0; i < n; i++) {
          const p = probe(s.urls[i % s.urls.length], ctx, token);
          open.push(p.socket);
          ps.push(p);
          await new Promise((r) => setTimeout(r, 150)); // keep the order of connections
        }
        const outcomes = await Promise.all(ps.map((p) => p.outcome));
        const stillOpen = outcomes.filter((o) => o === "connected").length;
        if (stillOpen > s.maxConnectionsPerUser) {
          findings.push({
            plugin: this.name, severity: "medium", category: "quality", target: `${label(first)} connection cap`,
            title: `${stillOpen} sockets of one user stay open (cap ${s.maxConnectionsPerUser})`,
            detail: "The oldest connection should be closed when a user opens more than the cap.",
            evidence: ev(first),
          });
        }
        close();
      }
    } finally {
      close();
    }
    return { findings, stats };
  },
};
