import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readBoundedResponse } from "./http.js";

export interface MobSFExecution {
  serverUrl: string; binary: string; apiKeyEnv: string; allowRemote: boolean;
  timeoutMs: number; pollIntervalMs: number; maxBinaryMiB: number;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Static analysis only. A configured remote server receives the entire binary.
 * No mutation retry, redirect following, raw-response logging or remote deletion. */
export async function executeMobSF(configDir: string, c: MobSFExecution): Promise<unknown> {
  const base = new URL(c.serverUrl);
  const loopback = ["127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || !["http:", "https:"].includes(base.protocol)) throw new Error("MobSF needs an HTTP(S) URL without credentials, query or fragment");
  if (!loopback && (!c.allowRemote || base.protocol !== "https:")) throw new Error("Remote MobSF requires HTTPS and explicit allowRemote; use a loopback IP for local HTTP");
  const apiKey = process.env[c.apiKeyEnv];
  if (!apiKey || !/^[A-Za-z0-9._~-]{16,256}$/.test(apiKey)) throw new Error("MobSF API key environment variable is missing or invalid");
  const file = path.resolve(configDir, c.binary);
  const extension = path.extname(file).toLowerCase();
  if (![".apk", ".ipa"].includes(extension)) throw new Error("MobSF execution supports APK and IPA files only");
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 4 || before.size > c.maxBinaryMiB * 1024 * 1024) throw new Error("MobSF binary must be a bounded regular file, not a symlink");
  const fd = fs.openSync(file, "r");
  let binary: Buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== before.size || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error("Binary changed while opening");
    binary = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < binary.length) { const count = fs.readSync(fd, binary, offset, binary.length - offset, offset); if (!count) throw new Error("Binary truncated"); offset += count; }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) throw new Error("Binary grew while reading");
  } finally { fs.closeSync(fd); }
  if (binary[0] !== 0x50 || binary[1] !== 0x4b || binary[2] !== 3 || binary[3] !== 4) throw new Error("APK/IPA must have ZIP container magic");
  // MD5 is MobSF's lookup identifier, not a cryptographic authenticity guarantee.
  const hash = createHash("md5").update(binary).digest("hex");
  const sha256 = createHash("sha256").update(binary).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const post = async (endpoint: string, body: BodyInit, limit = 20 * 1024 * 1024): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(`${base.href.replace(/\/$/, "")}/api/v1/${endpoint}`, {
        method: "POST", headers: { Authorization: apiKey, accept: "application/json" },
        body, redirect: "manual", signal: controller.signal,
      });
      if (!response.ok || !/^application\/json\b/i.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel(); throw new Error("Unexpected response");
      }
      const raw = await readBoundedResponse(response, limit);
      const result: unknown = JSON.parse(raw);
      if (object(result) && Object.hasOwn(result, "error")) throw new Error("Scanner error");
      return result;
    } catch { throw new Error(controller.signal.aborted ? "MobSF operation timed out or was cancelled; server-side analysis may still be running" : `MobSF ${endpoint} failed; response body omitted`); }
  };
  try {
    const upload = new FormData();
    upload.append("file", new Blob([new Uint8Array(binary)], { type: extension === ".apk" ? "application/vnd.android.package-archive" : "application/octet-stream" }), `application${extension}`);
    const uploaded = await post("upload", upload, 1024 * 1024);
    if (!object(uploaded) || uploaded.hash !== hash || uploaded.scan_type !== extension.slice(1)) throw new Error("MobSF upload identity does not match the supplied binary");
    const scan = await post("scan", new URLSearchParams({ hash, re_scan: "1" }));
    if (!object(scan)) throw new Error("MobSF scan returned an invalid result");
    if (Object.hasOwn(scan, "task_id")) {
      if (typeof scan.task_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(scan.task_id)) throw new Error("MobSF did not create a new scan task; no cached report accepted");
      for (;;) {
        const tasks = await post("tasks", new URLSearchParams(), 2 * 1024 * 1024);
        if (!Array.isArray(tasks) || tasks.length > 10000) throw new Error("MobSF task response is invalid");
        const matches = tasks.filter(t => object(t) && t.task_id === scan.task_id);
        if (matches.length > 1) throw new Error("MobSF task identity is ambiguous");
        const task = matches[0];
        if (task && task.checksum !== hash) throw new Error("MobSF task belongs to another binary");
        if (task?.completed_at) {
          if (task.status !== "Success" || task.app_name === "Failed") throw new Error("MobSF scan task failed; no report accepted");
          break;
        }
        try { await delay(c.pollIntervalMs, undefined, { signal: controller.signal }); }
        catch { throw new Error("MobSF operation timed out or was cancelled; server-side analysis may still be running"); }
      }
    } else if (scan.md5 !== hash) throw new Error("MobSF synchronous scan did not confirm the supplied binary");
    const report = await post("report_json", new URLSearchParams({ hash }));
    if (!object(report) || report.md5 !== hash || (report.sha256 !== undefined && report.sha256 !== sha256)) throw new Error("MobSF report identity does not match the supplied binary");
    // The API key may be echoed in arbitrary JSON keys or values; remove it before validation/reporting.
    return JSON.parse(JSON.stringify(report).split(apiKey).join("[REDACTED]"));
  } finally {
    clearTimeout(timer); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
}
