import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useCurrentOrg } from "../lib/org";
import { NotFoundPage } from "../pages/NotFound";
import { useSignupOptions } from "../api/queries";
import { api } from "../api/client";

const ROLE_NAME = { owner: "Owner", admin: "Admin", developer: "Developer", viewer: "Viewer" } as const;

export const Logo = () => (
  <svg className="veriq-logo" width="156" height="52" viewBox="240 210 1280 440" role="img" aria-label="VeriQ">
    <image href="/branding/veriq-wordmark.png" width="1774" height="887" />
  </svg>
);

function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOut(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onOut(); };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [ref, onOut]);
}

function OrgSwitcher() {
  const { orgs } = useAuth();
  const { org } = useCurrentOrg();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useOutside(ref, () => setOpen(false));
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="switcher" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="org-switcher">
        <span>
          {org?.name}
          <span className="role">{org ? ROLE_NAME[org.role] : ""}{org?.clientIds ? " · limited to some clients" : ""}</span>
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          {orgs.map((o) => (
            <button key={o.id} role="menuitem" className={o.id === org?.id ? "current" : ""} onClick={() => { setOpen(false); nav(`/o/${o.id}`); }}>
              {o.name}
            </button>
          ))}
          <hr />
          <button role="menuitem" onClick={() => { setOpen(false); nav(`/o/${org?.id}/settings#new-org`); }}>Create organization</button>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useOutside(ref, () => setOpen(false));
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="switcher" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>{user?.name}<span className="role">{user?.email}</span></span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu" style={{ top: "auto", bottom: "calc(100% + 4px)" }}>
          <button role="menuitem" onClick={() => { setOpen(false); nav(`${location.pathname.match(/^\/o\/[^/]+/)?.[0] ?? ""}/account`); }}>Your account</button>
          <button role="menuitem" onClick={async () => { await logout(); nav("/login"); }}>Log out</button>
        </div>
      )}
    </div>
  );
}

/** "Confirm your email" until the address is verified (only when the platform sends email) */
function VerifyBanner() {
  const { user } = useAuth();
  const options = useSignupOptions();
  const [state, setState] = useState<"idle" | "busy" | "sent" | string>("idle");
  if (!user || user.emailVerified !== false || !options.data?.emailVerification) return null;
  return (
    <div className="alert warn verify-banner" role="status">
      Confirm <b>{user.email}</b> with the link we emailed you, so alerts and account emails reach you.{" "}
      {state === "sent" ? <span>New link sent.</span> : (
        <button type="button" className="linklike" disabled={state === "busy"} onClick={async () => {
          setState("busy");
          try { await api("POST", "/auth/resend-verification"); setState("sent"); } catch (e) { setState((e as Error).message); }
        }}>Send the link again</button>
      )}
      {state !== "idle" && state !== "busy" && state !== "sent" && <span> {state}</span>}
    </div>
  );
}

export function AppShell() {
  const { org, orgId, can } = useCurrentOrg();
  useEffect(() => { if (org) { try { localStorage.setItem("qa.lastOrg", org.id); } catch { /* ignore */ } } }, [org]);
  if (!org) return <div className="main"><NotFoundPage what="organization" /></div>;
  const base = `/o/${orgId}`;
  return (
    <div className="shell">
      <aside className="rail" aria-label="Main navigation">
        <div className="brand"><Logo /></div>
        <OrgSwitcher />
        <nav>
          <NavLink to={base} end>Overview</NavLink>
          <NavLink to={`${base}/projects`}>Projects</NavLink>
          <NavLink to={`${base}/clients`}>Clients</NavLink>
          <NavLink to={`${base}/reports`}>Reports</NavLink>
          <NavLink to={`${base}/notifications`}>Notifications</NavLink>
          <NavLink to={`${base}/members`}>Members</NavLink>
          {can("audit.read") && <NavLink to={`${base}/audit`}>Audit log</NavLink>}
          <NavLink to={`${base}/settings`}>Settings</NavLink>
        </nav>
        <div className="spacer" />
        <div className="rail-foot"><UserMenu /></div>
      </aside>
      <main className="main" id="main">
        <VerifyBanner />
        <Outlet />
      </main>
    </div>
  );
}
