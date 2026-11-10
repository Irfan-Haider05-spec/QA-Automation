import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, session, setSignedOutHandler } from "../api/client";
import type { OrgSummary, User } from "../api/types";

interface AuthState {
  status: "loading" | "signed-in" | "signed-out";
  user: User | null;
  orgs: OrgSummary[];
  login(email: string, password: string): Promise<void>;
  signup(input: { name: string; email: string; password: string; orgName?: string; createOrg?: boolean; inviteToken?: string }): Promise<{ orgId: string | null }>;
  logout(): Promise<void>;
  reload(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuthState["status"]>(session.get() ? "loading" : "signed-out");
  const [user, setUser] = useState<User | null>(null);
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);

  // Only the newest reload's answer counts: an older, slower /auth/me must not overwrite fresher data
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    if (!session.get()) {
      setStatus("signed-out");
      return;
    }
    try {
      const me = await api<{ user: User; orgs: OrgSummary[] }>("GET", "/auth/me");
      if (mine !== seq.current) return;
      setUser(me.user);
      setOrgs(me.orgs);
      setStatus("signed-in");
    } catch {
      if (mine !== seq.current) return;
      session.clear();
      setStatus("signed-out");
    }
  }, []);

  const signedOut = useCallback(() => {
    session.clear();
    qc.clear();
    setUser(null);
    setOrgs([]);
    setStatus("signed-out");
  }, [qc]);

  useEffect(() => {
    setSignedOutHandler(signedOut);
    reload();
    // Another tab signed in or out
    const onStorage = (e: StorageEvent) => { if (e.key === "qa.session") { if (!e.newValue) signedOut(); else reload(); } };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reload, signedOut]);

  const value = useMemo<AuthState>(
    () => ({
      status, user, orgs, reload,
      async login(email, password) {
        const r = await api<{ tokens: { accessToken: string; refreshToken: string } }>("POST", "/auth/login", { email, password });
        session.set(r.tokens);
        qc.clear();
        await reload();
      },
      async signup(input) {
        const r = await api<{ tokens: { accessToken: string; refreshToken: string }; org: { id: string } | null }>("POST", "/auth/signup", input);
        session.set(r.tokens);
        qc.clear();
        await reload();
        return { orgId: r.org?.id ?? null };
      },
      async logout() {
        const s = session.get();
        if (s) await api("POST", "/auth/logout", { refreshToken: s.refreshToken }).catch(() => {});
        signedOut();
      },
    }),
    [status, user, orgs, reload, qc, signedOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
