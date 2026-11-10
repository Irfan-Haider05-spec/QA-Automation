import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { Button, ErrorAlert, Field, Input } from "../../components/ui";
import { AuthLayout } from "./AuthLayout";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  return (
    <AuthLayout>
      <div>
        <h1>Reset your password</h1>
        <p className="muted" style={{ marginTop: 4 }}>Remembered it? <Link to="/login">Log in</Link></p>
      </div>
      {sentTo ? (
        <div className="alert" role="status">
          If an account exists for <b>{sentTo}</b>, we've sent it a link to choose a new password. The link expires in an hour. Check your spam folder if it doesn't arrive.
        </div>
      ) : (
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              await api("POST", "/auth/forgot-password", { email: email.trim() });
              setSentTo(email.trim());
            } catch (x) {
              setErr(x);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Email" hint="We'll send a reset link to this address.">{(id) => <Input id={id} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
          <ErrorAlert error={err} />
          <Button variant="primary" type="submit" busy={busy}>Send reset link</Button>
        </form>
      )}
    </AuthLayout>
  );
}
