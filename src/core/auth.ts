import type { QaConfig } from "./config.js";
import { HttpClient, getPath } from "./http.js";

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

  private loginBody(a: { identifier?: string; password?: string; device: string }) {
    const tpl = this.config.login.bodyTemplate ?? { identifier: "{{identifier}}", password: "{{password}}", device: "{{device}}" };
    const values: Record<string, string> = { identifier: a.identifier ?? "", password: a.password ?? "", device: a.device ?? "" };
    return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, v.replace(/\{\{(identifier|password|device)\}\}/g, (_, n) => values[n])]));
  }

  async token(name: string): Promise<string | undefined> {
    if (this.tokens.has(name)) return this.tokens.get(name);
    if (this.failures.has(name)) return undefined;
    const a = this.account(name);
    if (!a) {
      this.failures.set(name, "account not configured");
      return undefined;
    }
    const res = await this.http.send({
      method: "POST",
      path: this.config.login.path,
      json: this.loginBody(a),
    });
    const token = getPath(res.json, this.config.login.tokenPath);
    if (res.status >= 200 && res.status < 300 && typeof token === "string") {
      this.tokens.set(name, token);
      return token;
    }
    const why = res.networkError ?? `HTTP ${res.status}: ${res.json?.message ?? res.text.slice(0, 120)}`;
    this.failures.set(name, why);
    return undefined;
  }

  async header(name: string): Promise<Record<string, string> | undefined> {
    const t = await this.token(name);
    return t ? { authorization: `Bearer ${t}` } : undefined;
  }
}
