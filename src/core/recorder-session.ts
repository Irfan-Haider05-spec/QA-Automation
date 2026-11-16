import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { convertRecording } from "./record-flow.js";

/** Local, in-memory handoff from Playwright Inspector. No raw recording file. */
export async function startRecorderSession(options: { app: string; name: string; baseUrl: string; output: string; signal?: AbortSignal; timeoutMs?: number }) {
  const token = crypto.randomBytes(32).toString("hex");
  let origin = "", settled = false;
  let resolveDone!: (result: { saved: boolean; variables: string[] }) => void;
  const done = new Promise<{ saved: boolean; variables: string[] }>(resolve => { resolveDone = resolve; });
  const finish = (saved: boolean, variables: string[] = []) => {
    if (settled) return;
    settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
    resolveDone({ saved, variables });
    server.close(); server.closeIdleConnections();
  };
  const cancel = () => { finish(false); server.closeAllConnections(); };
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
    if (req.method === "GET" && req.url === `/${token}`) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>VeriQ flow recording</title><body><h1>Finish your recording</h1><p>Record in Playwright Inspector. Select Playwright Test, copy the code, and paste it below. Review before saving. Fill values become required environment inputs.</p><textarea id="source" aria-label="Recording source" rows="20" cols="100" autocomplete="off" spellcheck="false"></textarea><p><button id="save">Validate and save</button> <button id="cancel">Cancel recording</button></p><p id="status" role="status"></p><script>
const source=document.getElementById('source'), status=document.getElementById('status');
async function submit(action){const body=action==='save'?source.value:'';source.value='';try{const response=await fetch('/'+action,{method:'POST',headers:{'Authorization':'Bearer ${token}','Content-Type':'text/plain'},body});const result=await response.json();status.textContent=result.message;}catch{status.textContent='Session ended. Check the terminal.';}}
document.getElementById('save').onclick=()=>submit('save');document.getElementById('cancel').onclick=()=>submit('cancel');
</script></body></html>`); return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "POST" || req.headers.origin !== origin || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end('{"message":"Forbidden"}'); return; }
    if (req.url === "/cancel") { res.end('{"message":"Cancelled; no flow saved."}'); finish(false); return; }
    if (req.url !== "/save" || settled) { res.writeHead(409).end('{"message":"Session unavailable"}'); return; }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 256_000) { res.writeHead(413).end('{"message":"Recording too large"}'); req.destroy(); return; } chunks.push(chunk); }
      if (settled) { res.writeHead(409).end('{"message":"Session ended"}'); return; }
      const result = convertRecording(Buffer.concat(chunks).toString("utf8"), options);
      fs.writeFileSync(options.output, result.source, { flag: "wx", mode: 0o600 });
      res.end(JSON.stringify({ message: `Saved. Required environment inputs: ${result.variables.join(", ") || "none"}` }));
      finish(true, result.variables);
    } catch {
      res.writeHead(422).end('{"message":"Cannot save: unsupported recording, invalid destination or existing file. Nothing was overwritten. Correct the source and try again."}');
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  server.maxConnections = 8;
  let timer: ReturnType<typeof setTimeout>;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  timer = setTimeout(cancel, options.timeoutMs ?? 15 * 60_000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  return { url: `${origin}/${token}`, done, cancel };
}
