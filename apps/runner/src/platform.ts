/** The hosted-runner side of the platform API (/api/v1/hosted) */
import type { ClaimPayload } from "./job.js";

export class PlatformClient {
  constructor(private url: string, private token: string, readonly runnerId: string) {}

  private async call(method: string, p: string, body?: unknown) {
    const res = await fetch(`${this.url.replace(/\/+$/, "")}/api/v1/hosted${p}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "x-runner-id": this.runnerId, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
    return { status: res.status, json, message: json?.error?.message ?? text.slice(0, 200) };
  }

  async claim(): Promise<ClaimPayload | null> {
    const r = await this.call("POST", "/jobs/claim");
    if (r.status === 204) return null;
    if (r.status !== 200) throw new Error(`claim → ${r.status}: ${r.message}`);
    return r.json as ClaimPayload;
  }

  /** ok, cancel (user cancelled), lost (no longer ours) */
  async heartbeat(jobId: string): Promise<"ok" | "cancel" | "lost"> {
    const r = await this.call("POST", `/jobs/${jobId}/heartbeat`);
    if (r.status === 409 || r.status === 404) return "lost";
    if (r.status !== 200) throw new Error(`heartbeat → ${r.status}: ${r.message}`);
    return r.json.cancel ? "cancel" : "ok";
  }

  async complete(jobId: string, body: { run?: unknown; error?: string }) {
    const r = await this.call("POST", `/jobs/${jobId}/complete`, body);
    if (r.status !== 200) throw new Error(`complete → ${r.status}: ${r.message}`);
    return r.json as { status: string; runId: string | null };
  }
}
