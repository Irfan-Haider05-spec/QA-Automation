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
- Chunk 6 (acceptance against the user's real project and disposable staging): not
  started; it needs target configuration and access.

So the core is not 100% complete: chunks 2, 3 (MobSF) and 6 still need external
resources or a person.

Chunks 4–6 have not been completed. Do not interpret these delivery slices as
100% core readiness.
