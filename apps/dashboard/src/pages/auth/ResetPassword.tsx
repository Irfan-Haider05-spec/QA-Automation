import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { Button, ErrorAlert, Field, Input } from "../../components/ui";
import { AuthLayout } from "./AuthLayout";

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const mismatch = again.length > 0 && pw !== again;
  return (
    <AuthLayout>
      <div>
        <h1>Choose a new password</h1>
      </div>
      {!token ? (
        <div className="alert error" role="alert">This link has no reset token. Open the full link from the email, or <Link to="/forgot-password">ask for a new one</Link>.</div>
      ) : done ? (
        <>
          <div className="alert ok" role="status">Password changed. You've been signed out on every device.</div>
          <Link className="btn primary" to="/login">Log in</Link>
        </>
      ) : (
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (mismatch) return;
            setBusy(true);
            setErr(null);
            try {
              await api("POST", "/auth/reset-password", { token, password: pw });
              setDone(true);
            } catch (x) {
              setErr(x);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="New password" hint="At least 10 characters">{(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} required />}</Field>
          <Field label="Repeat the new password" error={mismatch ? "The passwords don't match" : undefined}>{(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} required aria-invalid={mismatch || undefined} />}</Field>
          <ErrorAlert error={err} />
          {!!err && <p className="small muted"><Link to="/forgot-password">Ask for a new link</Link></p>}
          <Button variant="primary" type="submit" busy={busy} disabled={mismatch}>Change password</Button>
        </form>
      )}
    </AuthLayout>
  );
}
