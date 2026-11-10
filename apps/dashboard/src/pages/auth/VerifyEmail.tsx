import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, session } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { ErrorAlert, Loading } from "../../components/ui";
import { AuthLayout } from "./AuthLayout";

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { status, reload } = useAuth();
  const qc = useQueryClient();
  const [state, setState] = useState<{ email?: string; error?: unknown } | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (!token || once.current) return;
    once.current = true; // the link works once: don't send it twice (StrictMode, re-renders)
    api<{ email: string }>("POST", "/auth/verify-email", { token })
      .then(async (r) => {
        setState({ email: r.email });
        // Signed in (even if still loading): refresh the user so the banner goes away
        if (session.get()) { await reload(); qc.invalidateQueries(); }
      })
      .catch((e) => setState({ error: e }));
  }, [token, reload, qc]);
  return (
    <AuthLayout>
      <div><h1>Confirm your email</h1></div>
      {!token && <div className="alert error" role="alert">This link has no token. Open the full link from the email.</div>}
      {token && !state && <Loading label="Confirming…" />}
      {state?.email && <div className="alert ok" role="status"><b>{state.email}</b> is confirmed. Alerts and account emails will go there.</div>}
      {state?.error ? <ErrorAlert error={state.error} /> : null}
      {state && <Link className="btn primary" to={status === "signed-in" ? "/" : "/login"}>{status === "signed-in" ? "Go to the dashboard" : "Log in"}</Link>}
    </AuthLayout>
  );
}
