import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type ComponentProps } from "react";
import type { RunMini, RunStatus, Severity, IssueStatus } from "../api/types";
import { errorMessage } from "../api/client";
import { ago, fmtDate } from "../lib/format";
import { Link } from "react-router-dom";

// ── Buttons & fields ─────────────────────────────────────────────────────────

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" | "ghost"; size?: "sm"; busy?: boolean };
export function Button({ variant, size, busy, className = "", children, disabled, ...rest }: BtnProps) {
  return (
    <button className={`btn ${variant ?? ""} ${size ?? ""} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <span className="spinner" aria-hidden="true" style={{ width: 14, height: 14 }} />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, id }: { label: string; hint?: ReactNode; error?: string; children: (id: string) => ReactNode; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className="field">
      <label htmlFor={fid}>{label}</label>
      {children(fid)}
      {hint && !error && <span className="hint" id={`${fid}-hint`}>{hint}</span>}
      {error && <span className="err" role="alert">{error}</span>}
    </div>
  );
}

export const Input = (p: ComponentProps<"input">) => <input className="input" {...p} />;

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="alert error" role="alert">{errorMessage(error)}</div>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="loading" role="status"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

// ── Status language ──────────────────────────────────────────────────────────

const RUN_LABEL: Record<RunStatus, string> = { passed: "Passed", failed: "Failed", env_error: "Environment problem" };
export const RunStatusLabel = ({ status }: { status: RunStatus }) => <span className={`status ${status}`}>{RUN_LABEL[status]}</span>;
const ISSUE_LABEL: Record<IssueStatus, string> = { open: "Open", known: "Accepted", ignored: "Ignored", fixed: "Fixed" };
export const IssueStatusLabel = ({ status }: { status: IssueStatus }) => <span className={`status ${status}`}>{ISSUE_LABEL[status]}</span>;
export const SeverityLabel = ({ s }: { s: Severity }) => <span className={`sev ${s}`}>{s}</span>;

/** The run-history ribbon: one bar per run, oldest left. Empty slots are shown as dashed ghosts. */
export function Ribbon({ runs, size, linkTo, slots = 14 }: { runs: RunMini[]; size?: "lg"; linkTo?: (r: RunMini) => string; slots?: number }) {
  const ghosts = Math.max(0, slots - runs.length);
  const passed = runs.filter((r) => r.status === "passed").length;
  const label = runs.length ? `Last ${runs.length} runs: ${passed} passed, ${runs.length - passed} did not pass` : "No runs yet";
  return (
    // With links it is a group of links (an "img" can't contain interactive children)
    <span className={`ribbon ${size ?? ""}`} role={linkTo ? "group" : "img"} aria-label={label}>
      {Array.from({ length: ghosts }, (_, i) => <span key={`g${i}`} className="bar ghost" />)}
      {runs.map((r) => {
        const title = `${RUN_LABEL[r.status]} · ${r.suite} · ${fmtDate(r.createdAt)}`;
        return linkTo ? (
          <Link key={r.id} to={linkTo(r)} className={`bar ${r.status}`} title={title} aria-label={title} />
        ) : (
          <span key={r.id} className={`bar ${r.status}`} title={title} />
        );
      })}
    </span>
  );
}

export const When = ({ at }: { at: string | null | undefined }) => (at ? <time dateTime={at} title={fmtDate(at)}>{ago(at)}</time> : <span className="muted">Never</span>);

// ── Copy ─────────────────────────────────────────────────────────────────────

export function CopyField({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy">
      <code aria-label={label}>{value}</code>
      <Button
        type="button"
        onClick={async () => {
          try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { setDone(false); }
        }}
      >
        {done ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

export function Modal({ title, description, onClose, children, footer }: { title: string; description?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // onClose is usually an inline arrow; keep the latest in a ref so focus is
  // set once on open, not again on every parent re-render (which stole focus mid-typing).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input:not([disabled]), select, textarea, button");
    first?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, []);
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <header>
          <h2 id={titleId}>{title}</h2>
          {description && <p className="muted">{description}</p>}
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/** Confirmation for destructive actions; the button repeats the action's name. */
export function Confirm({ title, body, action, onConfirm, onClose }: { title: string; body: ReactNode; action: string; onConfirm: () => Promise<unknown>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try { await onConfirm(); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); }
            }}
          >
            {action}
          </Button>
        </>
      }
    >
      <p>{body}</p>
      <ErrorAlert error={err} />
    </Modal>
  );
}

// ── Toasts ───────────────────────────────────────────────────────────────────

interface Toast { id: number; text: string; kind: "ok" | "error" }
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
