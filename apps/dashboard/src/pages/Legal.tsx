/**
 * Terms of use and privacy notice. Operator name and contact come from the build
 * (VITE_OPERATOR_NAME, VITE_CONTACT_EMAIL). The text is a plain-language starting
 * point describing what this software does with data; have it reviewed before
 * offering the platform to customers.
 */
import { Link } from "react-router-dom";
import { Logo } from "../layout/AppShell";

const OPERATOR = (import.meta.env.VITE_OPERATOR_NAME as string | undefined) || "the operator of this platform";
const CONTACT = (import.meta.env.VITE_CONTACT_EMAIL as string | undefined) || "";
const UPDATED = "8 November 2026";

function LegalLayout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="legal">
      <header className="legal-head">
        <Link to="/" className="brand" style={{ padding: 0 }}><Logo /> QA Platform</Link>
        <nav aria-label="Legal"><Link to="/terms">Terms</Link> <Link to="/privacy">Privacy</Link></nav>
      </header>
      <main id="main" className="legal-body">
        <h1>{title}</h1>
        <p className="muted small">Last updated {UPDATED}. Provided by {OPERATOR}.</p>
        {children}
        <p className="muted small">Questions: {CONTACT ? <a href={`mailto:${CONTACT}`}>{CONTACT}</a> : "contact the person who invited you, or the administrator of this platform"}.</p>
      </main>
    </div>
  );
}

export function TermsPage() {
  return (
    <LegalLayout title="Terms of use">
      <h2>What the service does</h2>
      <p>The QA Platform runs automated checks against software you control (APIs, dashboards, mobile apps) and keeps the results: findings, evidence such as requests and screenshots, and reports.</p>
      <h2>Your responsibilities</h2>
      <ul>
        <li>Only point the platform at systems you own or are allowed to test. Hosted runs only test domains you have verified.</li>
        <li>Use dedicated test accounts, not real customers' logins. Mark an environment as disposable only if its data may be changed or deleted.</li>
        <li>Keep your password and API keys secret, and remove access for people who leave your team.</li>
        <li>Don't use the platform to attack, overload or probe systems of others.</li>
      </ul>
      <h2>Results</h2>
      <p>Checks reduce risk but can't prove software is free of defects. A passing run means no problems were found by the checks that ran, not that none exist.</p>
      <h2>Availability and changes</h2>
      <p>{OPERATOR[0].toUpperCase() + OPERATOR.slice(1)} may change, pause or end the service and will tell organization owners about significant changes in advance where possible. You can delete projects and organizations at any time from their settings.</p>
      <h2>Liability</h2>
      <p>To the extent the law allows, the service is provided as it is, and {OPERATOR} is not liable for indirect losses caused by using it or by relying on its results.</p>
    </LegalLayout>
  );
}

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy notice">
      <h2>What we store</h2>
      <ul>
        <li><b>Your account:</b> name, email address, a hash of your password (never the password itself), and the organizations you belong to.</li>
        <li><b>Your organization's setup:</b> projects, environment URLs, members and their roles, notification settings.</li>
        <li><b>Test-account logins</b> you add for your environments, encrypted (AES-256-GCM) and only decrypted to hand them to a run.</li>
        <li><b>Run results:</b> findings with evidence (request summaries with tokens removed, response snippets, screenshots), deployments and commit details from CI.</li>
        <li><b>An audit log</b> of changes made in each organization (who did what, when).</li>
        <li><b>Request logs</b> for security and troubleshooting: time, route, status and IP address, without request bodies, tokens or email addresses.</li>
      </ul>
      <h2>What we use it for</h2>
      <p>Only to run the service: performing checks, showing results, sending the alerts and emails you set up (failed gates, password resets, email confirmation), and keeping the service secure. No advertising, and data isn't sold.</p>
      <h2>Who can see it</h2>
      <p>Members of your organization, according to their role; people you send a report share link to (only the report, without request details, until the link expires or is turned off); and the administrators who operate the platform, when needed to run or secure it.</p>
      <h2>How long we keep it</h2>
      <p>Until you delete it. Deleting a project or organization removes its data; deleting your account removes your personal details (audit entries keep a reference to the action, not your profile).</p>
      <h2>Your choices</h2>
      <p>Under <b>Your account</b> you can change your name and password and delete your account; reports can be exported from the Reports page. Contact {CONTACT ? <a href={`mailto:${CONTACT}`}>{CONTACT}</a> : "the platform administrator"} for anything you can't do yourself.</p>
    </LegalLayout>
  );
}
