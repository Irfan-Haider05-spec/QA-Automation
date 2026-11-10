/**
 * Outgoing requests to addresses customers give us (Slack, webhooks). Without
 * these checks the platform could be used to call internal services (SSRF).
 *
 * - https only; Slack URLs must be hooks.slack.com
 * - the host must resolve only to public addresses (no loopback, private,
 *   link-local, CGNAT, multicast, metadata endpoints)
 * - redirects are not followed
 * ALLOW_PRIVATE_WEBHOOKS (dev/test only) lifts the address and https rules.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { badRequest } from "./http.js";

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
}

export async function assertOutboundUrl(raw: string, o: { allowPrivate: boolean; slack?: boolean }): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw badRequest("Not a valid URL"); }
  if (u.username || u.password) throw badRequest("URLs with a user name or password aren't allowed");
  if (o.allowPrivate) {
    if (!["http:", "https:"].includes(u.protocol)) throw badRequest("Use an http(s) URL");
    return u;
  }
  if (u.protocol !== "https:") throw badRequest("Use an https:// URL");
  if (o.slack && u.hostname !== "hooks.slack.com") throw badRequest("Slack incoming-webhook URLs start with https://hooks.slack.com/");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await dns.lookup(host, { all: true })).map((a) => a.address); } catch { throw badRequest(`Can't resolve ${host}`); }
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) throw badRequest(`${host} points to a private or local address`);
  return u;
}

/** Shown in the UI instead of the secret URL: host and the last few characters */
export const urlHint = (raw: string) => {
  const u = new URL(raw);
  const tail = u.pathname.replace(/\/+$/, "").slice(-4);
  return `${u.host}/…${tail}`;
};
