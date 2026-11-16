import type { QaConfig } from "./config.js";
import { HttpClient, getPath, readBoundedResponse } from "./http.js";
import { pathToFileURL } from "node:url";

/**
 * Logs each configured QA account in once per run and reuses the token.
 * The backend allows one session per user, so a second login would kill the
 * first token. Never share these accounts with humans, and never run two
 * agent jobs against the same environment at once (the workflow uses a
 * concurrency group for this).
 */
export class AuthProvider {
  private tokens = new Map<string, string>();
  private failures = new Map<string, string>();
  private sessions = new Map<string, Record<string, string>>();
  private pending = new Map<string, Promise<string | undefined>>();
  private pendingHeaders = new Map<string, Promise<Record<string, string> | undefined>>();

  constructor(private config: QaConfig, private http: HttpClient) {}

  get accountNames() {
    return Object.keys(this.config.accounts);
  }

  account(name: string) {
    return this.config.accounts[name];
  }

  /** First account whose role satisfies the route (empty roles = any logged-in user) */
  accountForRoles(roles: string[], exclude: string[] = []): string | undefined {
    const names = this.accountNames.filter((n) => !exclude.includes(n));
    if (!roles.length) return names.find((n) => this.account(n).role === "USER") ?? names[0];
    return names.find((n) => roles.includes(this.account(n).role));
  }

  /** An account whose role is NOT allowed on the route, for role-bypass checks */
  accountOutsideRoles(roles: string[]): string | undefined {
    if (!roles.length) return undefined;
    return this.accountNames.find((n) => !roles.includes(this.account(n).role));
  }

  loginError(name: string) {
    return this.failures.get(name);
  }

  /** Only for redaction before evidence leaves the engine. */
  secretValues(): string[] {
    const envNames = [this.config.login.oauth?.clientSecretEnv, this.config.login.otp?.codeEnv];
    const cookieValues = [...this.sessions.values()].flatMap((h) => Object.entries(h)
      .filter(([key]) => key.toLowerCase() === "cookie").flatMap(([, cookies]) => cookies.split(";").map((cookie) => cookie.slice(cookie.indexOf("=") + 1).trim())));
    return [...this.tokens.values(), ...[...this.sessions.values()].flatMap((h) => Object.values(h)), ...cookieValues,
      ...envNames.flatMap((name) => name && process.env[name] ? [process.env[name]!] : []),
      ...Object.values(this.config.accounts).flatMap((a) => [a.password, a.apiKey, a.accessToken].filter((v): v is string => !!v))];
  }

  private loginBody(a: { identifier?: string; password?: string; device: string }) {
    const tpl = this.config.login.bodyTemplate ?? { identifier: "{{identifier}}", password: "{{password}}", device: "{{device}}" };
    const values: Record<string, string> = { identifier: a.identifier ?? "", password: a.password ?? "", device: a.device ?? "" };
    return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, v.replace(/\{\{(identifier|password|device)\}\}/g, (_, n) => values[n])]));
  }

  async token(name: string): Promise<string | undefined> {
    let promise = this.pending.get(name);
    if (!promise) {
      promise = this.acquireToken(name).finally(() => this.pending.delete(name));
      this.pending.set(name, promise);
    }
    return promise;
  }

  private async acquireToken(name: string): Promise<string | undefined> {
    if (this.tokens.has(name)) return this.tokens.get(name);
    if (this.failures.has(name)) return undefined;
    const a = this.account(name);
    if (!a) {
      this.failures.set(name, "account not configured");
      return undefined;
    }
    if (a.accessToken) { this.tokens.set(name, a.accessToken); return a.accessToken; }
    if (this.config.login.strategy === "oauth2") {
      const oauth = this.config.login.oauth;
      if (!oauth) throw new Error("OAuth2 client credentials configuration is missing");
      const endpoint = new URL(oauth.tokenUrl);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("OAuth token endpoint must be HTTPS without URL credentials");
      const id = process.env[oauth.clientIdEnv], secret = process.env[oauth.clientSecretEnv];
      if (!id || !secret) throw new Error("OAuth client credential environment variables are missing");
      const res = await fetch(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.config.target.timeoutMs),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, ...(oauth.scope ? { scope: oauth.scope } : {}) }),
      });
      const text = await readBoundedResponse(res, 64 * 1024);
      let body: { access_token?: unknown; token_type?: unknown } | null;
      try { body = JSON.parse(text); }
      catch { this.failures.set(name, `OAuth endpoint returned invalid JSON (HTTP ${res.status})`); return undefined; }
      if (!res.ok || !body || typeof body.access_token !== "string" || !body.access_token || !/^bearer$/i.test(String(body.token_type))) {
        this.failures.set(name, `OAuth token request failed (HTTP ${res.status})`); return undefined;
      }
      this.tokens.set(name, body.access_token); return body.access_token;
    }
    let res = await this.http.send({
      method: "POST",
      path: this.config.login.path,
      json: this.loginBody(a),
    });
    if (this.config.login.otp) {
      const otp = this.config.login.otp;
      const code = process.env[otp.codeEnv];
      const challenge = getPath(res.json, otp.challengePath);
      if (!code || typeof challenge !== "string" || res.status < 200 || res.status >= 300) {
        this.failures.set(name, "OTP code or login challenge missing"); return undefined;
      }
      res = await this.http.send({ method: "POST", path: otp.path,
        json: { [otp.challengeField ?? "challenge"]: challenge, [otp.codeField ?? "code"]: code } });
    }
    const token = getPath(res.json, this.config.login.tokenPath);
    if (this.config.login.strategy === "cookie" && res.status >= 200 && res.status < 300) {
      const allowed = this.config.login.cookieNames;
      if (!allowed?.length) throw new Error("Cookie authentication requires explicit cookieNames");
      const cookies = res.headers.getSetCookie().map((v) => v.split(";", 1)[0]).filter((v) => {
        const eq = v.indexOf("="); return eq > 0 && allowed.includes(v.slice(0, eq)) && v.slice(eq + 1).length > 0;
      });
      if (cookies.length) this.sessions.set(name, { cookie: cookies.join("; ") });
      else this.failures.set(name, "Login did not return the configured session cookies");
      return undefined;
    }
    if (res.status >= 200 && res.status < 300 && typeof token === "string") {
      this.tokens.set(name, token);
      return token;
    }
    const why = res.networkError ?? `Login rejected or token missing (HTTP ${res.status})`;
    this.failures.set(name, why);
    return undefined;
  }

  async header(name: string): Promise<Record<string, string> | undefined> {
    let promise = this.pendingHeaders.get(name);
    if (!promise) {
      promise = this.acquireHeader(name).finally(() => this.pendingHeaders.delete(name));
      this.pendingHeaders.set(name, promise);
    }
    return promise;
  }

  private async acquireHeader(name: string): Promise<Record<string, string> | undefined> {
    if (this.sessions.has(name)) return this.sessions.get(name);
    if (!this.account(name)) { this.failures.set(name, "account not configured"); return undefined; }
    if (this.config.login.strategy === "custom") {
      const script = this.config.login.customScript;
      if (!script) throw new Error("Custom authentication requires a trusted local customScript");
      const module = await import(pathToFileURL(script).href);
      if (typeof module.default !== "function") throw new Error("Custom authentication module must export a function");
      const headers: unknown = await module.default({ account: this.account(name), http: this.http });
      if (!headers || typeof headers !== "object" || Array.isArray(headers) || !Object.keys(headers).length) throw new Error("Custom authentication must return nonempty headers");
      for (const [key, value] of Object.entries(headers)) if (!/^[a-z0-9-]+$/i.test(key) || /^(host|content-length|transfer-encoding)$/i.test(key) || typeof value !== "string" || /[\r\n]/.test(value)) throw new Error("Custom authentication returned unsafe headers");
      const result = headers as Record<string, string>; this.sessions.set(name, result); return result;
    }
    if (this.config.login.strategy === "api-key") {
      const key = this.account(name)?.apiKey;
      const header = this.config.login.headerName ?? "x-api-key";
      if (!/^[a-zA-Z0-9-]+$/.test(header) || /^(host|cookie|content-length)$/i.test(header)) throw new Error("Invalid API-key header name");
      if (!key) { this.failures.set(name, "API key missing"); return undefined; }
      return { [header]: key };
    }
    const t = await this.token(name);
    if (this.sessions.has(name)) return this.sessions.get(name);
    return t ? { authorization: `Bearer ${t}` } : undefined;
  }
}
