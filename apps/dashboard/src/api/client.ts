/**
 * API client. Access + refresh tokens live in localStorage so every tab shares
 * one session. Refresh tokens rotate on use (and reuse signs out every session),
 * so a refresh is done under a cross-tab lock and skipped if another tab
 * already refreshed while we waited.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

const KEY = "qa.session";
interface Stored { accessToken: string; refreshToken: string }

export const session = {
  get(): Stored | null {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as Stored) : null;
    } catch {
      return null;
    }
  },
  set(s: Stored) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
  },
  clear() {
    try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  },
};

let onSignedOut: () => void = () => {};
export const setSignedOutHandler = (fn: () => void) => { onSignedOut = fn; };

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as any).locks;
  return locks?.request ? locks.request("qa-refresh", fn) : fn();
}

/**
 * Where the API lives. Empty (default): the same origin (/api/v1 behind nginx, or the
 * Vite proxy in dev). Set VITE_API_URL at build time when the dashboard is hosted
 * separately (Cloudflare Pages, Vercel), e.g. https://api.qa.example.com, and add the
 * dashboard's origin to the API's CORS_ORIGINS.
 */
export const API_BASE = `${((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, "")}/api/v1`;

let inflight: Promise<boolean> | null = null;

/** Returns true if a valid access token is available afterwards */
async function refresh(usedAccess: string | undefined): Promise<boolean> {
  if (inflight) return inflight;
  inflight = withLock(async () => {
    const cur = session.get();
    if (!cur) return false;
    if (usedAccess && cur.accessToken !== usedAccess) return true; // another tab refreshed already
    const res = await fetch(`${API_BASE}/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: cur.refreshToken }) });
    if (!res.ok) {
      session.clear();
      return false;
    }
    const j = await res.json();
    session.set({ accessToken: j.tokens.accessToken, refreshToken: j.tokens.refreshToken });
    return true;
  }).finally(() => { inflight = null; });
  return inflight;
}

export async function api<T = any>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const s = session.get();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(s ? { authorization: `Bearer ${s.accessToken}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && s && retry && !path.startsWith("/auth/login")) {
    if (await refresh(s.accessToken)) return api<T>(method, path, body, false);
    onSignedOut();
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? "http_error", e?.message ?? `Request failed (${res.status})`, e?.details ?? json?.instructions);
  }
  return json as T;
}

/** Human message for an error, including field-level validation details */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "validation_error" && Array.isArray(e.details) && e.details.length) {
      return e.details.map((d: any) => (d.path ? `${d.path}: ${d.message}` : d.message)).join(" · ");
    }
    return e.message;
  }
  if (e instanceof TypeError) return "Can't reach the server. Check your connection and try again.";
  return (e as Error)?.message ?? "Something went wrong";
}
