import { API_BASE } from "../api/client";
/**
 * A shared report, opened from a link without an account (/r/:token).
 * Talks to the public endpoint directly: no session, no refresh logic.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { Report } from "../api/types";
import { ReportView } from "../components/ReportView";
import { Button, Loading } from "../components/ui";

export function PublicReportPage() {
  const { token = "" } = useParams();
  const [state, setState] = useState<{ report?: Report; expiresAt?: string; missing?: boolean; error?: string }>({});
  useEffect(() => {
    let live = true;
    fetch(`${API_BASE}/public/reports/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (!live) return;
        if (r.status === 404) return setState({ missing: true });
        if (!r.ok) return setState({ error: `The report couldn't be loaded (${r.status}). Try again in a moment.` });
        const j = await r.json();
        setState({ report: j.report, expiresAt: j.expiresAt });
      })
      .catch(() => live && setState({ error: "The report couldn't be loaded. Check your connection and try again." }));
    return () => { live = false; };
  }, [token]);
  useEffect(() => { if (state.report) document.title = `${state.report.scope.name}: quality report`; }, [state.report]);

  return (
    <main className="public-shell">
      {state.missing ? (
        <div className="panel" style={{ padding: 32, maxWidth: 480, textAlign: "center", display: "grid", gap: 8 }}>
          <h1>This link has expired</h1>
          <p className="muted">It may have been turned off or its time ran out. Ask the person who sent it for a new link.</p>
        </div>
      ) : state.error ? (
        <div className="alert error" role="alert">{state.error}</div>
      ) : !state.report ? <Loading /> : (
        <>
          <div className="public-bar">
            <span className="muted small">Shared report · link works until {new Date(state.expiresAt!).toLocaleDateString()}</span>
            <Button onClick={() => window.print()}>Download PDF</Button>
          </div>
          <ReportView report={state.report} />
        </>
      )}
    </main>
  );
}
