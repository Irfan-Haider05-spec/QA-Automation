import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../../layout/AppShell";

const demo = ["passed", "passed", "failed", "passed", "passed", "env_error", "passed", "failed", "failed", "passed", "passed", "passed"];

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-form">
        <div className="inner">
          <div className="brand" style={{ padding: 0 }}><Logo /> QA Platform</div>
          {children}
          <p className="auth-legal muted small"><Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link></p>
        </div>
      </div>
      <aside className="auth-side" aria-hidden="true">
        <span className="ribbon lg">{demo.map((s, i) => <span key={i} className={`bar ${s}`} />)}</span>
        <h2>Every deploy checked for broken auth, data leaks and crashes.</h2>
        <p>Connect a project and a staging URL. Each pull request, deploy and night gets a pass/fail answer with the request, screenshot and line of code behind every finding.</p>
      </aside>
    </div>
  );
}
