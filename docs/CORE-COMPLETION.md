# Core QA completion plan

SaaS billing, public deployment and identity-provider work are outside this plan.
Completion means the accepted capabilities and their positive/negative acceptance
checks pass, not that every possible application bug can be detected automatically.

1. Multi-browser scripted flow replay: explicit engines, separate findings/evidence,
   preserve Chromium defaults, reject invalid settings and missing engines.
2. Local flow recorder: actual codegen fixtures, nested locators, explicit unsupported
   actions, secret handling, cancellation and successful replay.
3. External execution: bounded argument-based test/scanner adapters, cancellation,
   fresh artifacts, exit/report consistency, actual tool acceptance. No shell strings.
4. API/security depth: refresh/session workflows, state-verified webhook cases,
   richer contract compatibility and explicit browser security probes. Each supported
   scenario needs a healthy and deliberately broken fixture.
5. Observation: persistent bounded uptime observations and complete error-source
   exports; distinguish outages and missing observations, redact provider data.
6. Acceptance: execute the applicable checks against the user's actual project and
   disposable staging, resolve false positives/misses and document prerequisites.

Work proceeds in this order. Each chunk is tested before the next expands scope.
Business-policy cases still require application-specific expected behavior. Provider
selection and real target access will be requested when their chunk needs them.

## Chunk 1 implementation

Implemented explicit Chromium/Firefox/WebKit replay, separate result identities
and screenshots, configuration validation and cleanup of completed-flow deadline
timers. Default Chromium behavior remains compatible. Expanded suite: 44 passed,
zero skipped/failed; engine TypeScript passed. Evidence: `qa-out/core-chunk1.log`.
The recorder and subsequent chunks remain pending, not claimed complete.

## Chunk 2a: recording conversion

`qa flow-import --app business --name Checkout --url https://example.test --out qa-flows/checkout.mjs`
reads Playwright Test recording text from standard input without evaluating it.
It preserves nested locators and ordered supported actions, replaces every fill
value with a required `QA_FLOW_INPUT_N` environment reference, and refuses to
overwrite output. Review locator text and navigation paths for sensitive data too.
Use disposable data: imported flows are marked as writes and do not auto-login.

The supported subset is one `test` callback with `page`, navigation without query
or fragment, locator chains, click/double-click, check/uncheck, press and fill.
Unsupported assertions, popups, variables, setup and other syntax reject the
entire conversion. No input program is imported or executed during conversion.

## Chunk 2b: interactive workflow and assertions

`qa record --app business --name Checkout --url https://example.test --out qa-flows/checkout.mjs --channel chrome`
launches Playwright Inspector. Record actions and assertions there, select
Playwright Test output, copy it and paste into the local review URL printed in the
terminal. This explicit copy/paste step is required; code is not harvested through
undocumented Inspector APIs. No raw recording file is written by VeriQ.

The loopback review page requires a random session token and same-origin POST.
It expires after 15 minutes, bounds recording size, and supports cancel/Ctrl+C.
Only a validated recording is written with exclusive creation. Browser errors are
reported without forwarding raw child output. A browser engine/channel must already
be installed. Record only dedicated QA accounts in a disposable environment; the
interactive browser performs real actions while recording.

Supported assertions: visible/hidden, enabled/disabled, checked/empty, text,
contained text, value, count, URL and title, including `.not`. Value assertions
use separate required environment inputs. Regex and screenshot assertions remain
explicitly unsupported. Page setup, popup/multi-page flows and arbitrary code still
fail closed. Review selector text and expected text for personal or secret data.

Tests cover the actual review-page UI, save/replay, planted assertion failures,
token/origin checks, retry after invalid input, cancellation and timeout. Native
Inspector recording/copy acceptance still needs a manual session; handwritten
codegen-shaped fixtures do not establish every generated-output variant.
Reference: [Playwright test generator](https://playwright.dev/docs/codegen).

## Chunk 3a: execute project tests

The `test-results` plugin now optionally accepts `execution` with `command`, an
argument array and `timeoutMs`. `{junit}` and optionally `{coverage}` are replaced
with fresh paths in a unique report directory under the run output. No shell is
used. A nonzero exit with a clean JUnit report is an error; a real failed-test
report remains a failure. Missing/stale reports cannot produce a pass. Timeout
terminates the process tree. Captured process output is discarded to avoid leaks.

This executes trusted local project code, not sandboxed customer code. It is not
passed into hosted profiles. Configure disposable test data for tests that mutate
services. On Windows use an executable/Node entry point instead of a `.cmd` shell
wrapper. Raw JUnit/coverage files may contain sensitive output; keep `qa-out/`
private. MobSF workflow implementation is described below; real external scanner
acceptance remains separate.

## Chunk 3b: bounded k6 execution

Implemented and verified with installed k6 v2.1.0 against a disposable loopback
server. `load-stress` accepts either a `report` import or an `execution` block,
never both. Execution generates a bounded GET-only script. Configure the path,
iteration count, virtual users, request rate and maximum duration explicitly.
The target's `requestsPerMinute` budget must accommodate the requested rate.
Both `allowMutations` and `disposable` must be true, including for this GET probe.

The run uses a new private report directory, no shell, no usage reporting, no
redirect following, and no response-body retention. Credentials are resolved via
the existing account provider and supplied only in the child environment. Inherited
k6 settings, cloud tokens, proxies and unrelated application secrets are excluded.
The generated script contains no target credentials. Subprocess timeout/cancel
handling is shared with local project-test execution.

All configured iterations must complete. Exit 99 must agree with failed thresholds;
other execution failures, missing reports and partial runs error the check. HTTP
3xx is treated as a failed response. Read-only report imports keep working without
an installed k6 binary or disposable target. Existing reports are never reused for
an executed run. The optional executable path is trusted local configuration, not
a hosted request field or sandbox boundary.

Current execution scope is one same-origin GET endpoint per run. Arbitrary k6
scripts, write journeys, distributed/cloud stress and coordinated multi-endpoint
scenarios remain outside this bounded execution mode. Existing external summary
import remains available for those separately authorized workloads.

See PLUGINS.md for configuration and VALIDATION.md for the exact test results.

## Chunk 3c: MobSF upload and static-scan automation

Implemented APK/IPA upload, explicit rescan, synchronous or exact-task async
completion, and fresh report collection. The server is explicitly configured;
remote uploads additionally require HTTPS and `allowRemote: true`. Authentication
uses an environment key. Binary size/type, upload identity, task identity and
report hashes are validated. No redirects or automatic mutation retries. Errors
omit response bodies; normalized findings omit source snippets and the API key.

iOS binary findings are normalized alongside code and Android manifest rules.
Secure/good observations no longer become vulnerability findings. Unknown severity
labels and missing IPA binary-analysis coverage fail closed. Not every MobSF
section is normalized: PLUGINS.md documents the supported subset and exclusions.
No automatic remote scan deletion is attempted, since uploaded hashes may be
shared. Client cancellation/timeout does not prove remote cancellation.

Contract and negative tests passed. This machine has no configured MobSF service,
MobSF Docker image, or real APK/IPA fixture; live engine acceptance remains pending.
The opt-in integration test is supplied. No app binary was sent to a public service.

Next implementation chunk: deeper API/security and contract checks (Chunk 4).
Real MobSF/native recorder acceptance remains tracked rather than marked complete.

## Chunk 4a: refresh/session lifecycle

Implemented explicit refresh rotation, invalid-token rejection, consumed-token
reuse, reject-only versus revoke-family behavior, and logout using fresh sessions.
Optional access-token revocation is checked only when the operator's API policy
requires it. Anonymous negative controls and authenticated positive controls keep
public/misconfigured endpoints from producing misleading conclusions. Access
revocation is observed before further refresh mutations can alter token validity.

The current workflow uses configured JSON password/bearer login. It can test opaque
tokens with `jwtProbes: false`; existing JWT checks remain the default. Unsupported
cookie/OAuth/OTP/custom login configurations fail preflight. Unknown HTTP outcomes,
rate limits, server errors and malformed response fields error the check. It never
retries mutations or records response bodies/tokens. Both disposable safety flags
are mandatory and accounts must be dedicated to this lifecycle test.

Healthy and planted-defect fixtures cover both policies, rotation/reuse defects,
family/access/logout revocation, invalid controls and malformed JWT redaction.
Configuration examples are in PLUGINS.md. The following slice adds webhook state
verification and further contract checks; password-policy workflows remain separate.

## Chunks 4b–4c: webhook state verification and contract comparison

Delivered optional read-only state polling for missing/invalid/stale webhook
signatures, followed by a valid-signature positive control on fresh disposable data.
Rejected requests that change protected state are findings; acknowledge-and-ignore
responses with unchanged state can pass. Missing state, inert positive controls,
rate limits and server errors fail closed. All configured cases are preflighted
before writes, and account authentication survives signature-header merging.
Observation is bounded and cannot exclude effects after the configured window.

Contract comparison now checks request type/enum narrowing, required properties,
basic bounds, pattern/format changes, additional-property rejection, and response
type/enum widening or lost required guarantees. It respects operation parameter
overrides and semantic type unions, including integer/number direction. Media
removal is detected even without a schema. Unsupported boolean/composed schemas
error; this is a documented comparison subset, not a full JSON Schema solver.

Validation: 74 passed, 0 failed, 1 skipped across 75 expanded tests, including actual
local k6. Eight new tests cover healthy and deliberately broken fixtures. Engine
typecheck passed. Real MobSF acceptance remains the skipped test. See VALIDATION.md.
Next: remaining explicit browser security scenarios within Chunk 4, then bounded
persistent observations/exports (Chunk 5) and real-project acceptance (Chunk 6).

## Chunk 4d: explicit browser query-input execution checks

Added opt-in `web-client-security.xssCases`: a bounded local script-execution
canary for configured query parameters, with a visible unique readiness selector,
fresh browser contexts and disposable authorization. Reflected and DOM insertion
fixtures trigger findings; escaped and CSP-protected fixtures do not execute.
Missing readiness and blocked external dependencies produce errors. The canary
does not read credentials or exfiltrate data; evidence omits payload/query values.
Existing passive storage/resource checks remain available without active cases.

This slice does not complete all browser security scenarios: stored/other-context
XSS, open redirects and explicit CSRF workflows remain outside its coverage.
Persistent observation/export work and real-project acceptance also remain.

## Chunk 4e: HTTP open-redirect workflow

Added explicit `web-client-security.redirectCases` with a same-origin positive
control, absolute/protocol-relative external inputs and bounded manual redirect
chains. Cross-origin destinations are detected before contact. Safe rejection and
safe fallback pass; inert controls, loops and server errors are inconclusive errors.
Cases require disposable authorization and app preflight before any probe traffic.
Local fixtures include a reachable external-origin sentinel that receives no calls.

This covers HTTP Location redirects only. Browser-script/meta-refresh redirects and
explicit state-verified CSRF workflows remain; the next security slice is CSRF.

## Chunk 4f: state-verified browser CSRF

Added explicit `web-client-security.csrfCases` for real cross-site URL-encoded POSTs
with cookie login, protected-state observation and a legitimate form positive control.
HTTPS fixtures cover token rejection, SameSite=Lax exclusion and unauthorized mutation
despite HTTP rejection. Inert controls, public state endpoints and server errors error
the check. No attack credentials or tokens are copied manually. Fixture trust is pinned
to a disposable test certificate only. No test assertions were weakened.

Real MobSF acceptance was explicitly enabled and fails its missing-prerequisite
assertion; the user confirmed no service/binary is available. It is not passed/skipped.

## Chunk 4g: client-side (JavaScript/meta-refresh) redirects

Added explicit `web-client-security.clientRedirectCases`. Real Chromium loads the
page with a same-origin positive control, then external HTTPS, protocol-relative and
`/\host` inputs, then a `javascript:` canary. A context route aborts every
cross-origin request before it leaves the browser, so external page and popup
navigations are detected without contact. Fixtures cover delayed script navigation,
meta refresh, a naive `//` filter, a sink that blocks URLs but runs `javascript:`,
popups, a reachable local sentinel (zero hits), safe rejection and safe fallback.
Inert controls, HTTP 3xx/5xx, blocked dependencies, an externally redirecting
control and failed login error the check. Disposable flags and whole-case preflight
are required before any page load. No assertions were weakened.

Remaining browser coverage: additional CSRF/XSS/password-policy contexts.
Monitoring/export work and customer-project acceptance also remain.

## Chunk 4h: explicit password-policy workflow

Added the `password-policy` check (registered checks: 45). Against an explicit
registration or authenticated create-user endpoint in a disposable environment it
submits a strong-password positive control, then short, common and
identifier-equal passwords that must be refused, and optionally a 64-character
passphrase that must be accepted. Each submission uses a fresh `{{unique}}`
identifier, so no existing account changes. Failed controls, redirects, 401/403,
409, 429 and 5xx error the check without retries. Settings, accounts and candidate
sets are preflighted before the first request; passwords, identifiers and response
bodies never enter results. Fixtures cover a healthy policy, a policy with no
rules, length-only rules, a maximum length of 20, an authenticated admin route and
each inconclusive answer.

Not covered: breached-password lookups, password change/reset routes, lockout,
storage and role-specific policies.

## Chunk 4i: CSRF variants and XSS contexts/stored XSS

- CSRF `variants`: `forged-token` (random value of the real token's length; the
  real value is never copied), `multipart` and top-level cross-site `get`, alongside
  the existing missing-token POST. Fixtures plant a presence-only token check, a
  multipart path that skips the token check, and a GET mutation. A presence-only check
  passes the missing-token variant alone; the forged-token variant detects it.
- Reflected XSS `contexts`: `attribute` and `script` payload sets in addition to
  `html` (default unchanged). Fixtures cover angle-escaped attributes, quote-unescaped
  script strings, template literals and their safe encodings.
- `storedXssCases`: submit through a real form, require a displayed benign control,
  then load a separate view page per payload. Escaping and input rejection pass;
  undisplayed controls, server errors, blocked dependencies, bad selectors and failed
  login error the check.

All new settings are preflighted before browser traffic and require both disposable
flags. Remaining browser work: JSON/SPA CSRF and URL/CSS/unquoted XSS contexts.

## Chunk 5a: persistent uptime observations

`uptime.store` keeps a bounded local JSON Lines history (`src/core/observation-history.ts`).
Outages (`down`: HTTP, network, timeout), failed checks (`check-error`) and missing
observations (gaps) are distinct; availability is computed only over observed time
and a target is evaluated only with enough coverage. Validation happens before any
request, writes are locked, merged, pruned by age and count and replaced atomically,
and query strings are redacted. `qa uptime-export` pages through records with
filter-bound cursors. Hosted runners need a persistent volume to use it; there is
still no always-on monitoring daemon.

## Chunk 5b: post-deploy error sources and exports

`post-deploy-errors` accepts a provider-neutral `source` (NDJSON file or cursor-paged
HTTP JSON) plus deploy-relative windows. Fingerprints are redacted, non-reversible
labels; pagination must complete within limits and the window must have settled, or
the check errors. Both windows are exported in the existing window-file format.

## Chunk 4j: JSON/SPA CSRF and URL/unquoted XSS contexts

- `jsonCsrfCases`: `text-plain` (JSON body via a text/plain form), `form` and
  `cors-json` (server preflight checked directly, then a browser request) variants with
  an in-page JSON positive control that can send the app's CSRF header from a meta tag
  or cookie. Delivery and per-cookie block reasons come from Chromium's network log.
  Environment-caused blocks (blocked third-party cookies, Private Network Access) are
  inconclusive, never passes.
- XSS: `url` context (`javascript:` URLs, detected when executed or when placed in a
  navigable attribute) and an unquoted-attribute payload, for reflected and stored
  cases. CSS contexts are deliberately not claimed (no script execution oracle).

With this, the agreed Chunk 4 browser/API security scenarios are implemented as
explicit, bounded workflows. They are not exhaustive vulnerability detection.

## Status of the core plan

- Chunks 1, 3, 4 and 5: implemented with healthy and broken fixtures.
- Chunk 2 (recorder): importer, review page, cancellation and replay are tested; an
  actual native Inspector recording session by a person is still needed.
- Chunk 3: real MobSF acceptance fails honestly (no server, APK/IPA or API key
  available). Other tools were accepted on the Windows machine as recorded in
  VALIDATION.md.
- Chunk 6 (acceptance against the user's real project and disposable staging): the
  static part (Chunk 6a) and a live run against the real backend on a throwaway local
  MongoDB (Chunk 6b) are done; the run against the team's deployed staging still needs
  its URL and QA accounts.

So the core is not 100% complete: chunks 2, 3 (MobSF) and 6 still need external
resources or a person.

Chunks 4–6 have not been completed. Do not interpret these delivery slices as
100% core readiness.

## Chunk 7a: changed-lines (diff) coverage

Added `diff-coverage` (registered checks: 46). It combines the project's LCOV report
with `git diff base...HEAD` and measures coverage of the executable lines the change
adds or modifies, with a configurable minimum. Missing files are reported, stale or
empty reports and unknown refs error, and git cannot be made to run repository-defined
programs. Next candidates in this chunk: a code-quality gate (project typecheck and
ESLint, new errors only), flaky-test detection from JUnit history, a MongoDB
index/query check and log hygiene.

## Chunk 7b: code-quality gate

Added `code-quality` (registered checks: 47). It runs the project's own `tsc --noEmit`,
ESLint and Dart analyzer (or imports their saved output) and fails only on diagnostics
that are new compared with a committed baseline written by `qa run --baseline`.
Diagnostics are compared by tool, file, rule and message with counts, so moved code is
not reported and duplicates are. A missing baseline, a tool that could not really run,
and stale imported reports error instead of passing. Tools come from the project's own
`node_modules`, never a global copy.

## Chunk 7c: flaky-test detection

Added `flaky-tests` (registered checks: 48). Each run records the project's JUnit
results in a bounded local history keyed by the tested commit. Tests are reported when
they failed and passed on the same clean commit, passed only after a retry, or keep
changing result across recent runs (suspected). Too little history is reported as
skipped with progress, never as passed; stale or repeated reports are not recorded.
JUnit parsing is now shared with `test-results`, which also fixed `flakyError` being
counted as a plain pass.

## Chunk 7d: MongoDB indexes and log hygiene

Added `mongo-indexes` and `log-hygiene` (registered checks: 50).

`mongo-indexes` reads Mongoose models, declared indexes and the queries in the backend
source and reports query shapes no index can serve, plus duplicate and redundant
indexes. Its discovery was compared with real Mongoose 8.24.10 on the test models
(same indexes, options and collection names). Optional live checks use a read-only
connection for real indexes, query plans, unused indexes and profiler scans. The live
part has not been run against a real MongoDB server yet (none is available in this
sandbox); that acceptance is an open validation gap.

`log-hygiene` reports logging calls that write request bodies, headers or secrets,
scans log files for credentials and personal data without reporting values, and, in a
disposable environment, proves leaks with a canary value searched only in new log lines.

This completes the candidates listed for chunk 7. The core is still not 100% complete:
chunks 2 (a person's native recording session), 3 (MobSF) and 6 (real-project
acceptance) need external resources or a person, and the live MongoDB acceptance above
is open.

## Functionality audit (18 November 2026)

A full audit fixed eight functional problems (details in VALIDATION.md): static-only
runs failing when the API was down, route discovery blocking checks that do not read
routes, CLI crashes on synchronous command errors, silent results for a mistyped uptime
file and an invalid wait timeout, a browser error on every dashboard page under the
production CSP, `.tsx`/`.jsx` files skipped by the source scanners, `load-stress`
erroring instead of skipping without a target, and a `::add-mask::` false positive. The
open items listed above are unchanged.

## Chunk 8a: API scenarios (advanced functional API testing)

Added `api-scenarios` (registered checks: 51): multi-step functional API tests written in
YAML/JSON with chained requests, value, schema and snapshot assertions, cleanup, and
tags for smoke, regression and UAT sets, producing JSON and JUnit reports. A starter
file is in `examples/api-scenarios.yaml`.

## Chunk 8b: database testing

Added `db-checks` (read-only data-integrity rules with expected counts on MongoDB,
PostgreSQL or MySQL/MariaDB) and database steps in API scenarios (check what an API call
stored, and use stored values in later steps). SQL runs as one validated SELECT inside a
READ ONLY transaction with a server time limit; MongoDB refuses write stages and
server-side JavaScript. Validated against real PostgreSQL 16 and MariaDB 10.11 servers
and embedded PostgreSQL; MongoDB acceptance is still open (no server available here).

## Chunk 8c: injection probes

Added `injection-probes`: NoSQL operator injection and SQL injection (boolean, error,
optional time delay) on listed inputs, each judged against a control request and
repeated, in disposable environments only, with no stacked or data-changing statements.

## Chunk 8d: UAT sign-off

Added user acceptance testing to the platform (migration `015_uat.sql`, API under
`/projects/:projectId/uat`, dashboard tab "Acceptance"): releases with acceptance
criteria, recorded results with notes and evidence runs, sign-off only when every
criterion passed, rejection with a reason, a lock until reopened, audit events, and a
Markdown/JSON report. Permissions `uat.record` (owner, admin, developer) and
`uat.decide` (owner, admin).

With chunks 8a-8d, functional, regression, smoke, UAT, API and database testing are all
covered by automated checks. The core is still not 100% complete: chunks 2, 3 and 6 and
the live MongoDB acceptance need external resources or a person.

## Chunk 6a: real-project acceptance, static part (MLITech backend)

The checks that read source and configuration were run against the public MLITech backend
repository (commit `ac766c4`): route discovery, route-auth, env-drift, secrets, deps,
validation-coverage, code-quality, mongo-indexes, log-hygiene and Semgrep. Every verified
finding was a real problem (no false positives found), including four critical routes
without authentication. The run exposed four VeriQ defects, all fixed with tests (details in
VALIDATION.md): findings with a shared fingerprint were silently dropped (14 of 33 index
findings, 10 of 20 Semgrep matches), pull-request scanner runs filtered out every match,
long findings could make a platform upload fail, and `health-cors` could not detect loose
origin checks.

Chunk 6 is not complete: the live part (API authorization, tenant isolation, CORS, sockets,
dashboards and flows against a running deployment with QA accounts) still needs staging
access, and the live MongoDB analysis still needs a database. The core is therefore still
not 100% complete: chunks 2, 3 (MobSF) and the live part of 6 remain.

## Chunk 6b: live acceptance on a throwaway MongoDB (MLITech backend)

The MLITech backend (commit `ac766c4`) was built and run locally, two instances sharing
Redis, on MongoDB 8.3.7 started as a single-node replica set from the conda-forge package
(a package registry; no Docker image could be pulled). VeriQ's CI seed created the QA
accounts, exactly as the PR workflow in `integrations/mlitech/qa.yml` does. The PR suite
(539 requests), the MLITech business scenarios, injection probes and live index analysis
ran against it. Every scenario failure was checked against the backend's code; all are
real behaviour of this commit (details and the list in VALIDATION.md). The live MongoDB
acceptance gap is closed: `test/mongo-live.test.ts` runs db-checks, scenario database
steps and mongo-indexes live mode against the real server.

## Chunk 8e: testing levels (scenario lint, Newman, UAT evidence)

- `scenario-lint` (plugin 54, static): scenario files are checked against the discovered
  routes in every PR, without a target.
- Newman (Postman) JUnit: repeated assertion names in different requests stay separate
  tests in `test-results` and `flaky-tests`.
- UAT: scenario outcomes are uploaded with each run (migration `016_run_cases.sql`); a
  criterion linked to a scenario shows its latest result and can attach that run as
  evidence; the criterion form suggests scenario names.
- `mongo-indexes`: indexes MongoDB can never build (unsupported `partialFilterExpression`
  operators) and declared indexes missing from the live database.

## Chunk 8f: a generic product, applied per project

- The repository root holds no project's configuration any more. The MLITech setup (local
  config, CI seed, the workflow without the platform, its `.env.qa.example` and known issues)
  moved to `integrations/mlitech/`, next to the files that go into the MLITech repository.
- `qa init` sets VeriQ up on any project: it reads an Express backend (TypeScript or
  JavaScript, ES imports or CommonJS `require`, routes in the index or mounted from it),
  finds the API prefix, health path, login route and its body field, roles and open routes,
  and writes `qa.config.ts`, `.env.qa.example` and, with `--ci`, a pull-request workflow.
  Without Express source it writes an OpenAPI starter. It never overwrites a file; only
  routes public by nature are accepted, the other open routes stay reported.
- Route discovery now reads CommonJS apps (`require`, `router.use("/x", require("./x"))`,
  routes declared in the routes index itself).
- The self-test report is titled "VeriQ self-test: planted bugs (the gate must fail)": its
  failed gate is the expected result.

Still open for the core: Chunk 2 (a recorder session with a person), Chunk 3 (MobSF:
server, APK and key unavailable), the run against the deployed staging, and a full run on
Windows. The core is not claimed 100% complete.

