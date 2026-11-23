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
  /** Body size in bytes, before decoding. */
  bytes?: number;
  /** Set when the body is binary (for example an Excel export); see binaryKind(). */
  binary?: string;
}

/** Enforce the limit while streaming, including responses without Content-Length. */
export async function readBoundedBytes(res: Response, limit = 5 * 1024 * 1024): Promise<Buffer> {
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
  return Buffer.concat(chunks);
}
export async function readBoundedResponse(res: Response, limit = 5 * 1024 * 1024): Promise<string> {
  return (await readBoundedBytes(res, limit)).toString("utf8");
}

const startsWith = (b: Buffer, ...sig: number[]) => sig.every((v, i) => b[i] === v);
/**
 * Name the kind of a binary body from its first bytes (and content type), or undefined
 * for text. Binary bodies are never printed as evidence: decoded as text they are
 * unreadable, and they are often file exports full of personal data.
 */
export function binaryKind(body: Buffer, contentType: string | null): string | undefined {
  const ct = (contentType ?? "").toLowerCase();
  if (startsWith(body, 0x50, 0x4b, 0x03, 0x04)) {
    const head = body.subarray(0, 4096).toString("latin1");
    if (ct.includes("spreadsheetml") || head.includes("xl/")) return "Excel workbook (.xlsx)";
    if (ct.includes("wordprocessingml") || head.includes("word/")) return "Word document (.docx)";
    if (ct.includes("presentationml") || head.includes("ppt/")) return "PowerPoint file (.pptx)";
    return "ZIP archive";
  }
  if (startsWith(body, 0x25, 0x50, 0x44, 0x46)) return "PDF document";
  if (startsWith(body, 0xd0, 0xcf, 0x11, 0xe0)) return "legacy Office file (.xls/.doc)";
  if (startsWith(body, 0x89, 0x50, 0x4e, 0x47)) return "PNG image";
  if (startsWith(body, 0xff, 0xd8, 0xff)) return "JPEG image";
  if (startsWith(body, 0x47, 0x49, 0x46, 0x38)) return "GIF image";
  if (startsWith(body, 0x1f, 0x8b)) return "gzip archive";
  if (/^(image|audio|video|font)\//.test(ct) || /^application\/(octet-stream|pdf|zip|x-|vnd\.(?!api\+json))/.test(ct)) return ct.split(";")[0];
  // Unknown type: mostly control characters or invalid UTF-8 means binary.
  const sample = body.subarray(0, 1024);
  if (!sample.length) return undefined;
  const control = sample.filter((c) => c < 0x09 || (c > 0x0d && c < 0x20)).length;
  const replaced = (sample.toString("utf8").match(/\uFFFD/g) ?? []).length;
  return (control + replaced) / sample.length > 0.1 ? "binary data" : undefined;
}

/** Remove personal data from text shown as evidence: emails, phone/ID/card numbers, tokens. */
export function redactPersonalData(text: string): string {
  return text
    .replace(/\b(?:Bearer\s+)?eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, "<token>")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/(?<![\w.])\d{5}-\d{7}-\d(?![\w.])/g, "<id-number>")
    .replace(/(?<![\w.])(?:\+\d{1,3}[ -]?|0)\d{2,4}[ -]?\d{6,8}(?![\w.])/g, "<phone>")
    .replace(/(?<![\w.])\d{15,19}(?![\w.])/g, "<number>");
}

/**
 * Last line of defence for any plugin's evidence text: binary-looking text is replaced
 * by a note, the rest is capped and has personal data removed.
 */
export function sanitizeEvidenceText(text: string, max = 1000): string {
  if (text.startsWith("[Binary response not shown") || text.startsWith("[File download not shown")) return text;
  const sample = text.slice(0, 1024);
  const odd = (sample.match(/[\u0000-\u0008\u000E-\u001F\uFFFD]/g) ?? []).length;
  if (sample.length && odd / sample.length > 0.1) return "[Binary response not shown. Use the curl command to download and inspect it.]";
  return redactPersonalData(snippet(text, max));
}

const kb = (n: number) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`);
/**
 * Evidence text for a response body: binary bodies and file downloads are described,
 * never printed; text is shortened and personal data removed.
 */
export function responseEvidence(res: Pick<HttpResponse, "text" | "headers"> & { bytes?: number; binary?: string }, max = 300): string {
  const ct = res.headers.get("content-type");
  const size = res.bytes ?? Buffer.byteLength(res.text);
  const typeNote = ct ? `, ${ct.split(";")[0]}` : "";
  if (res.binary) return `[Binary response not shown: ${res.binary}, ${kb(size)}${typeNote}. Use the curl command to download and inspect it.]`;
  const disposition = res.headers.get("content-disposition") ?? "";
  if (/^\s*attachment/i.test(disposition)) {
    const name = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(disposition)?.[1]?.replace(/[^\w.-]/g, "_").slice(0, 80);
    return `[File download not shown: ${name ?? "unnamed file"}, ${kb(size)}${typeNote}. Use the curl command to download and inspect it.]`;
  }
  return redactPersonalData(snippet(res.text, max));
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
      const raw = await readBoundedBytes(res);
      const text = raw.toString("utf8");
      const binary = binaryKind(raw, res.headers.get("content-type"));
      const ms = Date.now() - started;
      const canRetry = req.retry !== false && /^(GET|HEAD|OPTIONS)$/i.test(req.method);
      if (canRetry && res.status === 429 && attempt < 3) {
        const retryAfter = Number(res.headers.get("retry-after")) || 15;
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 60) * 1000));
        return this.send(req, attempt + 1);
      }
      let json: any = undefined;
      try { json = text && !binary ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
      return { status: res.status, headers: res.headers, text, json, ms, url, bytes: raw.length, ...(binary ? { binary } : {}) };
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
