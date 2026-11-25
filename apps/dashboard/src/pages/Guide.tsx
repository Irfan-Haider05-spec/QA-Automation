import { Link } from "react-router-dom";
import { useCurrentOrg } from "../lib/org";
import { startTour } from "../components/Tour";

/** In-app integration guide: how to put VeriQ on a project, end to end. */
export function GuidePage() {
  const { orgId, can } = useCurrentOrg();
  const platform = location.origin;
  return (
    <div className="page guide">
      <div className="page-head">
        <div>
          <h1>Integration guide</h1>
          <p className="sub">How to put VeriQ on a project — from the first local check to CI and this dashboard.</p>
        </div>
        <button type="button" className="btn" onClick={startTour}>Take the tour</button>
      </div>

      <section className="panel">
        <div className="panel-body">
          <p>
            VeriQ tests a project from the outside: it reads the code to find routes, roles and the login,
            then runs read-only checks against a running staging copy. <b>Nothing from VeriQ ships inside your
            app</b> — you add a config file and a CI workflow, nothing more. The order is always: local source
            checks first, then read-only live checks on staging, then CI, then this platform.
          </p>
          <p className="muted small">
            In the commands below, <code>qa</code> means <code>node &lt;path-to-veriq&gt;/bin/qa.mjs</code>.
            Run it from the project you want to test.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>1 · Prepare</h2></div>
        <div className="panel-body">
          <ul className="bullets">
            <li>In the VeriQ folder, run <code>npm ci</code> once (Node 20 or newer).</li>
            <li>In the project, make a branch: <code>git checkout -b veriq-setup</code>.</li>
            <li>
              On staging, create <b>one dedicated QA account per role</b> (e.g. admin, manager, customer)
              through the app's normal sign-up or admin flow. Never use real users — a run may log the
              account out of other sessions.
            </li>
            <li>No Express backend? Export the API's OpenAPI 3 or a Postman collection for the next step.</li>
          </ul>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>2 · Generate the config with <span className="mono">qa init</span></h2></div>
        <div className="panel-body">
          <p>From the project's folder:</p>
          <pre className="code">{`qa init --ci --action your-org/qa-agent@v1`}</pre>
          <p className="muted small">
            Backend in a subfolder? add <code>--backend-dir server</code>. No Express source?
            <code> --openapi openapi.json</code>.
          </p>
          <p>It reads the backend (TypeScript or JavaScript, ES imports or <code>require</code>), finds the API
            prefix, login route, roles and open routes, and writes — never overwriting a file:</p>
          <ul className="bullets">
            <li><code>qa.config.ts</code> — what to check: backend, login, accounts, public routes, suites</li>
            <li><code>.env.qa.example</code> — the variable names your <code>.env.qa</code> will need</li>
            <li><code>.github/workflows/veriq.yml</code> — source checks on every pull request</li>
            <li><code>.gitignore</code> gains <code>.env.qa</code> and <code>qa-out/</code></li>
          </ul>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>3 · Review <span className="mono">qa.config.ts</span></h2></div>
        <div className="panel-body">
          <p>Open it and check every line marked <code>CHECK</code>:</p>
          <ul className="bullets">
            <li><b>login</b>: the request body and where the token is in the response. Log in once with Postman to confirm.</li>
            <li>
              <b>publicRoutes</b>: only routes that are meant to be open without login (login, health, webhooks).
              Every other open route is left as a commented suggestion — decide for each whether to add auth or
              mark it public. When in doubt, leave it; VeriQ keeps reporting it.
            </li>
            <li><b>accounts</b>: one per role. Remember the names (e.g. <code>admin</code>) — you'll enter them on this platform later.</li>
          </ul>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>4 · First run, no server needed</h2></div>
        <div className="panel-body">
          <pre className="code">{`qa run --suite pr`}</pre>
          <p>This reads the source only: routes without auth, secrets in code, <code>.env.example</code> drift,
            weak dependencies, missing validation, MongoDB indexes. Put each finding in one of three buckets:</p>
          <ul className="bullets">
            <li><b>Real bug, quick</b> — fix it now.</li>
            <li><b>Real bug, slow</b> — open a ticket, then baseline it (step 5).</li>
            <li><b>False finding</b> — fix the config (e.g. <code>publicRoutes</code>) and run again.</li>
          </ul>
          <p className="muted small">Never weaken a check to go green. Fix the cause, or baseline a known issue so only new ones block.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>5 · Baseline, so only new issues block</h2></div>
        <div className="panel-body">
          <pre className="code">{`qa run --suite pr --baseline
git add qa-known-issues.json`}</pre>
          <p>After this, the gate fails only on <b>new</b> high/critical findings; existing ones stay visible as
            "known". Don't baseline criticals — fix them.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>6 · Live checks on staging (read-only)</h2></div>
        <div className="panel-body">
          <pre className="code">{`cp .env.qa.example .env.qa     # set QA_BASE_URL and each account's id / password
qa run --suite staging`}</pre>
          <p>This checks login, each role's access, CORS, health and a smoke test of every route. Writing
            requests (create / update / delete) are <b>off</b> by default; they run only with
            <code> QA_ALLOW_MUTATIONS=true</code> <b>and</b> <code>QA_DISPOSABLE=true</code>, and only against a
            throwaway database — never shared staging.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>7 · Commit and open a pull request</h2></div>
        <div className="panel-body">
          <pre className="code">{`git add qa.config.ts .env.qa.example .gitignore qa-known-issues.json .github/workflows/veriq.yml
git status      # .env.qa must NOT be listed
git commit -m "Add VeriQ"
git push -u origin veriq-setup`}</pre>
          <p>The VeriQ job runs on the PR, posts a comment and sets a "QA gate" status. Once it's stable for a
            week, make that check required on <code>main</code> (repo Settings → Branches).</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>8 · Connect it to this platform</h2></div>
        <div className="panel-body">
          <ol className="steps">
            <li>{can("projects.create")
              ? <>Create the project: <Link to={`/o/${orgId}/projects?new=1`}>New project</Link>.</>
              : <>Ask an admin to create the project here.</>}</li>
            <li>In the project, add the <b>staging</b> environment and its API base URL, then <b>verify the domain</b> (hosted runs only test verified domains).</li>
            <li>Store the <b>test accounts</b> — the same names as in <code>qa.config.ts</code>. They're encrypted in the vault; passwords never go into CI secrets.</li>
            <li>Create an <b>API key</b> (tick <i>Can read test-account passwords</i> so CI uses the stored accounts).</li>
            <li>The project's <b>CI setup</b> tab generates the exact workflow and the repository secrets to add.</li>
          </ol>
          <p className="muted small">
            With this platform, the GitHub variable <code>QA_PLATFORM_URL</code> is <code>{platform}</code>, and
            every run shows up under Reports.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Going deeper, once the basics run</h2></div>
        <div className="panel-body">
          <ul className="bullets">
            <li><b>Business scenarios</b> (<code>qa-scenarios/*.yaml</code>) — real rules, e.g. "an expired promotion can't apply at checkout". <code>scenario-lint</code> checks they still match the backend on every PR.</li>
            <li><b>Data checks</b> (<code>qa-db-checks/*.yaml</code>) — bad data inside the database, via a read-only DB user.</li>
            <li><b>Write tests</b> — a throwaway database with seeded QA accounts in the PR job (<code>QA_ALLOW_MUTATIONS</code> + <code>QA_DISPOSABLE</code>).</li>
            <li><b>Web dashboards &amp; mobile</b> — the <code>web</code> and <code>mobile</code> sections of the config.</li>
            <li><b>Alerts</b> — <Link to={`/o/${orgId}/notifications`}>Notifications</Link> for Slack or email on failed gates and returning issues.</li>
          </ul>
          <p className="muted small">The <code>integrations/mlitech</code> folder in the VeriQ repo is a complete worked example — the best template for a new project.</p>
        </div>
      </section>
    </div>
  );
}
