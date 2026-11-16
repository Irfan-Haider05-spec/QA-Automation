import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, session } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, ErrorAlert, Field, Input, useToast } from "../../components/ui";

export function RevokeSessions() {
  const { logout, user } = useAuth();
  const mfa = useQuery({ queryKey: ["account", user?.id, "mfa"], queryFn: () => api<{ enabled: boolean }>("GET", "/auth/mfa") });
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <section className="panel danger-zone" aria-labelledby="sessions-h">
      <div className="panel-head"><h2 id="sessions-h">Sign out everywhere</h2></div>
      <form className="panel-body form" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try {
          await api("POST", "/auth/revoke-sessions", { password, ...(mfa.data?.enabled ? { code } : {}) });
          session.clear();
          toast("All sessions were signed out");
          await logout().catch(() => {});
          // End the document's lifetime after revocation, including pending queries
          // and route-guard effects, so they cannot restore an old destination.
          window.location.replace("/login");
        } catch (x) { setError(x); setBusy(false); }
      }}>
        <p className="muted">Enter your password{mfa.data?.enabled ? " and an unused authenticator or recovery code" : ""}. This signs out every device, including this one.</p>
        <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
        {mfa.data?.enabled && <Field label="Authenticator or recovery code">{(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required />}</Field>}
        <ErrorAlert error={error ?? mfa.error} />
        <div><Button variant="danger" type="submit" busy={busy} disabled={!password || !mfa.data || (mfa.data.enabled && !code)}>Sign out everywhere</Button></div>
      </form>
    </section>
  );
}
