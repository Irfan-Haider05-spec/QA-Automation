import { useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, ErrorAlert } from "../../components/ui";
import { AuthLayout } from "./AuthLayout";

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { user, reload, logout } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <AuthLayout>
      <div>
        <h1>Join an organization</h1>
        <p className="muted" style={{ marginTop: 6 }}>You're signed in as <b>{user?.email}</b>. The invite must have been sent to this address.</p>
      </div>
      {!token && <div className="alert error" role="alert">This link has no invite token. Open the full link you were sent.</div>}
      <ErrorAlert error={err} />
      <div className="btn-row">
        <Button
          variant="primary"
          busy={busy}
          disabled={!token}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await api<{ org: { id: string } }>("POST", "/invites/accept", { token });
              await reload();
              nav(`/o/${r.org.id}`, { replace: true });
            } catch (x) {
              setErr(x);
            } finally {
              setBusy(false);
            }
          }}
        >
          Accept invite
        </Button>
        <Button variant="ghost" onClick={async () => { await logout(); nav(`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`); }}>Use another account</Button>
      </div>
      <p className="small muted"><Link to="/">Skip for now</Link></p>
    </AuthLayout>
  );
}
