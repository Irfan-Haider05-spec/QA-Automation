import { useEffect, useState } from "react";
import { api, session } from "../../api/client";
import { startSso } from "../../auth/sso";
import { Button, ErrorAlert, Field, Input } from "../../components/ui";
export function SsoSettings() {
  const [data, setData] = useState<{ configured: boolean; identities: { issuer: string }[] }>();
  const [password, setPassword] = useState(""), [code, setCode] = useState(""), [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false);
  const load = () => api<typeof data>("GET", "/auth/sso").then(setData).catch(setError);
  useEffect(() => { void load(); }, []);
  if (!data?.configured && !data?.identities.length) return null;
  return <section className="panel"><div className="panel-head"><h2>Single sign-on</h2></div><form className="panel-body form" onSubmit={async (e) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      if (data?.identities.length) {
        const r = await api<{ tokens: { accessToken: string; refreshToken: string } }>("DELETE", "/auth/sso", { password, code: code || undefined, issuer: data.identities[0].issuer });
        session.set(r.tokens); setPassword(""); setCode(""); await load();
      } else await startSso({ password, code: code || undefined });
    } catch (e) { setError(e); } finally { setBusy(false); }
  }}><p>{data?.identities.length ? `Linked to ${data.identities[0].issuer}` : "Link your existing account to your identity provider. Your password account remains available."}</p>
    <Field label="Password for SSO settings">{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}</Field>
    <Field label="MFA code (if enabled)">{(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />}</Field>
    <ErrorAlert error={error} /><Button type="submit" busy={busy}>{data?.identities.length ? "Unlink SSO" : "Link identity provider"}</Button>
  </form></section>;
}
