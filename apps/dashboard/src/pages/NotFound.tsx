import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { Button, Empty, ErrorAlert, Field, Input } from "../components/ui";

export function NotFoundPage({ what = "page" }: { what?: string }) {
  return (
    <div className="page">
      <Empty title={`This ${what} doesn't exist or you don't have access`} action={<Link className="btn" to="/">Go to your dashboard</Link>}>
        Check the link, or ask an owner of the organization to invite you.
      </Empty>
    </div>
  );
}

/** Signed in but no memberships (e.g. removed from every org): create one or use an invite link */
export function NoOrgPage() {
  const { user, logout, reload } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="main">
      <div className="page" style={{ maxWidth: 520 }}>
        <div>
          <h1>You're not in any organization yet</h1>
          <p className="muted" style={{ marginTop: 6 }}>{user?.email} has no memberships. Open an invite link you were sent, or create an organization.</p>
        </div>
        <form
          className="panel panel-body form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              const r = await api<{ org: { id: string } }>("POST", "/orgs", { name });
              await reload();
              nav(`/o/${r.org.id}`);
            } catch (x) { setErr(x); } finally { setBusy(false); }
          }}
        >
          <Field label="Organization name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />}</Field>
          <ErrorAlert error={err} />
          <div className="btn-row">
            <Button variant="primary" busy={busy} type="submit">Create organization</Button>
            <Button type="button" variant="ghost" onClick={() => logout()}>Log out</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
