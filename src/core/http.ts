/**
 * Small HTTP client for plugins: throttling (to stay under the backend's rate
 * limiter), timeouts, retry on network errors and 429, timing, and a curl
 * command for evidence with tokens redacted.
 */

export interface HttpRequest {
  method: string;
  path: string; // path starting with "/" (joined to baseUrl) or absolute URL
  headers?: Record<string, string>;
  json?: unknown;
  /** Label used in curl evidence instead of the real token, e.g. "merchantB" */
  tokenLabel?: string;
  /** Active probes must see the original status (not hide 429s). */
  retry?: boolean;
  body?: BodyInit;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  ms: number;
  url: string;
  networkError?: string;
}

/** Enforce the limit while streaming, including responses without Content-Length. */
export async function readBoundedResponse(res: Response, limit = 5 * 1024 * 1024): Promise<string> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) { await reader.cancel(); throw new Error(`Response exceeds ${limit} byte limit`); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class HttpClient {
  private nextSlot = 0;
  private readonly gapMs: number;
  public requestCount = 0;

  constructor(
    private baseUrl: string,
    requestsPerMinute: number,
    private timeoutMs: number,
  ) {
    this.gapMs = Math.ceil(60000 / Math.max(1, requestsPerMinute));
  }

  private async throttle() {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.gapMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
  }

  url(p: string) {
    const base = new URL(this.baseUrl);
    const url = new URL(/^https?:\/\//i.test(p) ? p : this.baseUrl + p);
    if (url.origin !== base.origin || url.username || url.password || !["http:", "https:"].includes(url.protocol)) {
      throw new Error("API requests must stay on the configured origin and cannot contain URL credentials");
    }
    return url.href;
  }

  async send(req: HttpRequest, attempt = 0): Promise<HttpResponse> {
    await this.throttle();
    this.requestCount++;
    const url = this.url(req.path);
    const headers: Record<string, string> = { accept: "application/json", ...(req.headers ?? {}) };
    let body: BodyInit | undefined = req.body;
    if (req.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.json);
    }
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: req.method, headers, body, signal: ac.signal, redirect: "manual" });
      const text = await readBoundedResponse(res);
      const ms = Date.now() - started;
      const canRetry = req.retry !== false && /^(GET|HEAD|OPTIONS)$/i.test(req.method);
      if (canRetry && res.status === 429 && attempt < 3) {
        const retryAfter = Number(res.headers.get("retry-after")) || 15;
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 60) * 1000));
        return this.send(req, attempt + 1);
      }
      let json: any = undefined;
      try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
      return { status: res.status, headers: res.headers, text, json, ms, url };
    } catch (e: any) {
      if (req.retry !== false && /^(GET|HEAD|OPTIONS)$/i.test(req.method) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        return this.send(req, attempt + 1);
      }
      const msg = e?.name === "AbortError" ? `timeout after ${this.timeoutMs}ms` : e?.cause?.code ?? e?.message ?? String(e);
      return { status: 0, headers: new Headers(), text: "", json: undefined, ms: Date.now() - started, url, networkError: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  curl(req: HttpRequest): string {
    const parts = [`curl -i -X ${req.method}`, `'${this.url(req.path)}'`];
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const shown = k.toLowerCase() === "authorization" && v.startsWith("Bearer ")
        ? `Bearer $QA_TOKEN_${(req.tokenLabel ?? "X").toUpperCase()}`
        : /authorization|cookie|key|token|secret/i.test(k) ? "[REDACTED]" : v;
      parts.push(`-H '${k}: ${shown}'`);
    }
    if (req.json !== undefined) parts.push(`-H 'content-type: application/json' -d '${JSON.stringify(req.json, (k, v) => /password|secret|token|credential/i.test(k) ? "[REDACTED]" : v)}'`);
    return parts.join(" ");
  }
}

export const snippet = (text: string, max = 300) => (text.length > max ? text.slice(0, max) + "…" : text);

/** Replace :params with a syntactically valid but non-existent Mongo ObjectId */
export const DUMMY_OBJECT_ID = "000000000000000000000000";
export const fillParams = (p: string, values: Record<string, string> = {}) =>
  p.replace(/:([A-Za-z0-9_]+)/g, (_, name) => values[name] ?? DUMMY_OBJECT_ID);

export const getPath = (obj: any, dotPath: string) =>
  dotPath.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
