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
    return /^https?:\/\//.test(p) ? p : this.baseUrl + p;
  }

  async send(req: HttpRequest, attempt = 0): Promise<HttpResponse> {
    await this.throttle();
    this.requestCount++;
    const url = this.url(req.path);
    const headers: Record<string, string> = { accept: "application/json", ...(req.headers ?? {}) };
    let body: string | undefined;
    if (req.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.json);
    }
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: req.method, headers, body, signal: ac.signal, redirect: "manual" });
      const text = await res.text();
      const ms = Date.now() - started;
      if (res.status === 429 && attempt < 3) {
        const retryAfter = Number(res.headers.get("retry-after")) || 15;
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 60) * 1000));
        return this.send(req, attempt + 1);
      }
      let json: any = undefined;
      try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
      return { status: res.status, headers: res.headers, text, json, ms, url };
    } catch (e: any) {
      if (attempt < 2) {
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
        : v;
      parts.push(`-H '${k}: ${shown}'`);
    }
    if (req.json !== undefined) parts.push(`-H 'content-type: application/json' -d '${JSON.stringify(req.json)}'`);
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
