import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, session } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { AuthLayout } from "./AuthLayout";
import { Button, ErrorAlert, Field, Input } from "../../components/ui";

export function SsoCallbackPage() {
  const started = useRef(false), nav = useNavigate();
  const { reload, verifyMfa } = useAuth();
  const [error, setError] = useState<unknown>(), [linked, setLinked] = useState(false), [challenge, setChallenge] = useState<string>(), [code, setCode] = useState("");
  useEffect(() => {
    if (started.current) return; started.current = true;
    const params = new URLSearchParams(location.search), browserToken = sessionStorage.getItem("veriq.sso.browser");
    sessionStorage.removeItem("veriq.sso.browser"); history.replaceState(null, "", location.pathname);
    if (!browserToken || !params.get("state") || !params.get("code")) { setError(new Error("SSO session is missing or expired. Start sign-in again.")); return; }
    api<{ linked?: boolean; mfaRequired?: boolean; challenge?: string; tokens?: { accessToken: string; refreshToken: string } }>("POST", "/auth/sso/complete", { code: params.get("code"), state: params.get("state"), browserToken }).then(async (r) => {
      if (r.linked) { setLinked(true); return; }
      if (r.mfaRequired) { setChallenge(r.challenge); return; }
      if (!r.tokens) throw new Error("SSO did not return a session");
      session.set(r.tokens); await reload(); nav("/", { replace: true });
    }).catch(setError);
  }, [nav, reload]);
  return <AuthLayout><h1>{linked ? "SSO linked" : "Completing sign-in"}</h1><ErrorAlert error={error} />
    {linked ? <p>Your identity provider is linked to this account. <Link to="/">Return to your workspace</Link></p> : challenge ? <form className="form" onSubmit={async (e) => { e.preventDefault(); try { await verifyMfa(challenge, code); nav("/", { replace: true }); } catch (e) { setError(e); } }}>
      <Field label="Authentication code">{(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required />}</Field><Button type="submit">Verify</Button>
    </form> : !error && <p>Verifying your identity…</p>}
    {!!error && <Link to="/login">Return to login</Link>}
  </AuthLayout>;
}
