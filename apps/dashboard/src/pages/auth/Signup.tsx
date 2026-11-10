import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { Button, ErrorAlert, Field, Input } from "../../components/ui";
import { AuthLayout } from "./AuthLayout";
import { safeNext } from "./Login";
import { useSignupOptions } from "../../api/queries";

/** The invite token inside ?next=/invite?token=… */
const inviteTokenFrom = (next: string | null) => {
  if (!next?.startsWith("/invite")) return undefined;
  return new URLSearchParams(next.split("?")[1] ?? "").get("token") ?? undefined;
};

export function SignupPage() {
  const { signup, status } = useAuth();
  const [params] = useSearchParams();
  const next = params.get("next");
  const nav = useNavigate();
  const [f, setF] = useState({ name: "", email: "", password: "", orgName: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const options = useSignupOptions();
  const inviteToken = inviteTokenFrom(next);
  const joining = !!next?.startsWith("/invite");
  if (status === "signed-in" && !busy) return <Navigate to={safeNext(next)} replace />;
  if (!joining && options.data?.signupOpen === false) {
    return (
      <AuthLayout>
        <div>
          <h1>Accounts are by invitation</h1>
          <p className="muted" style={{ marginTop: 4 }}>Ask an admin of your team to invite you, then open the link they send. Already have an account? <Link to="/login">Log in</Link></p>
        </div>
      </AuthLayout>
    );
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <AuthLayout>
      <div>
        <h1>Create your account</h1>
        <p className="muted" style={{ marginTop: 4 }}>Already have one? <Link to={`/login${next ? `?next=${encodeURIComponent(safeNext(next))}` : ""}`}>Log in</Link></p>
      </div>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const { orgId } = await signup({ name: f.name.trim(), email: f.email.trim(), password: f.password, orgName: joining ? undefined : f.orgName.trim() || undefined, createOrg: !joining, inviteToken });
            nav(next ? safeNext(next) : orgId ? `/o/${orgId}` : "/", { replace: true });
          } catch (x) {
            setErr(x);
            setBusy(false);
          }
        }}
      >
        <Field label="Your name">{(id) => <Input id={id} autoComplete="name" value={f.name} onChange={set("name")} required maxLength={120} />}</Field>
        <Field label="Work email">{(id) => <Input id={id} type="email" autoComplete="email" value={f.email} onChange={set("email")} required />}</Field>
        <Field label="Password" hint="At least 10 characters">{(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} value={f.password} onChange={set("password")} required />}</Field>
        {!next && (
          <Field label="Organization name" hint="Your company or team. You can rename it later.">
            {(id) => <Input id={id} value={f.orgName} onChange={set("orgName")} maxLength={120} placeholder="e.g. Acme Software" />}
          </Field>
        )}
        <ErrorAlert error={err} />
        <p className="muted small">By creating an account you agree to the <Link to="/terms">terms of use</Link> and the <Link to="/privacy">privacy notice</Link>.</p>
        <Button variant="primary" type="submit" busy={busy}>Create account</Button>
      </form>
    </AuthLayout>
  );
}
