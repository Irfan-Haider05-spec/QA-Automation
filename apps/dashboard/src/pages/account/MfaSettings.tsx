import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthProvider";
import { api, session } from "../../api/client";
import { Button, ErrorAlert, Field, Input } from "../../components/ui";

export function MfaSettings() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["account", user?.id, "mfa"];
  const status = useQuery({ queryKey, queryFn: () => api<{ enabled: boolean }>("GET", "/auth/mfa") });
  const enabled = status.data?.enabled;
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ secret: string; uri: string }>();
  const [recovery, setRecovery] = useState<string[]>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  return <section className="panel" aria-labelledby="mfa-title"><div className="panel-head"><h2 id="mfa-title">Two-factor authentication</h2></div>
    <form className="panel-body form" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError(undefined);
      try {
        if (!enabled && !setup) setSetup(await api("POST", "/auth/mfa/setup", { password }));
        else {
          const r = await api<{ recoveryCodes?: string[]; tokens: { accessToken: string; refreshToken: string } }>("POST", enabled ? "/auth/mfa/disable" : "/auth/mfa/enable", { password, code });
          session.set(r.tokens); queryClient.setQueryData(queryKey, { enabled: !enabled }); setSetup(undefined); setRecovery(r.recoveryCodes); setPassword(""); setCode("");
        }
      } catch (err) { setError(err); } finally { setBusy(false); }
    }}>
      <p>{enabled === undefined ? "Loading…" : enabled ? "Enabled. A second factor is required when you log in." : "Use an authenticator app to protect your account."}</p>
      {setup && <><p>Add a time-based account in your authenticator using this key, then enter its six-digit code. Setup expires in ten minutes.</p><code className="code" data-testid="mfa-secret">{setup.secret}</code></>}
      {recovery && <div className="alert warn"><strong>Save these recovery codes privately. Each works once.</strong><pre className="code">{recovery.join("\n")}</pre><Button type="button" onClick={() => setRecovery(undefined)}>I saved my recovery codes</Button></div>}
      <Field label="Password for two-factor settings">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
      {(enabled || setup) && <Field label="Authenticator or recovery code">{(id) => <Input id={id} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />}</Field>}
      <ErrorAlert error={error ?? status.error} /><Button type="submit" busy={busy} disabled={enabled === undefined}>{enabled ? "Disable two-factor authentication" : setup ? "Confirm authenticator" : "Set up authenticator"}</Button>
    </form></section>;
}
