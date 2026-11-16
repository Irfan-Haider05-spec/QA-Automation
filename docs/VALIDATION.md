# VeriQ validation and fixes

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
