import { api } from "../api/client";
export async function startSso(link?: { password: string; code?: string }) {
  const r = await api<{ authorizationUrl: string; browserToken: string }>("POST", link ? "/auth/sso/link" : "/auth/sso/start", link ?? {});
  if (new URL(r.authorizationUrl).protocol !== "https:") throw new Error("Identity provider must use HTTPS");
  sessionStorage.setItem("veriq.sso.browser", r.browserToken);
  location.assign(r.authorizationUrl);
}
