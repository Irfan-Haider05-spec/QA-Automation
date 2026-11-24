# VeriQ validation and fixes

## Generic product and `qa init` — 23 November 2026

**Why:** the root `qa.config.ts`, `seed/seed-ci.ts`, `workflows/backend-qa-agent.yml` and
`known-issues.json` were MLITech's, so the repository looked like it was testing one project.
They moved to `integrations/mlitech/` (`qa.local.config.ts`, `seed-ci.ts`,
`qa-without-platform.yml`, `known-issues.json`, `.env.qa.example`); paths inside them were
adjusted to their new folder. The root `.env.qa.example` now lists generic names only.

**Self-test report "Gate failed":** this is the intended result. `test/fixture-api` has
planted bugs and the workflow asserts that the gate fails (`exit-code` 1). The report title
now says so: "VeriQ self-test: planted bugs (the gate must fail)".

**`qa init`** (new, `src/core/init-project.ts`, `test/init-project.test.ts`, 5 tests):

| Check | Result |
|---|---|
| CommonJS app (`require`, routes declared in the index, mounted `require("./x")`) | 7 routes, each found once; login body field `username` taken from the handler |
| Fixture backend: generated config loaded and run | `POST /admin/create-admin` still reported critical, the open export reported |
| Existing `.env.qa.example`, second `init`, CRLF `.gitignore` | file kept, config not overwritten (exit 2), one `.gitignore` addition in the file's own line endings |
| No backend | OpenAPI starter; `--backend-dir` with `--openapi` exits 2; placeholder action gets a CHECK comment |
| MLITech backend (`ac766c4`) | 202 routes, 9 roles, 13 routes public by nature; `create-admin` and exports left in the review list; generated config ran with 176 findings, 17 blocking |

Mutation check: accepting every open route as public, removing `require()` resolution, and
overwriting existing files each made the init tests fail (2, 2 and 1 failures); the code was
restored and the hashes compared.

**Root causes fixed during development:** the first `init` accepted every unauthenticated
route as public, which would have hidden critical findings (now only login, health,
webhooks and similar are accepted); the generated config skipped the MongoDB and log checks
because they need a `pluginSettings` entry (added); discovery missed CommonJS apps (added).

**Runs:**

| Suite | Result |
|---|---|
| Engine typecheck and workspaces | passed |
| `test:expanded` with real PostgreSQL 16, MariaDB 10.11 and MongoDB 8.3.7 | 211 tests: 207 passed, 2 skipped (k6 and MobSF prerequisites), 2 failed (Firefox and WebKit cannot be installed in this sandbox, unchanged; the download is blocked) |
| `selftest`, `test:action` | all checks passed |
| `runner:test` | 13 passed |
| API on PGlite and on real PostgreSQL (RLS roles) | 122 passed each |
| Clean `npm ci` from the user's `package-lock.json`, then typecheck, `test:action`, `selftest`, init tests | all passed |

Dashboard code was not changed in this round.

## CI typecheck fix: optional MySQL driver — 23 November 2026

GitHub's self-test failed at `npm run typecheck`: `test/db-checks.test.ts` imported
`mysql2/promise` by name. `mysql2` is optional and is not in `package.json`; the engine loads
it with a computed name in `src/core/db.ts`. The sandbox had it installed without saving
(for the real-server test), which hid the error. The test now loads it the same way as the
engine.

This time the fix was checked the way CI runs it. The repository was copied without
`node_modules`, installed with `npm ci` from the user's own `package-lock.json` (no `mysql2`,
no `mongoose`), then the engine, API, runner and dashboard typechecks, the GitHub Action
simulation and the self-test were run: all passed. With a real MariaDB server the MySQL test
still passes (6 of 6); without one it is skipped as before.

## Live MLITech acceptance, scenario lint, Newman reports and UAT evidence — 19 November 2026

### How the live run was set up

The MLITech backend (`tmhdigital/loyalty-backend-code`, commit `ac766c4`) was built with
`npm run build` and started twice (ports 5004 and 5005, one Redis), on MongoDB 8.3.7 started
as a single-node replica set. MongoDB came from the conda-forge package (a package
registry); Docker Hub is blocked here. VeriQ's CI seed (now `integrations/mlitech/seed-ci.ts`) created the QA accounts
(now with an active customer subscription, which checkout requires), with the environment
values from `integrations/mlitech/qa.yml`. All data was local and thrown away; nothing was
sent outside the sandbox. This session's work before a pause had already made this setup;
it was not written to F: or documented then, so every result below was produced again in
this round with the current code.

### Results on the real backend

| Check | Result |
|---|---|
| PR suite (`integrations/mlitech/qa.config.ts --suite pr`, 12 checks, 539 requests) | Gate failed: 11 critical, 18 high, 66 medium, 7 low |
| api-auth | 4 routes answer without a token (the 3 report exports, `GET /tier/merchant/:userId`) |
| api-scenarios (13 MLITech scenarios) | 4 passed, 9 failed (below) |
| scenario-lint | 0 problems: every scenario path, account and variable matches the backend |
| db-checks (10 rules) | 0 findings on the seeded data |
| tenant-isolation | Merchant B can read merchant A's promotion through `GET /promo-merchant/:id`, a route without auth; the team must say whether promotion details are public |
| socket-fanout | `salesActivation` reaches every connected user (`io.emit`); a test notification reached no socket; 4 sockets of one user stay open (cap 3) |
| api-smoke | 2 routes return 500 (`/merchant/customer-chart-week`, and the business-customer export without dates) |
| health-cors | The look-alike origin probes were all refused; a refused origin returns 500 (low) |
| injection-probes (3 cases, 36 requests) | No injection; an operator object in the customer search causes a 500 (medium) |
| mongo-indexes live (27 collections, 220 query plans) | 31 findings, 2 high: the unique `email` and `phone` indexes cannot be built |

Failed scenarios, each checked against the code:

1. A customer can open `GET /usermanagement/merchants/all-users` (200, expected 403).
2. Sign-up accepts `verified`, `subscription` and points from the body: the account logs in
   without verification, and the database holds `verified: true`, `subscription: active`
   and 99999 points for it.
3. `POST /user/create-admin` without a token creates a verified `SUPER_ADMIN` (seen in the
   database).
4. Merchant B can change merchant A's promotion (`findByIdAndUpdate` by id only). From the
   code, delete and toggle have the same gap, and so do tier update and delete.
5. An expired promotion is applied at checkout: checkout checks `expiryDate`, which
   promotions never set (they store `endDate`), and no job marks promotions expired.
6. to 8. A promotion is accepted with its end before its start, a 150% discount and a
   negative value.
9. Adding a VIP-only promotion as a new customer returns 500 instead of a client error.

The index finding was confirmed directly: `users` has no `email` or `phone` index, and
creating `{ email: 1 }` unique with `partialFilterExpression: { email: { $exists: true,
$ne: null } }` fails with "CannotCreateIndex". Mongoose only logs this at boot.

### VeriQ changes in this round

1. **`scenario-lint`** (new static plugin, 54 in total): checks scenario files against the
   discovered routes without a target. It reports unknown paths and methods, unknown
   accounts, variables used before they are defined, success expected from a route the
   account may not call, and bodies missing fields the route's validation requires.
   Refusal expectations are not questioned. Extra body fields are not reported, because
   zod strips unknown keys; an early version did report them, and the fixture showed that
   to be a false positive. A template on a `:param` is preferred over a literal route.
2. **Newman (Postman) JUnit**: Newman names assertions the same in every request. One
   pass and one failure under the same name were read as one test, so they merged in
   `test-results` and looked flaky in `flaky-tests`. When a name appears in more than one
   suite, the suite name is now put in front. Unique names, and repeats inside one suite,
   are unchanged, so existing history keeps matching.
3. **UAT automated evidence** (finished from the earlier work): scenario outcomes are
   uploaded per run (migration `016_run_cases.sql`, row-level security). A criterion
   linked to a scenario shows its latest result and can attach that run. New: `GET
   …/uat/scenarios` lists the project's scenario names with their latest result (optional
   tag filter). The criterion form suggests them.
4. **`mongo-indexes`** (from the earlier work): "Index can never be built" for unsupported
   `partialFilterExpression` operators (static), and "Declared index is missing from the
   database" (live).
5. **`injection-probes`**: a 500 on operator input is now titled "Operator input causes a
   server error". The earlier wording claimed the input reaches the database, which cannot
   be seen from outside: MLITech's sanitizer strips the `$` key and a string method then
   fails.
6. MLITech pack: `integrations/mlitech/qa-scenarios/` (13 scenarios) and
   `qa-db-checks/` (10 rules), wired into the PR suite with `scenario-lint`. The
   socket test paths were corrected (`/notifications/…`, as the backend mounts them).

Tests added: `test/scenario-lint.test.ts` (5), `test/junit-newman.test.ts` (3), the
scenario-list part of the UAT API test (with access checks), and a dashboard browser test
with an axe check: pick a scenario, see its latest result, and attach the run. Mutation
check: 12 deliberate faults. 11 were caught; the twelfth exposed redundant code in
scenario-lint, which was removed.

### Suites

| Suite | Result |
|---|---|
| Engine, API, runner and dashboard typechecks | Passed |
| `test:expanded` with real PostgreSQL 16, MariaDB 10.11 and MongoDB 8.3.7 | 206 tests: 202 passed, 2 skipped (k6 and MobSF prerequisites), 2 failed (Firefox and WebKit cannot be installed in this sandbox, unchanged) |
| MongoDB live tests (db-checks, scenario database steps, mongo-indexes live) | 3 passed |
| Self-test / GitHub Action simulation | All checks passed |
| Hosted runner | 13 passed |
| API on PGlite, and on PostgreSQL with the `qa_app` role and RLS | 122 passed each |
| Dashboard build | Passed (bundle-size warning unchanged) |
| Dashboard browser tests | 71 passed, 1 skipped (optional screen capture) |

### Not established

- The deployed staging: the run above used the repository's 23 October commit on a local
  throwaway database, not the team's current code or environment.
- Windows: the full suite has not been run on the user's machine in this round.
- MobSF and the recorder session (Chunks 2 and 3) are unchanged.

## Real-project acceptance, static part (MLITech backend) — 19 November 2026

Target: the public MLITech backend repository (`tmhdigital/loyalty-backend-code`, commit
`ac766c4`, 23 October 2026), cloned read-only into the sandbox. Its dependencies were
installed with `--ignore-scripts`; its `package-lock.json` was restored afterwards. No
deployment, staging URL, account or database was used, so only checks that read source,
configuration and the lockfile ran. Nothing was sent to a third party.

Checks run and how each result was verified by hand:

| Check | Result | Verification |
|---|---|---|
| route discovery | 202 routes, 25 request schemas | Compared with `src/app/routes/index.ts` and module routers |
| route-auth | 24 findings, 4 critical | All 4 critical confirmed in source (below); sampled role and duplicate-route findings confirmed |
| env-drift | 36 findings | `DATABASE_URL` vs `MONGODB_URI`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `REDIS_URL` confirmed |
| secrets | 0 | Independent pattern search found only `.env.example` placeholders |
| deps | 22 packages (2 critical, 14 high, 17 moderate advisories) | Matches `npm audit`; every advisory has a fix |
| validation-coverage | 59 routes | Sampled routes have no `validateRequest`; the unused `validateFormData` helper is not counted |
| code-quality | 0 | `tsc --noEmit` and `eslint src` run directly: 0 errors, 0 warnings |
| mongo-indexes | 33 findings (24 query shapes, 9 redundant indexes) | Sampled shapes (`User { fcmToken }`, `Token { token }`) have no index; `AdminTier { admin: 1 }` is a prefix of a compound index |
| log-hygiene | 0 | The winston format prints only the message, so logged error objects are not written |
| sast (Semgrep 1.185.0) | 20 matches | Rules from the public semgrep-rules repository (registry blocked here); the two regular-expression findings are real (below) |

No false positive was found among the verified findings.

### VeriQ problems found by this run, and the fixes

1. **Findings silently dropped (high).** Triage removed every finding whose fingerprint
   (plugin, title, target with numbers ignored) matched an earlier one, even when the
   problem was different. On MLITech, 14 of 33 missing-index findings (10 shapes of
   `User` became one) and 10 of 20 Semgrep matches (line numbers are ignored) disappeared
   without a trace. The same would happen to two new required parameters of one API
   operation, or to parameterised tests named `case 1` and `case 2`.
   - A finding may now carry a `key`, its exact identity, which is added to the
     fingerprint. Findings without a key keep exactly the fingerprint they had.
   - `mongo-indexes` targets are now the model plus the query shape or index
     (`User { fcmToken }`). `sast`/`container-iac` key on rule, file and position (or a
     real scanner hash), `api-contract` on title and detail, and `test-results` and
     `flaky-tests` on the exact test name.
   - Triage still drops exact repeats. A different finding that shares a fingerprint is
     merged into the kept one and listed in its detail, and the kept finding takes the
     worst severity and stays blocking if any occurrence is, so a merge can never weaken
     the gate.
   - One-time effect: the fingerprints of those five plugins change, so their known
     issues need `qa run --baseline` again, and on the platform their old issues close
     and new ones open once.
2. **Pull-request scanner runs reported nothing (high).** SARIF locations were compared
   as raw text with changed files, which are relative to the backend folder. Semgrep and
   Trivy write absolute paths when VeriQ runs them, so with `--changed-from` every match
   was filtered out. Absolute paths, `file://` URIs and paths relative to the configuration
   or backend folder are now all resolved. Targets are shown relative to the backend, not
   as a local machine path.
3. **One long finding could make the whole upload fail (medium, latent).** The engine
   accepts details of up to 20 000 characters, but the platform accepts 5 000 (titles and
   targets 500, reasons 2 000) and rejects the entire run otherwise. Uploads now shorten
   longer text with a marker pointing to `report.json`, and leave out the engine-only
   `key`.
4. **CORS bypass not detected (miss).** MLITech trusts any `*.vercel.app` origin that
   contains `rewaldo-admin` or `rewaldo-business`, with credentials. `health-cors` only
   probed one unrelated origin, so this could not be found. It now also probes, from each
   configured dashboard origin, an attacker-ownable look-alike (`https://app.example.com.qa-evil-origin.example`
   and `https://qa-evilapp.example.com`), the `http://` version of an `https://` origin, and
   the `null` origin. Ports in host names, IP addresses, single-label hosts and origins the
   project allows on purpose are not probed. Credentials decide high or medium.

Tests added: `test/triage.test.ts` (6) and `test/cors-probes.test.ts` (6). The CORS tests run
real HTTP servers, including one with MLITech's callback copied verbatim, one with an exact
allow-list (no findings) and ones with `startsWith`, an unanchored pattern and `null`. Two
`mongo-indexes` tests now assert the per-shape targets and that every finding survives triage.
Mutation check: 17 deliberate faults (probes disabled, no look-alike filter, severity ignoring
credentials, allowed origins not removed, ports ignored, 500 finding dropped, old changed-file
comparison, no scanner key, absolute display, no worst severity, merged flaky finding, key
ignored, reason or key in uploads, no keys in api-contract/test-results): all 17 caught.

### Results after the fixes

| Suite | Result |
|---|---|
| Engine, API, runner and dashboard typechecks | Passed |
| `test:expanded` with `QA_TEST_PG_URL` and `QA_TEST_MYSQL_URL` | 194 tests: 190 passed, 2 skipped (k6 and MobSF prerequisites), 2 failed (Firefox and WebKit cannot be installed in this sandbox, unchanged) |
| Self-test | All checks passed |
| GitHub Action simulation | All checks passed |
| Hosted runner | 13 passed |
| API on PGlite, and on PostgreSQL 16 with the `qa_app` role and RLS | 121 passed each |
| MLITech static run after the fixes | 174 findings (all present), 12 blocking, exit code 1; Semgrep 20 of 20 |

The dashboard was not changed in this round, so its build and browser tests were not rerun.

### Not established by this run

- Live checks (API authorization, tenant isolation, CORS, sockets, dashboards, flows)
  need a running MLITech deployment with QA accounts. The new CORS probes were tested
  against MLITech's callback in a local server, not against its deployment.
- The repository copy is from 23 October 2026; the team's current code may differ.
- MongoDB live analysis is still unvalidated (no server available here).
- Not detected by VeriQ, found by hand: `package-lock.json` is out of sync with
  `package.json` (`npm ci` fails), hidden because the Dockerfile and CI use `npm install`.
  Checking this needs a full semver resolver, which VeriQ does not have without a new
  dependency. Also by hand: morgan logs full URLs including payment-callback query
  parameters (low).

## Database checks, injection probes and UAT sign-off — 19 November 2026

Engine, API and runner typechecks and the dashboard build passed.

Test servers used in this Linux sandbox: PostgreSQL 16.15 (installed in the image, started
for the run), MariaDB 10.11.14 (installed with apt for the run), the `mysql2` driver
installed without changing `package.json` or `package-lock.json`, and embedded PostgreSQL
(PGlite). No MongoDB server could be obtained (not in the Ubuntu archive, download site
blocked, no Docker daemon).

`test/db-checks.test.ts`: **6 passed** with `QA_TEST_PG_URL` and `QA_TEST_MYSQL_URL` set
(without them, the two real-server tests are reported as skipped).
- **Same rules on all three engines** (embedded PostgreSQL, real PostgreSQL, real
  MariaDB): one orphan promotion, a case-insensitive duplicate email and an
  expired-but-active promotion are found with sample ids. Emails in samples are
  redacted. A missing table is reported as "could not run". A write hidden in a
  function is refused by the database's READ ONLY transaction, and the audit table
  stays empty.
- **Server time limits:** `pg_sleep(5)` is stopped by PostgreSQL's statement timeout
  and `SLEEP(5)` by MariaDB's limit, both within 4 seconds.
- **Passwords:** a wrong password is reported without showing it.
- **Row limit:** 10 005 rows are read as "10000 or more".
- **Validation before any query:** data-changing CTEs, multiple statements,
  comments, `SELECT … INTO`, templates inside SQL, `UPDATE`, `FOR UPDATE`, MongoDB
  fields for SQL and the reverse, `$out`, and duplicate names are all rejected, while
  literals and `replace()` are accepted.
- **MongoDB helpers:** forbidden stages and operators, Extended JSON to BSON, BSON
  to plain values, and a connection error without the password.

API scenarios with database steps: **9 passed**. A title returned by the fixture API is
checked against the stored row, the stored id is used in the next request, and a
missing row fails the step. A db step without a database setting, and a `DELETE`
query, are configuration errors. The database is unchanged afterwards.

Found by the real servers:
1. node-postgres returns `bigint` (for example `COUNT(*)`) as text, so `equals: 3`
   failed on real PostgreSQL but not on PGlite. Safe integers are now numbers, as with
   MySQL and PGlite.
2. `FOR UPDATE` was rejected with the less clear "UPDATE is not allowed"; the row-lock
   check now runs first.

`test/injection-probes.test.ts`: **6 passed**, against a test API (`test/injection-api.ts`)
whose SQL routes run real PostgreSQL queries built by string concatenation, next to
parameterised twins. Its NoSQL routes evaluate MongoDB-style operators the way an
unvalidated `findOne(req.body)` would; this is a simulation, since no MongoDB server was
available.
- **NoSQL:** an operator login bypass and a widened search are found (critical). A
  safe twin is quiet. A crash on operator input is reported as medium.
- **SQL:** a boolean bypass on a login and a search, an exposed syntax error, and a
  blind route by time delay (only with `timeBased`) are found. A parameterised route
  is quiet.
- **Safety:** no stacked or data-changing SQL is sent, and table counts are
  unchanged.
- **No false positives:** a flaky endpoint and an endpoint that treats any quote as a
  wildcard are not reported.
- **Inconclusive cases:** a control that is already "successful", or one refused for
  an account, is inconclusive. If every case is inconclusive, the check errors.
- **Gating:** the check is skipped outside a disposable environment.

Found by the tests:
1. A 401 control was treated as "the account does not work", so login bypasses (whose
   control is a normal 401) were never tested. The rule now applies only to cases run
   with an account.
2. The SQL Server `'; WAITFOR DELAY` payload was a stacked statement, contradicting the
   "no stacked statements" rule; it was removed and the docs say SQL Server time checks
   are not included.

UAT, API `apps/api/test/uat.test.ts`: **3 passed** on PGlite and on real PostgreSQL with
production roles (`qa_owner` migrations, API as `qa_app` with RLS). The full API suite
(**121**, including the isolation test that every org table has RLS) passed on both.
- **Release lifecycle:**
  - create with criteria;
  - a case-insensitive duplicate name is refused;
  - a failed result needs a note;
  - evidence must be a run of the same project;
  - developers cannot decide, and sign-off is refused (422) while a criterion is
    not passed;
  - an admin signs off.
- **Lock:** five kinds of change are refused with `release_locked`; reopening needs a
  reason; rejecting needs a reason.
- **Audit:** events are recorded for every step.
- **Report:** JSON and Markdown, with `|` and newlines escaped.
- **Access:** non-members get 404, as does a client-scoped member reaching another
  client's project, a release id under another project, and a release from another
  org. Viewers read only, and malformed ids get 404.

UAT, dashboard `e2e/uat.spec.ts`: **3 passed**, served with the production CSP.
- **Release flow:** create a release from the Acceptance tab (blank lines trimmed),
  record a pass with an evidence run and a failure with a required note; sign-off
  stays disabled until everything passed; then sign off.
- **Lock:** the forms disappear after the decision.
- **Report download:** `uat-v2-3-promotions.md` with the decision and rows.
- **Reopen and viewers:** reopening works, and a viewer sees results but no
  record/decide controls.
- **Accessibility:** axe (WCAG 2 A/AA) found no problems on the list, the
  new-release dialog, the release page and the sign-off dialog, and the browser
  logged no errors.

Mutation checks, each made a test fail and was restored:
- **Database checks (11):** PostgreSQL and MySQL not read-only, bigint as text, no
  keyword check, comments allowed, MongoDB writes allowed, truncation hidden, no
  default "no rows", unredacted samples, no default for db steps, db params not
  interpolated.
- **Database timeout:** removing the per-query PostgreSQL statement timeout alone did
  not fail a test, because the client sets the same limit for the connection. Removing
  both failed the timeout test, so the two layers are redundant, not untested.
- **Injection probes (11):** no repeat confirmation, no FALSE check, accepted control
  not inconclusive, account 401 ignored, any 401 inconclusive, no error-based, no
  time-based, query operators flattened, runs outside disposable environments, all
  inconclusive passing, crashes ignored.
- **UAT (9):** sign-off with open criteria, decided release editable, failed without
  note, foreign evidence run, reject without reason, developers deciding, unescaped
  Markdown, a release from another project, no RLS policy.

Full results in this Linux sandbox:
- **Engine suite:** `test:expanded` with the real database flags: 182 tests, 178
  passed, 2 skipped (k6/MobSF prerequisites), 2 failed only because Firefox and
  WebKit cannot be installed here.
- **Other suites:** selftest, `test:action`, runner (13/13), API (121/121 on PGlite
  and on real PostgreSQL) and dashboard e2e (70 passed, 1 skipped screenshot capture)
  passed.
- **Count test:** changed from 51 to 53 because two checks were added.
- **Still pending:** a Windows run and MongoDB acceptance.

## API scenarios — 18 November 2026

Engine, API and runner typechecks passed. New `test/api-scenarios.test.ts`: **8 passed**,
run against the repository's fixture backend (an Express API laid out like MLITech, with
planted defects) started for the test, using the real HTTP client and QA-account login.
Covered:
- read scenarios passing: status, time, headers, every/some, schema with an `objectid`
  format, saved variables;
- a planted tenant leak found (merchant B reads merchant A's promotion), with a critical
  finding naming step 2, HTTP 200 and a curl command without the token;
- snapshots: "not recorded" (blocking), recorded with `--baseline` (ignored fields
  removed), matched, then a changed value reported by path;
- the JSON and JUnit reports, with the JUnit read back by VeriQ's own parser;
- writing scenarios skipped outside a disposable environment, and inside one the
  planted "create is not persisted" defect caught at the read-back step;
- cleanup run after the failure, with a cleanup step whose variable was never saved
  skipped;
- tags from settings, `excludeTags` and `QA_SCENARIO_TAGS`, and no matching tag
  reported as skipped;
- time limits, query strings from `QA_*` variables, unknown variables, non-`QA_`
  variables refused, and an unreachable target;
- a step without expectations must return 2xx, later steps are not sent, and a path
  variable cannot add segments;
- configuration errors naming the file (invalid YAML, an unquoted `$.data[0]` with a
  hint, duplicate names, assertions without an operator, `$ref`, absolute URLs, unknown
  fields, invalid regex), plus JSON scenario files;
- JSON path, assertion, schema-subset and snapshot helpers.

Found and fixed while testing:
1. Pre-existing: the shared JUnit parser did not decode XML entities, so a test called
   "doesn't crash" was reported as "doesn&apos;t crash", and reporters writing
   `&#39;` instead would split one test into two identities in the flaky-test history.
   The 5 predefined entities and numeric references are now decoded; unknown entities
   and invalid references stay as written (entity expansion stays off, DOCTYPE is still
   refused). Test added to `flaky-tests`.
2. A step that already failed also produced "snapshot not recorded"; snapshot handling
   now runs only for steps without other failures.
3. "No JUnit file matches" was shown for scenario and log files; the message now names
   the kind of file.
4. In YAML flow style, `{ id: $.data[0].id }` is a syntax error; the error now says to
   quote such paths, and the docs and starter file show it.

Mutation checks, each made a test fail and was restored (18): writes without a
disposable environment, no cleanup after failure, continuing after a failed step, path
values not encoded, templates always strings, snapshots not compared, missing snapshots
silent, any environment variable allowed, no default 2xx, saved values ignored, no JUnit
escaping, `QA_SCENARIO_TAGS` ignored, inherited properties reachable, additional
properties ignored, secrets printed, unknown schema keywords accepted, ignore paths not
applied, snapshot noise on failed steps.

CLI with the starter file `examples/api-scenarios.yaml` on the fixture: read-only run 2
passed, 1 failed (tenant leak, critical), 2 writing scenarios skipped, exit 1; disposable
run also caught the unpersisted create, exit 1; `QA_SCENARIO_TAGS=smoke` ran the 2 smoke
scenarios, both passed, exit 0.

Full results in this Linux sandbox: `test:expanded` 169 tests, 165 passed, 2 skipped
(k6/MobSF prerequisites), 2 failed only because Firefox and WebKit cannot be installed
here; selftest, `test:action`, API (118/118), runner (13/13) and the dashboard build
passed. The registered-check count test changed from 50 to 51 because a check was added.

## Functionality audit — 18 November 2026

Scope: the target health check, every plugin's declared prerequisites against what it
actually uses, every CLI command, the dashboard build, end-to-end tests and dogfood
crawl, and VeriQ's own checks run on VeriQ's code. Fixes, each with a test:

1. Static-only runs failed when the API was down. The CLI health-checked the target
   whenever a URL was configured, so `--only code-quality` exited 3 if the API was
   unreachable. It now checks the target only when a selected check that will run talks
   to it (`targetNeeded` in the runner). Plugins declare this: by default, the `baseUrl`
   need or a non-static layer. `log-hygiene` (canary only), `load-stress` (k6 execution
   only) and `i18n-rtl` (RTL pages only) depend on their settings, and `tls-dns-mail`
   and `post-deploy-errors` never call the API. `test/target-health.test.ts` covers
   the decision and the real CLI with the target down: static checks are judged on
   their findings, and `health-cors` still exits 3.
2. `load-stress` with k6 execution and no target URL errored. It is now skipped with
   the same prerequisite message as other checks.
3. Route discovery stopped every run. A project whose backend is not Express-shaped
   could not run `--only secrets`. Discovery errors now stop a run only when a selected
   check reads routes (live checks, OpenAPI users, `route-auth`, `validation-coverage`).
   Checked on VeriQ's own repository: `secrets` ran with a warning, and `route-auth`
   still failed with the discovery error.
4. Errors thrown by synchronous CLI commands crashed with a stack trace and exit 1
   instead of `qa: message` and exit 2 (for example `uptime-export --file ../x.jsonl`).
   Every command now goes through the same error path. The uptime test asserts exit 2,
   the message and no stack trace.
5. `uptime-export` with a mistyped file printed an empty history. It now errors.
   `wait-for --timeout abc` returned "timed out" immediately; the value is now
   validated.
6. The dashboard's production Content-Security-Policy made the browser report an error
   on every page. Zod probes `new Function("")` (caught, but browsers still report the
   CSP violation). Found because `vite preview` now sends the same security headers as
   the Cloudflare `_headers` file (one shared definition), so the dogfood crawl and the
   e2e tests run under the production CSP. The dogfood crawl then reported the error
   on all 19 pages and six e2e tests failed on their "no browser errors" check. Fix:
   `@qa/shared/browser`, imported first by the dashboard, turns off Zod's compilation
   (validation results are unchanged), so the probe never runs. Afterwards: dogfood 0
   findings (no missing security headers either), e2e 67 passed, 1 skipped (the
   screenshot capture, which runs only with `SCREENSHOTS=1`). The generated `_headers`
   file is byte-for-byte unchanged.
7. `log-hygiene` and the Mongoose discovery skipped `.tsx`/`.jsx` files. Run on the
   dashboard, they read 7 of 51 files. Both now parse TSX/JSX in the right mode. A test
   puts a logging call after JSX, which a wrong parser mode misreads; the mutation test
   for that case fails as intended.
8. A false positive found by running `log-hygiene` on VeriQ: `console.log("::add-mask::"
   + secret)` registers a value for masking in GitHub Actions and is not a log line. It is
   no longer reported, with a test.

VeriQ checked by its own checks: `log-hygiene` source scan of the API, runner, engine and
dashboard found no leaks. `secrets` on the repository found only deliberate test-fixture
passwords in test files. Lighthouse, ZAP baseline, crawl and accessibility on the
dashboard: 0 findings.

CLI commands exercised: `help`, an unknown command (exit 2), `plugins` (50 listed),
`discover`, `wait-for`, `init` in an empty folder, `uptime-export`, `run` with an unknown
plugin, an unknown suite and a missing config (all exit 2 with a message), `record` and
`flow-import` without arguments.

Remaining warning, not a functional fault: the dashboard bundle is 587 kB (Vite
suggests code splitting).

Results in this Linux sandbox: engine suite 160 tests, 156 passed, 2 skipped (k6/MobSF
prerequisites), 2 failed only because Firefox and WebKit cannot be installed here.
Selftest, `test:action`, API (118/118), runner (13/13), the dashboard build and the
dashboard e2e tests (67 passed, 1 skipped) passed. Because `test:all` chains its steps with `&&`, it stops at those two browser failures
here, so the later steps were run one by one. A Windows run is still pending.

## MongoDB index check and log hygiene — 18 November 2026

Engine, API and runner typechecks passed.

`test/mongo-indexes.test.ts`: **6 passed**, on a backend fixture laid out like MLITech
modules (a `User` model with field, nested, array, text and compound indexes; a
`Promotion` model exported as `mongoose.models.X || mongoose.model(...)`; a `Category`
model with an inline schema and a custom collection; a service importing them, one
under another name). Covered: discovered models, indexes and collection names; 13
analysed queries, 2 dynamic, 1 unfiltered and 1 `$text` counted rather than guessed;
test files and `node_modules` ignored; eight unindexed shapes reported once each with
locations (including an `$or` branch, `countDocuments` through a renamed import,
`updateMany`, `distinct`, the first `$match` of `aggregate`, and a sort-only query); no
report for indexed fields; one duplicate and one redundant index; `knownIndexes`,
`ignoreModels`, an unknown model in `knownIndexes`, no backend; live-mode settings, and a
real driver connection to a closed port whose error does not contain the password;
plans in classic, slot-based and aggregate explain shapes; `$indexStats` (excluding
`_id`, unique, TTL and recently restarted); profiler grouping without filter values;
probe queries; settings validation.

Checked against real Mongoose 8.24.10 (installed only for this comparison): the fixture
models loaded in Mongoose produce exactly the indexes, options and collection names the
static discovery reports, and Mongoose itself warns about the duplicate `email` index
the check reports. The collection-name rules match `mongoose.pluralize()` on 37 names;
the test keeps that recorded table. My first expectation (`Leaf` → `leaves`) was wrong:
Mongoose uses `leafs`.

Not validated: the live mode against a real MongoDB server. No server can be started
here (no MongoDB binary, the download site is blocked, no Docker daemon) and none was
reachable from the connected computer's sandbox. Live acceptance against the
project's local or staging database is an open gap.

`test/log-hygiene.test.ts`: **5 passed**. Source: nine leaking logging calls found
(`logger`, `errorLogger`, `console`, `this.logger`, morgan with `:req[authorization]`)
and six safe ones not reported. Log output: password, token, header, JWT, key, database
URL, card, email, phone and ID rules by line on realistic lines, masked values and a
"invalid password: …" message not reported, and no value from the log appearing in any
finding; PII toggles and ignored domains. Canary against a local HTTP server writing a
real log file: a leaking API (critical finding with the field name), a safe API (pass),
a silent log (error), a log rotated during the request (read from the start), and no
canary outside a disposable environment while other parts still run.

Bug found by a test: the email rule matched `Pa55word@db.internal` inside
`mongodb://app:Pa55word@db.internal`, so a database password was counted as an email
(it is already reported as a database URL with a password). Matches inside a URL's
`//user:pass@host` part are no longer emails.

Design fix before testing: an unquoted value after `:` would have made "Invalid
password: user not found" a password hit. Unquoted values count only as `key=value`;
`:` needs a quoted value (or a number after a quoted JSON key).

Mutation checks, each made a test fail and was restored: mongo (14) — any index field
instead of the first, text indexes usable, spreads not dynamic, `$or` branches merged,
nested paths dropped, unique/sparse/partial redundancy, scanning `node_modules`/tests,
reporting unique/TTL as unused, ignoring the observation time, no URI scrubbing,
keeping profiler values, never detecting COLLSCAN, a dropped plural rule; log hygiene
(12) — silent logs passing, ignoring log rotation, reporting masked values, unquoted
`:` values, no Luhn check, URL credentials as emails, descending into any call,
flagging literal values, any object as a logger, canary without a disposable
environment, passing when nothing ran, ignoring the line offset. One mutation (always
reading the whole log after the canary) is equivalent: the canary is new each run, so
older lines cannot contain it.

CLI on the repository's fixture backend: `log-hygiene` passed (it only logs its port)
and `mongo-indexes` was skipped ("No Mongoose models found in 19 source file(s)"), not
passed.

Shared code changed: `secrets` exports its rules, the route discovery exports its import
resolver, and the Mongoose discovery exports its source-file walker; selftest, which
covers `secrets`, passed.

Full results in this Linux sandbox: `test:expanded` 158 tests, 154 passed, 2 skipped
(k6/MobSF prerequisites), 2 failed only because Firefox and WebKit cannot be installed
here; selftest, `test:action`, runner (13/13) and API (118/118) passed. The
registered-check count test changed from 48 to 50 because two checks were added. A
Windows run of the full suite is still pending.

## Flaky-test detection — 18 November 2026

Engine, API and runner typechecks passed. New `test/flaky-tests.test.ts`: **10 passed**,
each in a fresh temporary git repository with real JUnit files. Covered: history builds
up as "skipped, 1 of 5 runs" instead of passing; the same report is not recorded twice;
fail then pass on the same clean commit is confirmed after two runs; fail then pass
across an uncommitted edit is not; `flakyFailure` and `flakyError` are confirmed from one
report; across six commits, a test with four result changes is suspected while a fixed
regression and an always-failing test are not; window and `minFlips` settings; duplicate
names (a constant mix is not flaky, a changing one is); 60 retried tests are capped at 50
findings plus a count, and `maxFlakyTests` adds a blocking finding; sharded reports by
glob; missing, stale, DTD and empty reports; store paths outside the folder or with the
wrong extension; damaged, invalid, future-dated and symlinked histories error and are
left unchanged; runs without git; pruning by `maxRuns`; failure text never stored.

Pre-existing bug found while sharing the JUnit parser: `test-results` recognised
`flakyFailure` and `rerunFailure` but not `flakyError` (or `rerunError`), so a test that
errored and then passed on a rerun counted as a plain pass. The shared parser in
`src/core/junit.ts` recognises all four, and a test asserts `flakyError` in both checks.
The parser keeps the same safety limits (no DTD/entities, 20 MiB, nesting depth 50) and
never returns failure text. `observation-history.ts` now exports its lock and atomic
write so both histories use the same code; the uptime tests still pass.

A test found a weak ordering: findings with equal failure counts were sorted by name, so
a test with four result changes could appear after one with two. Findings are now
sorted by kind, then number of changes, then failures.

Mutation checks, each made a test fail and was restored (13): dirty runs counted as the
same commit, no duplicate-report check, no stale-report check, no "mixed" outcome, passing
with too little history, no test pruning, no run pruning, ignoring the window, counting
skipped runs, following a symlinked history, accepting future runs, ignoring
`maxFlakyTests`, and dropping `flakyError` from the parser.

End-to-end with Node's own JUnit reporter and the CLI: a small git project with a stable
test, a skipped test and a test whose result alternates. Run 1 was skipped ("1 of the 5
runs"), and run 2 reported the alternating test as failed and passed on the same commit
(medium finding, exit 0). With `maxFlakyTests: 0` the run exited 1. Found while doing
this: `node --test test/` treats the folder as one file, so the documented example uses
a file pattern, and the reporter does not create a missing report folder (VeriQ then
errored with "not found" rather than passing).

Correction to the code-quality entry below: its exit code 3 was the fixture's
unreachable target. Rerun with no target: a new type error exits 1, and removing it
exits 0.

Full results in this Linux sandbox: `test:expanded` 147 tests, 143 passed, 2 skipped
(k6/MobSF prerequisites), 2 failed only because Firefox and WebKit cannot be installed
here; selftest, `test:action`, runner (13/13) and API (118/118) passed. The
registered-check count test changed from 47 to 48 because a check was added. A Windows
run of the full suite is still pending.

## Code-quality gate — 18 November 2026

Engine, API and runner typechecks passed. New `test/code-quality.test.ts`: **7 passed**.
It uses the real TypeScript compiler in a temporary project (linked as the project's own
`node_modules/typescript`) and a fake ESLint package whose exit code and output are
controlled. Covered: missing baseline errors; `--baseline` writes hashes only; an
unchanged run passes; an error moved down two lines is not new; a new error fails and
only it is listed; a second copy of an accepted message is new; a fixed error is
counted; `failOn: 'any'`; a missing tsconfig, a project-level tsc error and TypeScript
not installed all error; ESLint clean/problems/warnings/fatal parse error/exit 2/non-JSON;
imported ESLint JSON and Dart machine output with an escaped pipe; a saved report older
than the latest commit; the 30-line listing and 2000-entry report caps; parsers and
settings validation (both modes at once, `..` and absolute paths, unknown keys).

Root cause found by a test: tool lookup used Node's module resolution, which also
searches `NODE_PATH` and global folders. On this machine it picked a global TypeScript
from outside the project, so a project without TypeScript ran a different compiler
instead of reporting the missing package. Lookup now walks only the project's and its
parents' `node_modules` folders (workspace hoisting still works), and the test asserts
the "not installed in the project" error.

Mutation checks, each made a test fail and was restored: line number in the identity,
set comparison instead of counts, ignoring ESLint exit 2, removing the stale-report
check, passing without a baseline, counting warnings by default, ignoring project-level
tsc errors, not unescaping Dart pipes, and failing to find the project's tool.

End-to-end through the CLI on a copy of VeriQ itself: `qa run --only code-quality
--baseline` accepted one existing error (caused by leaving `apps/` out of the copy);
adding a type error to `src/core/types.ts` then produced one high finding naming
`src/core/types.ts:101 TS2322`. (Correction, 18 November: the exit code 3 seen in this
run came from the fixture config's unreachable target, not from the finding; exit 3
means an environment error. Rerun with no target: the new error exits 1, and after
removing it the run exits 0.)

Full results in this Linux sandbox: `test:expanded` 137 tests, 133 passed, 2 skipped
(k6/MobSF prerequisites), 2 failed only because Firefox and WebKit cannot be installed
here (`Executable doesn't exist at /opt/pw-browsers/firefox-…`); selftest, `test:action`,
runner (13/13) and API (118/118) passed. The registered-check count test changed from
46 to 47 because a check was added. A Windows run of the full suite is still pending.

## Changed-lines coverage — 17 November 2026

Typecheck passed. New `test/diff-coverage.test.ts`: **7 passed** in a temporary git
repository with a base and a feature commit (modified lines, a new file, a comment-only
change, a rename with one changed line, a test file and a `.d.ts` file). Covered:
exact counts and percent, worst-first uncovered ranges, files missing from the report
(strict and lenient), include/exclude, absolute LCOV paths, stale/empty/malformed/
foreign reports, a changed file newer than the report, unknown and option-like refs,
invalid settings, and a repository config that sets `diff.external`, a textconv driver
and `core.fsmonitor` (none of their programs ran).

Root cause found by a test: a user-supplied `exclude` replaced the default excludes, so
setting one exclude silently pulled test and type files into scope. Excludes are now
added to the defaults; `defaultExcludes: false` turns the defaults off, with a test.

Mutation checks: removing `--no-ext-diff`/`--no-textconv`, skipping files missing from
the report, and removing the stale-report check each made a test fail; the code was
restored. The registered-check count test changed from 45 to 46 because a check was
added.

## Readable, privacy-safe evidence and concrete remediation — 16 November 2026

Trigger: a real run against MLITech staging reported unauthenticated
`GET /report-analytics/customer/export` and `/customer/monthly/export` (HTTP 200).
The finding was correct, but its evidence printed the raw bytes of the returned Excel
file (`PK… [Content_Types].xml…`), which was unreadable, and the remediation was the
generic default.

Root causes:

- The HTTP client decoded every body as UTF-8 text, and evidence printed the first
  300 characters, so binary bodies came out as raw bytes.
- A text export (CSV/JSON) would have been printed the same way, putting customer
  data into reports and onto the dashboard.
- Only the runner's generic remediation existed for the original checks.

Changes:

- The client keeps the byte size and detects binary bodies from their first bytes
  (XLSX/DOCX/PPTX/ZIP, PDF, legacy Office, PNG/JPEG/GIF, gzip, binary content types,
  and mostly-control-character data).
- `responseEvidence()` describes binary bodies and attachments instead of printing
  them, and redacts emails, phone, CNIC and card numbers and JWTs in text. Ids,
  timestamps, dates and amounts stay readable.
- The runner applies the same sanitising to every plugin's evidence, as a safety net,
  and caps it at 1000 characters.
- api-auth findings get a specific fix naming the route's source line, and each of
  the 17 other original checks gets a default.

Validation in the Linux copy: typechecks (engine, API, runner) passed; new
`test/evidence.test.ts` 5/5; non-browser expanded files 90 passed, 0 failed, 2
skipped (k6/MobSF flags); `selftest` all checks passed (every planted bug found, no
false positives); `test:action` passed; runner 13/13. A mutation check (removing the
binary branch) made a test fail; the code was restored.

### Intermittent hang in browser checks (found during the same full run)

The full browser suite ran past its 1700 s limit. One client-side redirect test took
1203 s: a fail-closed case waited for the 20-minute plugin timeout, still produced the
expected "errored" status, so the test passed while hiding the hang, and the abandoned
Chromium kept the process from exiting. Running both client-redirect tests in a loop
reproduced it in 1 of 3 and 1 of 8 runs. Step logs showed `page.close()` sometimes never
returning after the probe page answered HTTP 500. Playwright's `page.close()` and
`page.evaluate()` have no timeout of their own.

Fix: `bounded()` (`src/web/browser-options.ts`) limits these waits. Page cleanup gives up
after 5 s (the browser close at the end closes any leftover page), and browser close
after 15 s. The marker check after a probe is bounded too. If it times out during the
`javascript:` probe the result is inconclusive; if it errors because the page navigated
away, the canary did not run there. Applied in the client-redirect, stored-XSS, form
CSRF and JSON CSRF checks. The fail-closed test now also asserts the intended error
reason and a 30 s limit per case, so a hang can no longer pass. Afterwards the loop
ran clean 10 of 10 times.

A first attempt treated a rejected marker check as "unresponsive" and broke detection
in all 10 runs; rejection now keeps its earlier meaning (the document is gone).

## JSON/SPA CSRF and URL/unquoted XSS contexts — 15 November 2026

Engine, API and runner typechecks passed. In the Linux copy (Chromium only):
`expanded-browser`: **28 passed, 2 failed** (30); the failures are the unchanged
Firefox/WebKit tests (executables unavailable there). Other expanded files:
**85 passed, 0 failed, 2 skipped** (k6/MobSF flags not set). Runner: **13 passed**.
API and dashboard suites were not rerun (no API/dashboard code changed).

New tests: JSON CSRF detection (text/plain, form, CORS-allowed POST and PUT), a
token-protected endpoint with meta and cookie token sources, SameSite=Lax, a CORS-only
defense, fail-closed cases and preflight; XSS unquoted-attribute, `href`, iframe and
safe-URL fixtures, and a stored `javascript:` URL case.

Failures found and their root causes:

- **False pass from blocked attacks.** The first JSON CSRF version treated a request
  seen by Playwright's route as delivered. Chromium's Private Network Access then
  blocked it (public synthetic attacker page to a loopback target), so the server
  never saw it and the check passed. Delivery is now taken from Chromium's network
  log (request sent and response received); a blocked request is inconclusive with
  the browser's reason (`LocalNetworkAccessPermissionDenied`).
- **Unreliable cookie evidence.** Playwright's `allHeaders()` listed cookies that the
  browser had in fact withheld (blocked third-party cookies). The server received
  none, yet the check could pass. Per-cookie block reasons now come from the network
  log; SameSite/Secure/path reasons count as defenses, other reasons are inconclusive.
- **CORS preflights suppressed by interception.** With request routing on, Chromium
  sent the cross-site JSON request without a preflight, which would have reported
  CORS-protected servers as vulnerable. The server's preflight answer is now requested
  directly, and the browser request is sent only if it allows the attacker origin.
- **Test fixture defect.** The fixture answered CORS preflights only after
  authentication; real servers answer them without cookies. Fixed in the fixture.
- **Wrong test assumption.** A third-party-cookie test first targeted the text/plain
  form, which is a top-level navigation that third-party blocking does not affect. It
  now uses the cross-site fetch it was meant for.

The fixture is on loopback, so tests that need a cross-site fetch to arrive pass
test-only Chromium flags that turn off Private Network Access (`PUBLIC_TARGET`).
Another test runs without them and asserts the check errors. The Node-side preflight
probe trusts the fixture certificate through `QA_PROBE_CA_FILE` in addition to the
system roots; TLS verification is never disabled.

Mutation checks: ignoring environment-blocked cookies and accepting undelivered
attacks each made a test fail; the original code was restored and re-verified.

## Uptime history and post-deploy error sources — 15 November 2026

Engine typecheck passed. Non-browser expanded files, now including
`uptime-history` and `error-source`: **85 passed, 0 failed, 2 skipped** (87); the
skips are k6 and MobSF (flags not set in the Linux copy). `expanded-browser` was not
changed by this slice (last result above: 25 passed, 2 Firefox/WebKit failures).

Nine uptime tests cover persistence across separate runs, query redaction,
check-error vs network/HTTP outages, exact coverage/availability/episode/gap
arithmetic (including a seed observation before the window and an ongoing outage),
target evaluation gated by coverage, pruning by age and count, eight concurrent
writers, corrupt/future/linked/escaping files refused before any request and left
unchanged, fresh and stale locks, filter-bound export cursors and the CLI command.
Five error-source tests cover NDJSON and seven-page HTTP sources, release
attribution, re-importable exports, unfinished windows (no request), page limits,
repeated cursors, oversized pages, server errors, redirects, unsafe URLs, missing
tokens, invalid lines and PII/token omission.

Mutation checks: counting failed checks as coverage, skipping corrupt lines,
accepting a truncated paged export and dropping release attribution each made a test
fail; the original code was restored and re-verified.

Design issue found and fixed before it shipped: provider fingerprints are often hash
strings, and the message normalizer would have replaced them with `<hex>`, merging
all errors into one group. Provider fingerprints now get PII redaction only, and a
test asserts that distinct hash fingerprints stay distinct.

Behaviour change: an uptime account that cannot authenticate is now recorded as a
check error, the other targets are still sampled, and the run still errors.
Network-error findings now say "Network error"/"Request timed out" instead of the
raw error text.

## Password policy, CSRF variants, XSS contexts and stored XSS — 15 November 2026

Engine typecheck passed. Validated in the Linux copy (Chromium only).
`test/expanded-browser.test.ts`: **25 passed, 2 failed** (27 total); the two failures
are the unchanged Firefox/WebKit tests failing at `browserType.launch` because those
executables are missing there. Other expanded files (`expanded`, `record-flow`, `k6`,
`mobsf`, `session-lifecycle`, `webhook-contract`, `fuzz-report`, `password-policy`):
**71 passed, 0 failed, 2 skipped** (73). The two skips are k6 and MobSF, whose
`QA_TEST_K6`/`QA_TEST_MOBSF` flags were not set there; the all-enabled run on the
Windows machine remains to be repeated (MobSF still expected to fail honestly).

New tests: five password-policy tests (healthy, missing rules, length-only, max-20,
authenticated create-user route, inconclusive 302/409/429/500, failed control,
preflight and secret omission), CSRF variant detection and preflight, XSS context
detection with safe encodings, and four stored-XSS tests. The registered-check count
test changed from 44 to 45 because a check was added; no assertion was relaxed.

Mutation checks confirmed the tests catch regressions: disabling the password-policy
inconclusive guard, leaking a submitted password into a finding, and removing the
CSRF GET 404/405 rejection rule each made a test fail. The original code was restored
and re-verified.

No root-cause fixes were needed in this slice beyond test design: a stored-XSS
error-case test initially used a selector that only became ambiguous in a later
phase; it now uses a selector that is absent, so it tests the intended failure.

## Client-side redirect probes — 15 November 2026

Engine typecheck passed. Validated in a Linux copy of the working tree (Chromium
only; Firefox/WebKit executables could not be downloaded there).
`test/expanded.test.ts`: **38 passed, 0 failed**. `test/expanded-browser.test.ts`:
**18 passed, 2 failed** (20 total). Both failures are the existing Firefox/WebKit
tests (flow replay in three engines, cross-browser regression) and fail at
`browserType.launch` because the executable is missing in that environment; they
passed on the Windows machine and were not modified. The full suite with K6/MobSF
flags still needs a rerun on the Windows machine.

Three new tests cover script, meta-refresh, naive-filter, popup and `javascript:`
navigation sinks, a reachable cross-origin sentinel (zero requests), safe
rejection/fallback, inert controls, HTTP 3xx/5xx pages, blocked dependencies, an
externally redirecting control, failed login, disposable flags, invalid settings and
whole-case app preflight (zero page loads before refusal). Results are checked for
the probe host, page marker and payload text.

Root causes found and fixed without weakening assertions:

- A popup's first navigation is requested before its frame exists, so Playwright's
  `request.frame()` threw inside the route handler (unhandled rejection). Such a
  request can only belong to a new top-level browsing context, so it is now
  classified as a top-level navigation; unparsable request URLs are blocked.
- The first leak assertion rejected the literal text `javascript:` and so matched
  the finding title that names the sink. A direct run confirmed no payload content
  in results; the assertion now checks the payload itself (`void(window`), the
  marker prefix and the probe host, which is stricter about real leaks.

## CSRF workflow and all-enabled validation — 15 November 2026

Expanded tests ran with `QA_TEST_K6=1` and `QA_TEST_MOBSF=1`:
**84 passed, 1 failed, 0 skipped** (85 total), in
`qa-out/core-csrf-final-all-enabled.log`. The failure is the real MobSF prerequisite
assertion: no server URL, APK/IPA or API key is configured; Docker's Linux daemon
is unavailable. The user confirmed the service/binary are not available. This is
an unresolved acceptance failure, not a passing scan and not replaced by fixtures.

CSRF regression tests use real Chromium cross-site POSTs and a local HTTPS fixture.
They cover token defense, SameSite=Lax, state mutation despite rejection, inert
legitimate controls, unauthenticated state exposure, server errors and safety guards.
The tests of safety guards intentionally assert that unauthorized plugin execution
is refused; those test cases execute and pass rather than being skipped.

Root causes found and fixed without weakening assertions:

- Initial state reads used Playwright's API request cookies while the attack used
  browser cookies. In-browser bounded fetch now keeps their semantics consistent.
- The initial HTTP fixture could not exercise Secure/SameSite=None cross-site
  authentication. An HTTPS fixture with trust pinned to its test-only public key
  now verifies that the vulnerable request actually carries the session cookie.
- Optional Schemathesis testing exposed Windows cp1252 output failure and a false
  pass from an empty JUnit report. Subprocess output now uses UTF-8. Empty,
  skipped-only, malformed and entity-bearing reports are rejected, and a failed
  process with no reported failures cannot pass. New report regression tests pass.

Engine/API/runner typechecks passed. API: **118 passed, 0 skipped**. Runner:
**13 passed, 0 skipped**. Action checks and dashboard build passed. The first
package-run wrapper had Windows-invalid colon characters in log filenames, so those
commands did not start; corrected runs are recorded in `csrf-package-summary.log`.
No outcome is inferred from that initial wrapper's stale exit-code summaries.

The full self-test executed all sections with optional fuzzing enabled. Its only
initial failure was the missed fuzz finding described above; visual, socket, load,
ZAP-adapter, Lighthouse, flow and mobile-adapter assertions passed. After the fix,
the affected main section was rerun with actual Schemathesis 4.33.4 and all its
assertions passed, including detection of the planted `/promotion/search` server
error (`qa-out/csrf-selftest-main-fixed.log`). Its plugin status is intentionally
`failed` because it found the planted defects; the test harness passes.

Dashboard E2E ran with `SCREENSHOTS=1`: **68 passed, 0 skipped**, including the
screenshot capture test (`qa-out/csrf-validation-dashboard-e2e.log`). All package
checks finished successfully in the corrected wrapper. The final outstanding test
failure is real MobSF acceptance; no claim of a fully green all-tests run is made.


## HTTP open-redirect probes — 15 November 2026

Engine typecheck passed. Expanded suite with local Chrome and actual local k6:
**79 passed, 0 failed, 1 skipped** (80 total), recorded in
`qa-out/core-redirect-security.log`. Real MobSF acceptance remains skipped.
Three new tests cover absolute and protocol-relative redirects, same-origin chains,
safe rejection/fallback, inert positive controls, loops, server errors, disposable
flags and whole-case app preflight. A reachable cross-origin local sentinel received
zero requests, confirming that external Location is inspected without following it.
No focused or regression tests failed and no assertions were weakened in this slice.

The implementation uses bounded manual HTTP redirects with retries disabled;
responses are disposed on each hop and browser contexts close in finally blocks.
Failures are generic to keep query values out of evidence. These tests cover HTTP
Location only; JavaScript/meta-refresh redirect and CSRF acceptance remain pending.
API/dashboard suites were not rerun for this core-only slice.

## Browser query-input probes — 15 November 2026

Engine typecheck passed. Expanded regression with local Chrome and `QA_TEST_K6=1`:
**76 passed, 0 failed, 1 skipped** (77 total), recorded in
`qa-out/core-browser-security.log`. Real MobSF acceptance remains skipped.
Two new browser tests cover reflected/DOM execution, escaped output, CSP blocking,
missing readiness, blocked external dependencies and both disposable guard flags.
The external-dependency fixture uses an intercepted `.invalid` URL, not a live
third-party service. No test expectations were weakened.

The first typecheck caught existing event-registration callbacks returning Page
after the shared pre-navigation hook was made awaitable. The hook now accepts and
awaits an unknown callback return, preserving synchronous handlers while ensuring
async route/init-script installation finishes before navigation. Full typecheck and
regression then passed. Generic active-probe errors avoid leaking navigation URLs;
blocked dependencies error instead of silently reducing detection coverage.

Only this explicit query-input canary is validated; broader browser security and
real-project acceptance remain pending. API/dashboard suites were not rerun.

## Webhook state and contract follow-up — finalized 15 November 2026

Engine TypeScript passed. Expanded regression with `QA_TEST_K6=1` and local Chrome:
**74 passed, 0 failed, 1 skipped** (75 total), recorded in
`qa-out/core-webhook-contract.log`. The skip is real MobSF engine acceptance.
The eight new focused tests passed unchanged under permitted loopback execution;
the first sandboxed attempt failed because local HTTP returned `EACCES`.

Webhook fixtures verify authenticated reads/writes, acknowledge-ignore behavior,
immediate and delayed unauthorized mutation despite rejection, inert positive
controls, missing state, rate limits and whole-configuration preflight. Findings
omit signatures and state values. Contract fixtures verify widening versus
narrowing, nested restrictions, required response guarantees, inherited parameter
overrides, schema-less media removal and unsupported schema errors.

Root causes addressed: extra signature headers previously replaced account
authentication headers; inherited parameters needed operation-level overrides;
type equality alone misclassified compatible integer/number changes and reordered
unions. Assertions were not weakened. API/dashboard suites were not rerun for this
core-only slice. These local fixtures do not establish customer-project acceptance.


## Refresh/session lifecycle follow-up — 14 November 2026

Engine TypeScript passed. Expanded regression with actual local k6 enabled:
**66 passed, 0 failed, 1 skipped** (67 total), recorded in
`qa-out/core-session-final.log`. The only skip remains the unconfigured real MobSF
engine acceptance test. The focused session lifecycle suite passed all **5 tests**
(`qa-out/session-lifecycle-final.log`).

Positive fixtures exercise revoke-family and reject-only policies with fresh logout
sessions. Negative fixtures detect invalid token acceptance, non-rotation, consumed
token reuse, missing family/access revocation and logout revocation. Additional
checks reject public control endpoints and unsupported policies before mutation;
500/429, failed login and malformed token pairs error without retries or leaked
credentials. Malformed JWT parsing now emits a generic message instead of a JSON
exception that could contain decoded claims.

Two implementation choices prevent misleading findings: logout uses a separate
fresh session after reuse probes, and optional access revocation is checked before
another refresh call can invalidate the access token for unrelated reasons. Refresh
endpoints can explicitly use HTTP 400 for rejection; protected access controls
still require 401/403. Existing assertions were retained. No real customer identity
service was tested, and no claim is made for cookie/OAuth/OTP/custom refresh flows.

## MobSF automation follow-up — 14 November 2026

Engine TypeScript passed. Expanded regression with `QA_TEST_K6=1` and installed
Chrome: **61 passed, 0 failed, 1 skipped**, 62 total
(`qa-out/core-mobsf-regression.log`). The skipped test is explicitly the real
MobSF engine test: no configured local service/image or APK/IPA build was present.
It is not counted as a pass. The focused wire-contract suite passed 5 tests and
skipped that same live test (`qa-out/mobsf-execution.log`).

The fixture server exercises multipart upload, rescan parameters, synchronous and
async task completion, binary/hash binding, code and iOS findings, credential/source
redaction, wrong/stale/cached/failed scans, redirects, malformed/oversized responses,
timeout, unsafe endpoints and binary preflight. Its ZIP-prefixed fixture bytes are
not installable mobile applications and do not establish MobSF scanner quality.

Review found two adapter gaps: iOS binary rules were ignored, and secure/good
observations were mapped to low-severity vulnerabilities. The normalizer now reads
binary rules and excludes those positive observations; unknown labels error instead
of silently downgrading them. Existing planted-defect assertions are retained.

Real MobSF acceptance requires a private/local scanner and a designated test build.
The opt-in test and setup variables are documented in PLUGINS.md. Static analysis
coverage is explicitly limited to normalized sections; no emulator, dynamic mobile
testing, complete mobile-security coverage or production acceptance is claimed.

## k6 execution follow-up — 14 November 2026

`npm run typecheck` passed. With `QA_TEST_K6=1` and the installed Chrome selected,
the complete expanded suite passed **56 tests, zero failures/skips**. Log:
`qa-out/core-k6-regression.log`. The focused k6 suite passed all four tests in
`qa-out/k6-execution.log`, using actual installed **k6 v2.1.0** against disposable
loopback HTTP targets. No public or customer service received load.

Coverage includes healthy targets, HTTP 500/threshold failures, redirects refused,
authenticated probes with the real AuthProvider, credentials absent from generated
files, unsafe configuration refused before launch, inherited k6 setting isolation,
partial/missing reports, contradictory exit status and process timeout. The shared
process helper also passed existing project-test execution regressions.

Initial authentication verification failed because the test double supplied
`header()` but lacked the runner's `secretValues()` redaction contract. Replacing
that incomplete test double with the real AuthProvider fixed the fixture and
exercised actual authentication/redaction. No assertion was weakened. A subsequent
test attempt was not executed because approval review hit a usage limit; after
resuming, the focused suite and full expanded suite both passed.

Actual k6 tests are opt-in with `QA_TEST_K6=1` so missing local tool prerequisites
are visible as a skip in other environments. Default fixture tests alone do not
establish real k6 execution. This implementation covers bounded GET load, not
arbitrary scripted journeys, distributed load or all remaining core chunks.

## Core recorder and execution follow-up

Latest scoped verification: `npm run typecheck` passed; expanded suite **52 passed,
zero failed/skipped** (`qa-out/core-execution.log`). The original flow self-test
retained all **7 passing assertions** (`qa-out/core-recorder-flows.log`). No API or
dashboard changes were made in this follow-up, so their earlier results below are
historical and were not rerun here.

New coverage: review-page browser UI, generated-flow replay and deliberately
failing assertions; token/origin enforcement, invalid-source retry, cancellation,
timeout and exclusive output creation. Project test execution covers success,
planted JUnit failure, nonzero-exit/clean-report mismatch, missing fresh report and
timeout. Existing report data is preserved. Assertions and fill values use runtime
inputs where sensitive input text would otherwise be written to generated source.

The Playwright Inspector-to-review-page copy step remains manual. Native Inspector
session acceptance and real external tool/provider validation remain outstanding;
fixtures do not establish those. Details and remaining chunks: CORE-COMPLETION.md.

## Current stabilized checkpoint — 13 November 2026

Scope: stabilize implemented code and hand off remaining work. The full product
roadmap is not complete. See [the continuation prompt](REMAINING-WORK-PROMPT.md)
and [operational acceptance](OPERATIONAL-ACCEPTANCE.md). AI is off; plans remain
configurable, prices unset, external integrations optional and deployment deferred.

| Verification | Observed result |
|---|---|
| Engine, API and runner TypeScript | Passed in full regression; engine checked again after discovery fix |
| Expanded plugin/security/browser suite | 43 passed, 0 failed after discovery fix |
| Original engine self-test | 81 assertions passed in full regression |
| Original discovery/main self-test after AST fix | 26 assertions passed; original planted-defect checks retained |
| GitHub Action simulation | 50 assertions passed |
| API integration on PGlite | 118 passed, 0 failed/skipped |
| API integration on real PostgreSQL, restricted `qa_app` | 118 passed, 0 failed/skipped |
| Hosted runner tests | 13 passed, 0 failed/skipped |
| Dashboard build | Passed; JS 587.47 kB, gzip 172.98 kB; existing >500 kB chunk warning remains |
| Full dashboard E2E after fixes | 67 passed, 0 failed; 1 optional screenshot capture skipped |
| Platform API self-scan after discovery fix | 109 routes discovered; 11 selected checks passed, 0 findings; report uploaded to disposable platform |
| npm dependency audit snapshot | 0 reported vulnerabilities |
| Three Compose configurations and isolation manifest | Parsed successfully; no image/cluster acceptance claim |
| Diff whitespace | Passed |

The initial `test:all` reached E2E and failed two tests, with two later serial
tests consequently not run. After fixing the field label and logout navigation,
the dashboard was rebuilt and its **entire** browser suite rerun successfully.
This is a full initial regression plus scoped final reruns, not a claim that the
initial command exited successfully. Existing assertions were retained.

### Failures and review findings corrected in this checkpoint

| Finding | Root cause and correction |
|---|---|
| Refresh-token reuse left access JWTs usable | Refresh-row revocation alone did not invalidate JWTs; increment the user's auth version under lock and validate it on authenticated requests. |
| Quota checks could race or be bypassed | Serialize admission with the organization lock, count queued hosted reservations and reject CI callers spoofing hosted source. |
| Failed/cancelled/retried jobs lost usage | Account server-observed runtime once for terminal jobs; accumulate time across stale retries. Never-claimed cancellations release reservations without charging runtime. |
| MFA-disabled users could not sign out all devices | Require the password for all users and an unused factor only when MFA is enabled; keep both account panels' MFA status in the same query cache. |
| Two password inputs matched the existing account test | The new MFA label contained the existing password field label. Give the MFA form a distinct accessible label; keep the original test unchanged. |
| Revoke-all redirected inconsistently | A protected-route effect raced the explicit login navigation. End the document after revocation using a replacement navigation; invalidate in-flight identity reloads when signing out. |
| New MFA fixture attempted a consumed factor | Enrollment already consumed the current TOTP time step. Use a distinct unused recovery code; retain replay rejection and the original login/logout assertions. |
| False billing-route security findings | AST discovery assigned every router in a module to every mount. Resolve the actual imported/exported binding, aliases, nested routers and chained route ownership; add a fixture with separate public/private routers. |
| Comment pages could omit equal-time rows | JavaScript timestamps lost PostgreSQL microseconds. Preserve the database timestamp precision and use timestamp plus UUID cursors; reject malformed cursors. |
| Chunked logs could leak secrets or retain unbounded prefixes | Decode split UTF-8 correctly and drain complete spans while retaining only the bounded possible-secret suffix; cover repeated prefixes and split secrets. |
| Payment bridge malformed responses exposed inconsistent errors | Bound streamed response size and validate JSON object shape/HTTPS return URLs; return generic errors without provider body text. |
| Hosted completion/evidence failures were ambiguous | Add assigned-job result recovery, checksummed bounded uploads, and explicit pending/complete/failed evidence status. Durable outage recovery is still unfinished. |
| Partial recorder could silently misrepresent flows | Remove its unfinished command from the active CLI; keep existing scripted flows and document a properly tested recorder as future work. |

Infrastructure failures were not counted as product passes. A stopped local Docker
engine caused PostgreSQL connection refusal; after restart, all 118 tests passed
against the disposable restricted-role database. One discovery self-test rerun
omitted `QA_CHROMIUM_PATH` and could not find Playwright's bundled Chromium; the
rerun explicitly selected installed Chrome. No assertions were relaxed for either.
The task-owned PostgreSQL container, volumes and temporary credential file were
removed after verification.

Current evidence is under ignored `qa-out/`:

- `checkpoint-regression.log`: initial full run, including the two repaired E2E failures.
- `checkpoint-expanded.log`: all 43 final expanded tests.
- `checkpoint-postgres.log`: 118 tests on real PostgreSQL.
- `checkpoint-dashboard-build.log` and `checkpoint-dashboard-e2e.log`: final build and full browser rerun.
- `checkpoint-discovery-selftest.log` and `checkpoint-self-scan.log`: final discovery/self-scan checks.
- `saas-dependency-audit.json`: zero-advisory snapshot.
- `saas-screens/`: account/MFA/revoke-session and disabled-billing screenshots.

The account screenshot was also inspected visually. This does not replace all
screen-size/accessibility checks or real-provider acceptance. SSO/payment/issue
bridges and artifact storage have contract/fixture coverage; live providers,
backup restoration, production load, regional routing and worker isolation remain
unvalidated. PostgreSQL integration establishes more than PGlite, but does not
establish production throughput or disaster recovery. The durable hosted evidence
spool remains the highest-priority implementation gap. Dependency audit results
are not a guarantee of vulnerability-free code.

The platform self-scan covers its selected checks and configured accounts. It does
not mean all 44 plugins executed or every route received every possible probe.

## Previous checkpoint — 12 November 2026

Validation date: 12 November 2026. Environment: Windows, Node 24.13.1,
PowerShell/Git Bash, local Chrome and installed Playwright Firefox/WebKit.
Tests use local fixture servers and disposable PGlite databases. No production
application, payment account or deployed cloud storage was used.

## Reproduce

```powershell
npm ci
$env:QA_CHROMIUM_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
# Or install all Playwright engines: npx playwright install chromium firefox webkit
npm run test:all
npm run typecheck -w @qa/api
npm run typecheck -w @qa/runner
npm audit
```

`test:all` runs engine/API/runner typechecking, expanded-plugin tests, the original planted-bug
self-test, GitHub Action simulation, API tests, hosted-runner tests, dashboard build
and browser E2E tests. No retry setting was added to turn flaky tests green.

On this host, restricted execution initially blocked localhost listeners and child
processes. Tests were rerun with approved local execution permissions; EACCES/EPERM
were not treated as application passes. Use normal local terminal permissions.

For optional layout screenshots:

```powershell
$env:SCREENSHOTS = '1'
npm run dashboard:e2e -- screens
```

## Observed failures and root causes

| Failure or review finding | Root cause | Correction |
|---|---|---|
| Planted hard-coded secret missed when Gitleaks was installed | Installing Gitleaks disabled built-in rules; the tools have different detection coverage | Always run built-in rules and add Gitleaks coverage. Scanner execution/report errors fail closed; unique temporary output prevents stale-report reuse. Original planted-secret assertion retained. |
| Windows ZAP/Maestro fixture launch failed | Windows does not execute Unix shebang scripts directly | Resolve supported Node/Python local entry points to explicit executable arguments, without a shell. Original adapter assertions retained. |
| Flow evidence path differed on Windows | OS-specific backslashes reached report targets | Normalize evidence/flow paths to portable forward slashes. Original matching assertion retained. |
| Action simulation used WSL and could not open Windows paths | Generic `bash` selected an incompatible launcher | Prefer installed Git Bash or explicit `QA_BASH_PATH`; pass portable paths. |
| Action kit config import rejected `F:` URL scheme | A Windows filesystem path was passed directly to ESM import | Use `pathToFileURL`; existing generated-kit assertions unchanged. |
| Postman variable path did not match expected route | URL parsing encoded unresolved braces | Replace collection path variables before URL parsing. |
| Nested OpenAPI references could reach an external consumer unchecked | Only operation/path references were validated | Walk response/component schemas too and reject external/file references before preserving or exporting the document; bounded structural traversal. |
| Dependency audit reported high-severity advisories | Existing Zod 3 and Nodemailer 6 dependency versions | Upgrade dependencies and lockfile; adapt Zod record/JSON-schema APIs and retain compatibility for customer Zod 3 schemas. |
| Simultaneous probes could invalidate an account's token | Multiple callers started login before the cache was populated | Share in-flight token/header promises; regression verifies one login across eight callers. |
| Passwordless custom-auth account disappeared | Config filtering assumed every account used password login | Preserve explicitly configured OAuth/custom accounts; reject unknown accounts. |
| Static report imports depended on backend-source availability | Source prerequisites were inferred from the whole static layer | Declare `backendDir` only on checks that require source; imported reports run without it. |
| Potential credential exposure/repeated mutations | Response evidence, recovery logging and automatic HTTP retries were too permissive | Central redaction, no recovery-token email-body logging, same-origin HTTP, bounded responses, redirect restrictions and no automatic mutation retries. |
| Malformed OAuth provider output could appear in a parse exception | JSON parsing errors can include response text | Return a generic status-only authentication error; regression verifies provider response text is absent. |
| Errored check could leave a green gate | Gate considered finding severity without check errors | CLI and API ingestion reject success when selected checks errored. |
| Artifact could be orphaned during deletion/upload race | Cleanup could remove metadata while an object upload was still in flight | Keep pending-upload tombstones until the bounded upload settles; test deletes a run during a paused upload. |

Changes to existing test infrastructure were limited to Windows launch/import
portability and optional artifact-store injection. Assertions were not weakened,
deleted or changed to accept the reported defect.

## Evidence and results

| Verification | Final result |
|---|---|
| Engine, API and runner TypeScript checks | Passed |
| Expanded plugin/security tests | 42 passed, 0 failed |
| Original engine self-test | 81 assertions passed |
| GitHub Action simulation | 50 assertions passed |
| API integration tests | 96 passed, 0 failed |
| Hosted runner integration tests | 5 passed, 0 failed |
| Dashboard build | Passed; bundle-size warning remains (566.20 kB JS, 166.89 kB gzip) |
| Dashboard browser E2E | 63 passed; optional screen-capture test skipped in the default suite |
| Separate optional screen-capture test | 1 passed; 27 screenshots captured |
| Dependency audit snapshot | 0 reported vulnerabilities |
| Diff whitespace check | Passed |

The sequential full regression passed. The subsequent nested-reference and OAuth
hardening changes passed a fresh engine typecheck and all 42 expanded tests.
API/runner typechecks were also run separately; `test:all` now includes them.
The approval-review usage limit interrupted one OAuth verification attempt before
execution; the resumed verification completed successfully.
Machine logs are in ignored `qa-out/` so customer data is not committed:

- `final-regression.log`: complete sequential regression.
- `dependency-audit.json`: npm audit snapshot (zero reported vulnerabilities).
- `visual-review.log` and `visual-review/`: optional screen capture and layout checks.
- `final-expanded.log`: final parser/authentication/security rerun, including OAuth.
- `platform-self-scan.log`: the QA engine tests this platform's actual API using
  disposable local data, then uploads the run back to the temporary platform.

The platform self-scan discovered 83 routes and passed 11 selected checks with no
findings. This includes five explicit authorization policy cases, a JWT positive
control/unsigned-token rejection and health sampling. It does not mean every one
of the 44 plugins executed, or that every route received every kind of probe.

Visual review captured 27 desktop/mobile/dark/print screens. The screenshot test
passed; desktop overview, phone runs and dark runs were also inspected visually.

Expanded tests exercise positive, negative and prerequisite cases, actual local HTTP,
all three browser engines, no-retry mutations, auth concurrency, report parsing,
cross-origin refusal, redaction, unsafe plugin output and artifact path confinement.
Artifact API tests exercise project/organization isolation, checksums, immutability,
ambiguous storage failure, cleanup retries, run deletion and upload races.

## What the tests do not establish

- Real Semgrep/Trivy/MobSF/k6 execution was not validated against customer projects.
  Their report adapters use representative fixtures; local tool versions and report
  formats still need verification in the target CI environment.
- Maestro and external ZAP adapters use fixture executables. The built-in web/API
  checks and Lighthouse run against actual local HTTP/browser fixtures.
- Optional Schemathesis self-test requires `SELFTEST_FUZZ=1` and its installation;
  it is not part of the default run reported here.
- TLS/DNS validation has configuration/safety coverage; no claim of exhaustive
  public DNS, certificate-chain or cipher-suite testing is made.
- Private storage uses an injected store in API tests. Real S3-compatible service
  permissions, lifecycle behavior and failure recovery need deployment validation.
- OAuth provider responses are tested through the fetch contract, including HTTPS
  enforcement and malformed-body redaction; no external identity provider was connected.
- PGlite integration tests do not replace a production PostgreSQL/load/backup test.
- The audit is a dependency-advisory snapshot, not proof that application bugs or
  unknown vulnerabilities cannot exist.
- Real-project acceptance and the remaining SaaS roadmap are still outstanding;
  see `ARCHITECTURE.md` and the coverage limits in `PLUGINS.md`.
