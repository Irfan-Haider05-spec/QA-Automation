import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, session } from "../api/client";
import { useSignupOptions } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { Button, ErrorAlert, Field, Input, Modal, useToast } from "../components/ui";

function Profile() {
  const { user, reload } = useAuth();
  const options = useSignupOptions();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [sent, setSent] = useState(false);
  useEffect(() => setName(user?.name ?? ""), [user?.name]);
  if (!user) return null;
  return (
    <section className="panel" aria-labelledby="ap-h">
      <div className="panel-head"><h2 id="ap-h">Profile</h2></div>
      <form className="panel-body form" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null);
        try { await api("PATCH", "/auth/me", { name: name.trim() }); await reload(); toast("Name saved"); } catch (x) { setErr(x); } finally { setBusy(false); }
      }}>
        <Field label="Your name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="name" />}</Field>
        <Field label="Email" hint={options.data?.emailVerification ? (user.emailVerified ? "Confirmed" : sent ? "Not confirmed yet. New link sent." : <>Not confirmed yet. <button type="button" className="linklike" onClick={async () => { await api("POST", "/auth/resend-verification").catch(() => {}); setSent(true); }}>Send the link again</button></>) : undefined}>
          {(id) => <Input id={id} value={user.email} readOnly aria-readonly="true" />}
        </Field>
        <ErrorAlert error={err} />
        <div><Button variant="primary" type="submit" busy={busy} disabled={name.trim() === user.name || !name.trim()}>Save name</Button></div>
      </form>
    </section>
  );
}

function Password() {
  const toast = useToast();
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const mismatch = f.again.length > 0 && f.next !== f.again;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="panel" aria-labelledby="pw-h">
      <div className="panel-head"><h2 id="pw-h">Password</h2></div>
      <form className="panel-body form" onSubmit={async (e) => {
        e.preventDefault();
        if (mismatch) return;
        setBusy(true); setErr(null);
        try {
          const r = await api<{ tokens: { accessToken: string; refreshToken: string } }>("POST", "/auth/change-password", { currentPassword: f.current, newPassword: f.next });
          session.set(r.tokens);
          setF({ current: "", next: "", again: "" });
          toast("Password changed. Other devices were signed out.");
        } catch (x) { setErr(x); } finally { setBusy(false); }
      }}>
        <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={f.current} onChange={set("current")} required />}</Field>
        <Field label="New password" hint="At least 10 characters">{(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} value={f.next} onChange={set("next")} required />}</Field>
        <Field label="Repeat the new password" error={mismatch ? "The passwords don't match" : undefined}>{(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} value={f.again} onChange={set("again")} required aria-invalid={mismatch || undefined} />}</Field>
        <ErrorAlert error={err} />
        <div><Button variant="primary" type="submit" busy={busy} disabled={mismatch}>Change password</Button></div>
      </form>
    </section>
  );
}

function DeleteAccount() {
  const { logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const close = () => { setOpen(false); setPw(""); setErr(null); };
  return (
    <section className="panel danger-zone" aria-labelledby="da-h">
      <div className="panel-head"><h2 id="da-h">Delete your account</h2></div>
      <div className="panel-body">
        <p className="muted">Removes your name, email, sessions and memberships. Organizations and their projects stay with the other members; the audit log keeps what was done, not who. If you're the only owner of an organization, make someone else an owner (or delete it) first.</p>
        <Button variant="danger" onClick={() => setOpen(true)}>Delete my account</Button>
      </div>
      {open && (
        <Modal title="Delete your account?" description="This can't be undone." onClose={close} footer={<>
          <Button onClick={close}>Keep my account</Button>
          <Button variant="danger" busy={busy} disabled={!pw} form="del-acc" type="submit">Delete my account</Button>
        </>}>
          <form id="del-acc" className="form" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true); setErr(null);
            try {
              await api("DELETE", "/auth/me", { password: pw });
              session.clear();
              await logout().catch(() => {});
              nav("/login", { replace: true });
            } catch (x) { setErr(x); setBusy(false); }
          }}>
            <Field label="Your password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus />}</Field>
            <ErrorAlert error={err} />
          </form>
        </Modal>
      )}
    </section>
  );
}

export function AccountPage() {
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="page-head"><div><h1>Your account</h1></div></div>
      <Profile />
      <Password />
      <DeleteAccount />
    </div>
  );
}
