import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { Button, ErrorAlert, Field, Input } from "../../components/ui";
import { AuthLayout } from "./AuthLayout";
import { useSignupOptions } from "../../api/queries";

/** Only same-app paths are allowed as ?next= targets (no open redirects) */
export const safeNext = (n: string | null) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/");

export function LoginPage() {
  const { login, status } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const options = useSignupOptions();
  // Invite links can always create an account; otherwise only when the platform allows sign-up
  const canSignUp = next.startsWith("/invite") || options.data?.signupOpen !== false;
  if (status === "signed-in") return <Navigate to={next} replace />;
  return (
    <AuthLayout>
      <div>
        <h1>Log in</h1>
        {canSignUp
          ? <p className="muted" style={{ marginTop: 4 }}>No account? <Link to={`/signup${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>Sign up</Link></p>
          : <p className="muted" style={{ marginTop: 4 }}>New here? Ask an admin of your team for an invite link.</p>}
      </div>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await login(email.trim(), password);
            nav(next, { replace: true });
          } catch (x) {
            setErr(x);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
        <Field label="Password" hint={<Link to="/forgot-password">Forgot your password?</Link>}>{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
        <ErrorAlert error={err} />
        <Button variant="primary" type="submit" busy={busy}>Log in</Button>
      </form>
    </AuthLayout>
  );
}
