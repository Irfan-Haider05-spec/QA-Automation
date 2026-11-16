# VeriQ checks and configuration

There are 45 registered checks: 18 existing plugins and 27 additions. Registration
does not mean all checks ran. A missing prerequisite is **skipped**, invalid input or
a failed tool is **errored**, and an errored selected check fails the CLI gate.
Review the coverage table in every report before drawing conclusions.

The root nightly suite includes all 45. Active checks require explicit settings;
they are not guessed from a production application's route names.

## Start on a real project

To run the platform locally, start the API with the generated secrets described in
`apps/api/README.md` (`npm run api:dev`), then start `npm run dashboard:dev` in a
second terminal and open `http://localhost:5173`. Create your own account/project.
The default local database persists in `apps/api/.data/`; test suites use disposable
in-memory databases. No cloud service is required for this local setup.

1. `npm ci` (Node 20 or newer).
2. Copy `examples/veriq.config.ts` to the target project's `qa.config.ts`, or run
   `npm run qa -- init -c <new-config-path>`; init refuses to overwrite files.
3. Export OpenAPI 3.0/3.1 or a Postman 2.1 collection. Configure `discovery.file`
   relative to the config. Use `backend: false` if there is no Express source.
4. Configure the deployment URL and dedicated QA accounts using environment
   variables. Keep mutations disabled for the first live run.
5. Run `npm run qa -- discover -c <config>` and inspect the route inventory.
6. Run `npm run qa -- run -c <config> --suite local`. Review `qa-out/report.html`.
7. Add explicit authorization cases, artifacts and web pages, then expand suites.
8. Add `--upload` with platform credentials when deploying the platform. Cloud
   evidence storage is optional and is configured on the API server.

OpenAPI imports do not fetch external references; bundle them first. Paths are
used literally, independent of the OpenAPI servers URL. Include a server base path
in the configured target URL when necessary. Roles use `x-veriq-roles`; OAuth
scopes are not assumed to be application roles. Postman scripts are never executed.
Import does not infer role permissions from descriptions. Native readers for other
frameworks are not included; their exported API definitions work across stacks.

## Authentication

- Default/bearer: JSON login, configurable body template and token path. An account
  may supply `accessToken` from an environment variable instead.
- Cookie: `login.strategy: 'cookie'`, `cookieNames: ['session']`; only named session
  cookies are forwarded to the configured API origin.
- API key: `login.strategy: 'api-key'`, `headerName: 'x-api-key'`, account `apiKey`.
- OAuth2 client credentials: `strategy: 'oauth2'`, `oauth: { tokenUrl,
  clientIdEnv, clientSecretEnv, scope? }`. Token URL must be HTTPS. This is one
  service principal; do not label it as several different user roles.
- OTP second step: `login.otp: { path, codeEnv, challengePath, challengeField?,
  codeField? }`. Supply a fresh dedicated test-account code in the environment.
- Custom: `strategy: 'custom', customScript: './login.mjs'`. Default export receives
  `{account, http}` and returns headers. This is explicitly trusted local code.

Custom login modules and plugin modules are not accepted in hosted job profiles.
The existing hosted runner's bearer-only profile is intentionally restricted;
new login strategies currently run through the CLI/CI path.

## Plugin settings

Scripted business flows can replay across engines independently of the page-level
`cross-browser` check. Configure `flows: { browsers: ['chromium', 'firefox', 'webkit'] }`.
The default remains Chromium. Multi-engine results and screenshots include the
engine name; contexts are isolated. Install each requested engine. Missing engines
error the check rather than silently reducing coverage. Mutating flows execute once
per engine, so use disposable records and unique test data.

Settings live in `pluginSettings['plugin-name']`. Unknown fields in checked schemas
are rejected. `request` below means `{method?, path, account?, json?}`; method defaults
to GET. Paths are same-origin absolute paths. Active tests require **both**
`allowMutations: true` and `disposable: true`, with disposable QA records.

| Check | Required settings / behavior | Limits of current coverage |
|---|---|---|
| authz-matrix | `cases: [{...request, expectedStatuses: [403]}]` | Explicit cases; no automatic business-policy inference. Use valid bodies and verification flows for mass assignment. |
| auth-session | `account, protectedPath, logoutPath?, weakSecrets?, jwtProbes?, refresh?` | JWT probes plus optional explicit JSON refresh rotation/reuse/logout lifecycle. Access revocation is tested only when requested by policy. Password policy is the separate `password-policy` check. |
| rate-limit | `cases: [request], attempts (2–50), maxWindowMs` | Active; respects request budget and refuses impossible windows. Reports the configured threshold, not universal absence of limits. |
| password-policy | `cases: [{method?, path, account?, body, minLength?, checks?, commonPasswords?, acceptedStatuses?, rejectionStatuses?}]` | Active, disposable. Creates a distinct user per submission: strong-password positive control, then short/common/identifier passwords must be refused and (optionally) a 64-character passphrase accepted. Reports the configured candidates only, not general password strength. |
| data-exposure | No settings | GET responses with known params/accounts; flags secret fields, not arbitrary emails/phones without a data-ownership contract. Values omitted. |
| validation-coverage | No settings | Static route/schema evidence; handler validation may require review. Declared schemas are not proof of runtime enforcement. |
| sast | `report`, optional `run: true, rules, target, baseline` | Semgrep SARIF 2.1.0. Local rules required for execution. Baseline and changed-file filtering supported. |
| api-contract | `baseline, current` OpenAPI files | Removed operations/media/responses/properties, required inputs, request type/enum/bounds restrictions, response type/enum/required guarantees. Operation parameters override path parameters. Bounded comparison subset; not a complete semantic compatibility engine. |
| test-results | `junit, coverage?, minLinePercent?, baselineLinePercent?, maxDrop?, execution?` | Imports JUnit/Istanbul or runs explicitly configured trusted local tests with fresh report paths. Retry markers remain visible as flaky. See CORE-COMPLETION.md. |
| uptime | `requests: [request], maxMs?, history?, store?` | GET samples; optional bounded local observation history with coverage, gaps, outage episodes and an availability target evaluated only over observed time. Not a monitoring daemon: observations exist only when runs are scheduled. |
| tls-dns-mail | `host, port?, warnDays?, mailDomain?, dkimSelectors?, domainExpiresAt?` | TLS trust/expiry and DNS policy. No legacy-cipher enumeration; registration expiry is supplied, not a WHOIS guess. |
| race-conditions | `request, concurrency (2–10), verify, valuePath, expectedValue` | Active; verifies an application state invariant. Throttling is retained; timing stats do not prove server-side overlap. |
| file-upload | `path, account, field, maxAcceptedBytes, expectedStatuses?` | Active; bounded multipart invalid-type/traversal-name/oversized probes. Acceptance is not proof of remote code execution. |
| webhook-security | `cases: [{...request, signatureHeader, staleSignatureEnv?, state?}]` | Active POST probes; optional protected-state polling distinguishes acknowledge-and-ignore handlers from unauthorized processing and requires a valid-signature positive control. |
| web-client-security | `pages?`, `xssCases?`, `storedXssCases?`, `redirectCases?`, `clientRedirectCases?`, `csrfCases?`, `jsonCsrfCases?` (see sections below) | Storage-key heuristics, mixed resources, SRI, explicit reflected (HTML/attribute/script/URL contexts) and stored script-execution canaries, JSON/SPA CSRF, HTTP and client-side open-redirect probes and state-verified CSRF. Does not claim comprehensive XSS/open-redirect/CSRF detection. |
| web-forms | `cases: [{app,path,public?,form,fields:{selector:value},submit,errorSelector}]` | Active; explicit invalid cases, native/application feedback, crashes. Does not blindly submit every form. |
| cross-browser | `pages`, optional `browsers, viewports` | Chromium/Firefox/WebKit page errors, blank pages and overflow; existing flow files are not automatically replayed. |
| links-seo | `pages` with `public:true`, `maxLinks?, checkDiscoveryFiles?` | Public metadata/images and bounded same-origin HEAD probes. HEAD 405 is not called a broken link. No third-party crawling. |
| container-iac | `report`, optional `run:true, target, baseline` | Trivy filesystem vulnerability/misconfiguration/secret SARIF; pre-generated image scan SARIF may also be imported. |
| mobile-static | `report` OR `execution` | MobSF JSON code/Android manifest/iOS binary findings; execution uploads an APK/IPA to an explicitly configured server, requests a rescan and validates the result. Static analysis only. |
| post-deploy-errors | `release` plus `baseline,current` window files, or `source,windows` (NDJSON file or paged HTTP JSON) | Provider-neutral complete error windows; normalizes duration; source mode derives redacted fingerprints, requires complete pagination and a settled window, and exports both windows. |
| graphql | `path, forbidIntrospection?, cases:[{query,account?,shouldReject}]` | Active; introspection and explicit role/depth/cost query cases. Partial returned data counts as acceptance. |
| license-sbom | `file, allowedLicenses` | CycloneDX JSON. Complete SPDX expressions checked against project policy; does not make legal compatibility judgments or generate a dependency graph. |
| i18n-rtl | `baseFile,translations,rtlPages?` | JSON key parity and actual document direction/overflow. Does not infer untranslated natural-language strings. |
| privacy-consent | `pages,trackerHosts,privacyPath,observeMs?` | Fresh public browser sessions; configured trackers only. A technical observation, not a compliance certification. |
| load-stress | `report` OR `execution`, plus `maxP95Ms,maxErrorRate,minRequests?` | k6 summary import or bounded same-origin GET execution. Execution requires disposable/allowMutations, rate budget and installed k6; arbitrary scripts/cloud load remain separate. |
| bundle-budget | `directory,maxBytes,maxGzipBytes,baselineGzipBytes?,maxGrowthPercent?` | Recursive built JS total/gzip sizes; rejects symlinks and empty builds. |

Read the checked schemas in `src/plugins/expanded/` for exact optional defaults.
Missing browser engines are an error when requested; install them with
`npx playwright install chromium firefox webkit`. `QA_CHROMIUM_PATH` can select a
locally installed Chrome. WebKit is the browser engine, not the complete Safari app.

## External report formats

SAST/containers: SARIF 2.1.0, `runs[].results`. Explicit unsuccessful scanner
invocations are errors. Source snippets are omitted from platform findings because
scanner output can contain credentials. Keep raw reports under CI access control.

Error tracker adapter files:

```json
{"release":"v1.2.3","durationSeconds":300,"complete":true,"errors":[{"fingerprint":"stable-error-id","count":7}]}
```

`complete:true` means the exporter has consumed every page of the provider's API.
Compare complete baseline/current windows. Do not silently truncate an export.

Uptime history: `[{"at":"2026-11-12T00:00:00.000Z","available":true}]`.
Duplicate timestamps are rejected. This is a sample ratio, not an SLA calculation.

### Persistent uptime observations

```ts
uptime: {
  requests: [{ path: '/health' }],
  maxMs: 2000,
  store: { path: 'qa-history/uptime.jsonl', intervalSeconds: 300, retentionDays: 90,
           maxEntries: 50000, windowHours: 168, targetPercent: 99.5, minCoveragePercent: 80 },
}
```

Each run appends one record per request to a local JSON Lines file inside the config
directory: UTC time, `GET <path>` with any query replaced by `?[redacted]`, outcome,
HTTP status, latency and a reason. No headers, bodies or credentials are stored.

- `up` / `slow`: 2xx, under / over `maxMs`.
- `down`: an outage observation, either a non-2xx answer (`http`) or a `network` /
  `timeout` failure.
- `check-error`: the check itself could not run (for example its account could not
  authenticate). It is not an outage; the plugin still errors for that run.
- Missing observations are gaps. A successful observation covers at most
  1.5 × `intervalSeconds` after it (set this to your schedule's cadence). Time not
  covered, and time covered only by check errors, is unobserved: neither up nor down.

Summary per target over `windowHours`: coverage %, availability % over observed time,
down seconds, outage episodes and the longest one, and up to 50 gaps, written to
`<outDir>/uptime-history.json`. With `targetPercent`, a target below it is a finding,
but only when coverage is at least `minCoveragePercent`; otherwise the finding says
the target cannot be evaluated. Without a target, the history is reported only.

Safety and restarts: the file is validated before any request. A corrupt or future
line (clock moved back) errors the run and leaves the file untouched; links, absolute
paths, `..` and non-`.jsonl` paths are refused. Writes take a lock file (a lock older
than two minutes is treated as stale), merge with the current file, prune by
`retentionDays` and `maxEntries`, and replace the file atomically, so concurrent or
interrupted runs do not lose or half-write records. Because state is only this file,
a restart simply continues from it. This is a local store: hosted runners need a
persistent volume for it, and it is not a substitute for an always-on monitor.

Export a page of stored records (oldest first; filters are bound to the cursor):

```
qa uptime-export --file qa-history/uptime.jsonl --target "GET /health" --outcome down --limit 100
qa uptime-export --file qa-history/uptime.jsonl --target "GET /health" --outcome down --limit 100 --cursor <nextCursor>
```

### Post-deploy errors from an event source

Instead of pre-built window files, `post-deploy-errors` can read raw events:

```ts
'post-deploy-errors': {
  release: 'v2.4.0',
  windows: { deployedAt: '2026-11-15T09:00:00Z', baselineSeconds: 3600, currentSeconds: 3600, settleSeconds: 120 },
  source: { kind: 'ndjson', file: 'exports/errors.ndjson',
            fields: { timestamp: 'timestamp', fingerprint: 'fingerprint', message: 'message', release: 'release' } },
  // or a paged JSON API:
  // source: { kind: 'http', url: 'https://errors.example.com/api/events', tokenEnv: 'ERRORS_API_TOKEN',
  //           pageSize: 100, maxPages: 50, eventsPath: 'data', nextCursorPath: 'next', fields: { ... } },
}
```

- Fields are dot paths. A timestamp may be ISO-8601 or epoch seconds/milliseconds.
  A provider `fingerprint` is used after removing emails, URLs and tokens; otherwise
  the `message` is normalized (emails, URLs, UUIDs, hex runs and numbers replaced) so
  equal errors group together. Both are stored only as a short SHA-256 label: raw
  messages never reach findings or exports.
- With a `release` field, post-deploy events from other releases are not counted
  against this release (reported as `otherReleaseEvents`).
- The current window must have ended `settleSeconds` ago, otherwise the check errors
  without reading the source: an unfinished window cannot show an absence of errors.
- The HTTP source sends `from`, `to`, `limit` and `cursor` parameters (names
  configurable), follows `nextCursorPath` until it is empty, and requires HTTPS
  (plain HTTP only for loopback). It refuses URL credentials and redirects, bounds
  each response to 10 MiB, rejects pages larger than `pageSize` and repeated cursors,
  and errors if more than `maxPages` pages would be needed. The token comes only from
  `tokenEnv` and is never reported. NDJSON files are bounded to 50 MiB; invalid lines
  error with their line number only. Both are capped at 200,000 events.
- The baseline and current windows are written to
  `<outDir>/post-deploy-errors-baseline.json` and `-current.json` in the window-file
  format above, so they can be archived or re-imported.

Provider specifics (authentication beyond a bearer token, rate-limit headers, other
pagination styles) need an exporter that produces NDJSON or window files.

k6: export the object passed to `handleSummary(data)` as JSON. Required metrics:
`http_reqs.values.count`, `http_req_duration.values['p(95)']`, and
`http_req_failed.values.rate`; failed k6 thresholds also become findings.

For direct execution, add this to your existing config (adjust the endpoint and
limits to the disposable test environment):

```ts
allowMutations: true,
disposable: true,
target: { baseUrl: process.env.QA_BASE_URL, requestsPerMinute: 120 },
pluginSettings: {
  'load-stress': {
    execution: {
      path: '/health', // appended to target.baseUrl; no query or fragment
      vus: 1,
      iterations: 20,
      requestsPerSecond: 2,
      maxDurationSeconds: 30,
      requestTimeoutMs: 5000,
      // account: 'dedicatedQa', // optional existing account
      // executable: 'C:/tools/k6.exe', // default: k6 on PATH
    },
    minRequests: 20,
    maxP95Ms: 1000,
    maxErrorRate: 0.01,
  },
},
```

Run with `npm run qa -- run -c <config> --only load-stress`. Missing k6, incomplete
iterations, malformed reports and inconsistent exit/threshold results are errors,
not passes. Execution is limited to 20 VUs, 10,000 iterations, 100 requests/second
and 120 seconds, subject to the tighter project rate budget. k6's rate limit and
VU scheduling do not promise perfectly even spacing between requests. No cloud
service is invoked. See the [official custom summary contract](https://grafana.com/docs/k6/latest/results-output/end-of-test/custom-summary/).

## Refresh/session lifecycle checks

Use a dedicated QA account and set `allowMutations: true` and `disposable: true`.
The check deliberately consumes/replays refresh tokens and can revoke sessions.
Login credentials/body template come from the existing `accounts` and `login`
configuration. Fresh sessions are independent of the engine's cached access token.

```ts
pluginSettings: {
  'auth-session': {
    account: 'sessionQa',
    protectedPath: '/api/me',
    jwtProbes: false, // use true as well for JWT-specific checks; false supports opaque tokens
    refresh: {
      path: '/api/refresh',
      refreshTokenPath: 'tokens.refreshToken',
      accessTokenPath: 'tokens.accessToken',
      requestField: 'refreshToken',
      reusePolicy: 'revoke-family', // or 'reject-only', matching your API's contract
      revokeAccessOnReuse: false, // true only if the API promises immediate access revocation
      logoutPath: '/api/logout',
      revokeAccessOnLogout: false,
      // logoutRequestField: 'refreshToken',
      // rejectionStatuses: [400, 401, 403], // add 400 only if refresh rejection uses it
    },
  },
},
```

The configured refresh response paths apply to both login and rotation responses.
JSON password-based bearer login is supported; cookie/OAuth/OTP/custom strategies
are rejected before this lifecycle starts. JWT probes remain enabled by default.
Disabling them requires `refresh`; put logout settings inside that block.

An anonymous negative control and authenticated positive controls establish that
the protected route is meaningful. Invalid and previously consumed refresh tokens
must be rejected; rotation must issue a different refresh token. With reject-only,
the current token must remain usable; with revoke-family it must be rejected.
Logout is tested using a separate fresh session. Optional access revocation accepts
only 401/403; refresh rejection defaults to 401/403 and can explicitly include 400.
429, 5xx, redirects, missing token fields and failed positive controls are errors,
not evidence of secure rejection. Mutations are never automatically retried.
Session findings omit tokens and response bodies. Dedicated accounts should not
be used concurrently by other QA processes during these checks.

## MobSF static analysis execution

Use your own MobSF server; none is bundled or started automatically. Local HTTP
requires a loopback IP (`127.0.0.1` or `[::1]`). Remote execution requires HTTPS and
explicit `allowRemote: true`, which authorizes uploading the **entire binary** to
that configured server. Do not use public/demo servers for proprietary builds.

```ts
pluginSettings: {
  'mobile-static': {
    execution: {
      serverUrl: 'http://127.0.0.1:8000',
      binary: './build/application.apk', // .ipa also supported
      apiKeyEnv: 'MOBSF_API_KEY', // resolve key from environment, never inline
      timeoutMs: 300000,
      pollIntervalMs: 1000,
      maxBinaryMiB: 100,
    },
  },
},
```

Run `npm run qa -- run -c <config> --only mobile-static`. API keys must contain
16–256 letters/digits or `.`, `_`, `~`, `-`. Unsupported key formats fail locally.
The client uses upload → scan (`re_scan=1`) → report. Async scans poll the exact
returned task ID until successful completion. Cached/null task IDs are rejected.
MD5 matches MobSF's lookup identifier; SHA-256 is also checked when returned.
MD5 identity alone is not a cryptographic authenticity guarantee.

Redirects and automatic mutation retries are disabled. Timeout or cancellation
stops the client, **not necessarily the remote scan**. Uploads/scan records remain
on your server under its retention policy; the client never deletes shared scans.
Only normalized findings are retained in VeriQ reports; raw scanner responses,
embedded source strings and API error bodies are not saved by this integration.
Static code rules, Android manifest rules and iOS binary rules are normalized;
ATS, Mach-O hardening tables, tracker findings and dynamic/device analysis are
outside this adapter's current normalized coverage. Server-side suppressions still
apply; inspect your MobSF policy before treating a clean report as full coverage.

The workflow follows the [MobSF API implementation](https://github.com/MobSF/Mobile-Security-Framework-MobSF/blob/master/mobsf/MobSF/views/api/api_static_analysis.py)
and [async task contract](https://github.com/MobSF/Mobile-Security-Framework-MobSF/blob/master/mobsf/StaticAnalyzer/views/common/async_task.py).
Contract tests use a disposable fixture service, not the MobSF analysis engine.
For real local acceptance set `QA_TEST_MOBSF=1`, `QA_MOBSF_URL`,
`QA_MOBSF_BINARY` (absolute APK/IPA path) and `MOBSF_API_KEY`, then run
`node --import tsx --test test/mobsf-execution.test.ts`. The live acceptance test
restricts the service to local loopback by default. See VALIDATION.md for results.

## Plugin SDK

Add trusted paths/packages to `plugins: ['./custom-plugin.mjs']`. A v1 plugin exports
`apiVersion: 1`, name, layer, description, a `settingsSchema.parse` validator and
`run(ctx)`. See `examples/custom-plugin.mjs`. Names cannot override built-ins;
returned findings are validated and redacted. The SDK is an interface, not a sandbox.

## Evidence storage

On the API configure `ARTIFACT_BUCKET`, `ARTIFACT_REGION`, optionally
`ARTIFACT_ENDPOINT` (HTTPS) and `ARTIFACT_PATH_STYLE`. Supply credentials through
the official SDK credential chain, e.g. deployment environment variables. Use a
private bucket and a service identity restricted to that bucket/prefix.

`--upload` uploads report-linked screenshots and Lighthouse HTML after storing the
run. Maximum 100 files/run, 5 MiB/file. Paths cannot escape `outDir`, including via
symlinks. Server checks base64 and SHA-256, scopes ownership to the API-key project,
and makes each artifact name immutable. The dashboard exposes authorized download
links valid for five minutes. Content is attachment/octet-stream, not executable
HTML on the application origin. Missing storage leaves the run intact and reports
incomplete evidence upload explicitly. Hosted-run evidence upload is not yet wired.

`ARTIFACT_RETENTION_DAYS` defaults to 30; API cleanup retries object deletion before
removing metadata. Run deletion retains cleanup tombstones. Configure a bucket
lifecycle rule as disaster-recovery protection for a platform/database outage.
This is evidence retention, not yet per-plan billing or PostgreSQL run retention.

## Before accepting a real-project run

- Check the target URL, route count, role/account mapping and plugin skip reasons.
- Compare findings with the application behavior and the actual request evidence.
- For expected permission failures, use a valid request body so validation errors
  cannot be mistaken for authorization enforcement.
- Run active probes only against disposable data; both safety flags are required.
- Keep a report from a deliberately broken fixture and a healthy fixture when
  extending a check. Fix the implementation or fixture setup at the root cause;
  never lower an assertion merely to obtain a pass.
- A passing suite does not establish that unconfigured checks or external scanners
  were executed. See `ARCHITECTURE.md` for the larger product work still remaining.

## Webhook protected-state configuration

Use isolated disposable test data with `allowMutations: true` and `disposable: true`.
The valid signature must sign the exact JSON bytes produced by `JSON.stringify`
for the configured payload; supply it through an environment variable. Raw-body
signing formats are not supported by this workflow. Provision a fresh event/record
for every run. The initial state must differ from `expectedValue`.

```ts
pluginSettings: {
  'webhook-security': {
    cases: [{
      method: 'POST', path: '/webhooks/test',
      json: { eventId: 'fresh-disposable-event', action: 'complete' },
      signatureHeader: 'x-webhook-signature',
      // staleSignatureEnv: 'QA_STALE_SIGNATURE',
      state: {
        verify: { path: '/qa/events/fresh-disposable-event', account: 'qa' },
        valuePath: 'processed', expectedValue: true,
        validSignatureEnv: 'QA_VALID_SIGNATURE',
        observeMs: 1000, pollIntervalMs: 100,
      },
    }],
  },
}
```

State verification is GET-only and must return a primitive or null at `valuePath`.
Each invalid probe must leave state unchanged throughout its observation window;
the valid probe must produce the expected value. Processing after that window is
not excluded. No cleanup is inferred: the operator owns fixture reset. Without
`state`, legacy HTTP rejection checks remain, including findings for 2xx responses.
Signatures are bounded environment values and are omitted from findings.

Contract comparison supports a bounded object-schema subset. Requests are checked
for narrowing types/enums, new required properties, basic minimum/maximum and
length/item/property bounds, pattern/format changes and additionalProperties false.
Responses are checked for removed properties, widening types/enums and removed
required guarantees. Parameter inheritance honors operation overrides. Boolean
schemas and composition/conditional constructs are unsupported and error when
encountered in the compared schema paths. This is not an exhaustive JSON Schema
solver: exclusive bounds, multipleOf, schema-valued additionalProperties changes,
discriminators and all response constraint changes are not fully compared. Optional
response property removals are conservatively reported for review.

## Explicit browser script-execution probes

```ts
pluginSettings: {
  'web-client-security': {
    pages: [{ app: 'frontend', path: '/', public: true }],
    xssCases: [{
      app: 'frontend', path: '/search', public: true,
      queryParam: 'q', readySelector: '[data-testid="search-ready"]',
      observeMs: 500, contexts: ['html', 'attribute', 'script'],
    }],
  },
}
```

Active cases require both `allowMutations` and `disposable`. Only explicitly
configured query parameters receive canaries; each canary's sole action sets a
random in-page boolean. `contexts` (default `['html']`) selects payload sets, each
visited on a fresh page until one executes:

- `html`: an image element with an error handler.
- `attribute`: double- and single-quoted attribute breakouts with that element, and
  an `autofocus`/`onfocus` attribute that needs no angle brackets.
- `script`: single-quoted, double-quoted and template-literal string breakouts, and
  closing the script element.
- `attribute` also includes an unquoted-attribute breakout that needs neither quotes
  nor angle brackets.
- `url`: a `javascript:` URL (and a tab-prefixed variant). It counts when the canary
  runs (for example as an iframe `src`) or when the value lands in a navigable
  attribute (`href`, `src`, `action`, `formaction`, `data`) as a `javascript:` URL
  carrying the marker, since following it runs script. Links are never clicked.

One finding is reported per executing context. It does not read credentials or
send data. Each case uses a fresh context; normal configured login is supported.
After login, HTTP requests outside the app origin are blocked. If blocking prevents
execution, the case errors rather than passing with incomplete dependencies.
Use self-contained disposable fixtures for this mode. The readiness selector must
identify exactly one visible element. Navigation/readiness/dependency errors use a
generic message to avoid exposing the payload or query values in browser errors.

This proves execution only when the canary runs in the main page. A pass means no
execution was observed for these payloads and time window; it does not prove all
inputs are sanitized. CSP may prevent execution even when HTML injection exists.
CSS contexts are not tested: current browsers do not run script from CSS, so CSS
injection needs a different oracle (data exfiltration), which this probe does not
model. Encoding variants beyond those listed, execution inside iframes other than via
`top`, interaction-dependent handlers and delayed execution beyond the window are not
established by this probe. Stored values use `storedXssCases` below.

## Explicit stored-XSS probes

```ts
pluginSettings: {
  'web-client-security': {
    storedXssCases: [{
      app: 'frontend', formPath: '/qa/comments/new', formSelector: '#comment-form',
      submitSelector: 'button[type="submit"]', payloadField: 'body',
      fields: { title: 'QA disposable' },
      viewPath: '/qa/comments', readySelector: '#comments',
      observeMs: 1000, contexts: ['html', 'attribute', 'script'],
    }],
  },
}
```

Both disposable flags are required: every submission stores data that is not
cleaned up. A browser logs in (unless `public`), blocks cross-origin requests and
fills the unique form's configured fields, putting each value in `payloadField`.
First a benign random control text is submitted; it must appear in the view page's
text within `observeMs`, proving the value is stored and displayed. Then the same
context payloads as `xssCases` are submitted one at a time, each followed by a fresh
load of `viewPath`. Execution of the random marker on the view page is a CWE-79
finding. Because stored payloads stay on the page, the first execution ends the case
and later contexts are not tested. Rejected submissions (for example HTTP 422) are a
safe outcome; a server error during submission, a control that is not displayed, a
non-unique form, field, submit button or ready element, login failure, or a blocked
external dependency without a finding errors the check. Payloads and control text
never appear in results.

Not covered: values shown only to other roles or in other views, rich-text editors
and file uploads, values that need moderation before display, and execution in
emails, exports or admin consoles.

## Explicit HTTP open-redirect probes

`web-client-security.redirectCases` adds bounded HTTP Location checks:

```ts
pluginSettings: {
  'web-client-security': {
    redirectCases: [{
      app: 'frontend', path: '/continue', public: true,
      queryParam: 'next', safePath: '/dashboard',
      rejectionStatuses: [400, 403, 422],
    }],
  },
}
```

Both disposable flags are required. The positive control must redirect the supplied
same-origin `safePath` to that path with a successful terminal response. The probes
then supply an HTTPS URL and a protocol-relative URL for a reserved `.invalid`
destination. Each response is fetched without automatic redirects or retries;
only same-origin HTTP(S) redirects are followed, at most eight hops. Cross-origin
Location produces a finding without contacting that origin. Loops, missing Location,
unsupported schemes, server errors and inconclusive responses error the check.
Explicit 400/403/422 rejection or a successful terminal safePath is accepted.

Configured browser login can establish cookies before the HTTP probes; authenticated
checks use that context's request client. The destination and query values are not
included in findings or probe errors. This tests HTTP Location behavior only;
JavaScript navigation, meta refresh and popups use `clientRedirectCases` below.
Arbitrary encoding bypasses and CSRF are not covered here. It does not establish
safety for unconfigured redirect parameters.

## Explicit client-side (JavaScript/meta-refresh) redirect probes

`web-client-security.clientRedirectCases` checks navigation performed in the page
after it loads: `location` assignment, `location.assign/replace`, meta refresh and
`window.open` popups.

```ts
pluginSettings: {
  'web-client-security': {
    clientRedirectCases: [{
      app: 'frontend', path: '/continue', public: true,
      queryParam: 'next', safePath: '/dashboard', observeMs: 1500,
    }],
  },
}
```

Both disposable flags are required and every case is preflighted (app exists, paths
are same-origin, `safePath` has no query/fragment, `observeMs` is 100–10000) before
any page loads. Chromium runs with service workers blocked. A context route lets
same-origin requests through and aborts every other request before it leaves the
browser: a top-level page or popup navigation to another origin is recorded as an
external navigation; any other cross-origin request is recorded as a blocked
dependency. External destinations are therefore detected without being contacted.

Each case runs three phases on a fresh page:

1. Positive control: `safePath` must make the page navigate to that same-origin
   path within `observeMs`. Otherwise the check errors (the page may not redirect
   at all, may need a blocked dependency, or may not be the right page).
2. External inputs: an HTTPS URL, a protocol-relative URL and a `/\host` form for
   a reserved `.invalid` host. The last catches filters that only reject `//`.
   Any external top-level or popup navigation is a CWE-601 finding.
3. `javascript:` input: a canary that sets a random, non-configurable page marker.
   If the marker becomes true, the navigation sink runs script (CWE-79).

The probed page must answer 2xx without an HTTP redirect; an HTTP 3xx belongs to
`redirectCases` and errors this check. Login failure, missing responses, server
errors, a failed control and blocked external dependencies with no finding are all
errors, not passes. Error messages name the phase and reason only; the probe host,
marker and payloads never appear in findings or errors.

A pass means no external navigation or script execution was seen for these inputs
in the observation window. It does not cover delayed navigation beyond the window,
redirects that need user interaction, hash/fragment or storage-sourced values,
other parameters, encoding variants beyond the three listed, or iframe navigation.

## State-verified browser CSRF probes

```ts
pluginSettings: {
  'web-client-security': {
    csrfCases: [{
      app: 'frontend', formPath: '/settings/test-record',
      actionPath: '/settings/test-record',
      formSelector: '#test-record-form', submitSelector: 'button[type="submit"]',
      fields: { label: 'disposable-updated' },
      verifyPath: '/qa/test-record-state', valuePath: 'label',
      expectedValue: 'disposable-updated', observeMs: 500,
    }],
  },
}
```

Both disposable flags are mandatory. Provision isolated fresh records and a dedicated
cookie-authenticated account using the configured browser login form. The state GET
must return 401/403 anonymously and a bounded JSON primitive at `valuePath` after
login. Its initial value must differ from `expectedValue`. The legitimate form must
be a unique same-origin URL-encoded POST form whose action exactly matches actionPath.
Fields are editable named controls; do not configure CSRF tokens or credentials in
the attack fields. Existing hidden token fields stay in the legitimate form only.

The browser submits configured fields from a synthetic cross-site HTTPS page fulfilled
locally without contacting its `.invalid` host. Cookie SameSite behavior is preserved;
the engine never copies cookies or tokens into the attack. Any protected-state change
during the observation window is a finding, including after a rejection status. If
unchanged, the actual legitimate form must produce expectedValue or the check errors.
State reads use bounded in-browser fetch with redirects rejected. Other external HTTP
dependencies after login are blocked; errors report only a safe workflow phase.

Attack variants run in the order configured until one changes state:

```ts
csrfCases: [{ /* ...as above... */ variants: ['missing-token', 'forged-token', 'multipart', 'get'], tokenField: 'csrf' }]
```

- `missing-token` (default): URL-encoded cross-site POST with only `fields`.
- `forged-token`: also sends `tokenField` with a random value of the real token's
  length. The legitimate form must contain exactly one such field holding 8–512
  characters; only its length is read and the real value is never copied. This
  detects servers that check only that a token is present.
- `multipart`: the same fields as `multipart/form-data`, catching token checks that
  run only for URL-encoded bodies.
- `get`: a top-level cross-site GET navigation to `actionPath` with the fields as
  query parameters. SameSite=Lax cookies are sent on such navigations. 404/405 count
  as rejection for this variant.

Each variant has its own title. The first state change ends the case. Otherwise the
legitimate positive control runs after all variants. `forged-token` and `tokenField`
must be configured together, and `tokenField` may not appear in `fields`.

This covers cross-site top-level submissions in Chromium. It does not establish
protection against tokens from another session, same-site subdomain attacks or effects
outside the observation window. JSON/SPA endpoints use `jsonCsrfCases` below.

## JSON/SPA CSRF probes

```ts
jsonCsrfCases: [{
  app: 'frontend', appPath: '/settings', actionPath: '/api/profile', method: 'POST',
  json: { displayName: 'disposable-updated' },
  csrfHeader: { name: 'x-csrf-token', from: 'meta', key: 'csrf-token' }, // or from: 'cookie', key: 'XSRF-TOKEN'
  verifyPath: '/api/qa/profile-state', valuePath: 'displayName', expectedValue: 'disposable-updated',
  variants: ['text-plain', 'form', 'cors-json'], observeMs: 500,
}]
```

The same disposable-state rules apply as for form CSRF: anonymous state reads must be
refused, the logged-in initial value must differ from `expectedValue`, and fresh
records are needed for every run. The legitimate positive control runs last, inside
`appPath`, as a same-origin `fetch` with `application/json` and, when configured, the
app's CSRF header read in the page from a meta tag or a readable cookie. The token
value never leaves the browser.

Variants, from a synthetic cross-site page served locally:

- `text-plain`: the classic HTML form with `enctype="text/plain"` whose body is one
  JSON document (an extra `veriq_pad` field closes it). Detects endpoints that parse
  JSON regardless of `Content-Type`.
- `form`: a URL-encoded form POST with the same fields. Detects JSON endpoints that
  also accept form bodies.
- `cors-json`: Playwright request interception stops Chromium sending CORS preflights,
  so the server's preflight answer for the attacker origin is requested directly
  (without cookies). Only if it allows credentialed `application/json` for the method
  does the browser send the cross-site request. A refusal is a defense: nothing is sent.
  Methods other than POST can only use this variant.

Delivery is read from Chromium's network log, not inferred: the request must have
been sent and received a response (even one CORS hides from the page). Each cookie's
block reason is checked. SameSite, Secure and path reasons are application choices
and count as defenses. Other reasons (for example blocked third-party cookies)
make the result inconclusive, because the attack could not carry the session. A
request the browser never sends (for example Private Network Access from the public
attacker page to a loopback or private-network target) is inconclusive with the
browser's reason. For local targets, run against a staging host on a public address
or accept that `cors-json` cannot be evaluated there.

The Node-side preflight request verifies TLS. `QA_PROBE_CA_FILE` may name one PEM file
that is trusted in addition to the system roots, for example a disposable staging CA.

Not covered: bearer-token-only APIs (no ambient credentials, so classic CSRF does not
apply), WebSocket handshakes, GraphQL-specific encodings, same-site subdomain
attackers and effects after the observation window. Cookie-less bearer-only APIs require another workflow.
No automatic cleanup/reset is inferred. Fresh records are required for every run.

## Sources for adapter contracts

- [Zod 4 migration guide](https://zod.dev/v4/changelog)
- [Trivy SARIF reporting](https://trivy.dev/docs/v0.59/configuration/reporting/)
- [CycloneDX specification](https://cyclonedx.org/specification/overview/)
- [MobSF API](https://mobsf.live/api_docs)
- [k6 custom summary](https://grafana.com/docs/k6/latest/results-output/end-of-test/custom-summary/)
- [AWS SDK S3 presigner](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/)

## Explicit password-policy workflow

`password-policy` tests the server-side password rules of an account-creating
endpoint (registration, or an authenticated admin "create user" route):

```ts
pluginSettings: {
  'password-policy': {
    cases: [{
      path: '/auth/register',
      body: { email: '{{unique}}@qa.example.test', password: '{{password}}', confirmPassword: '{{password}}' },
      minLength: 12,
      checks: ['length', 'common', 'identifier', 'long'],
      rejectionStatuses: [400, 422],
    }],
  },
}
```

Both disposable flags are required, because every submission creates a user. The body
is a flat JSON object of up to 20 string fields. At least one field must be exactly
`{{password}}`; a field must contain `{{unique}}`, which is replaced with a fresh
random value per submission so no existing account is changed. No other placeholders
are accepted. `account` (optional) authenticates an admin create-user route. All
cases, accounts and candidate sets are preflighted before the first request.

The sequence per case is:

1. Positive control: a random password with upper, lower, digit and symbol, of length
   `max(minLength + 4, 16)` (capped at 64), must get one of `acceptedStatuses`
   (default 200/201/204). Otherwise the check errors.
2. `length`: a password one character shorter than `minLength` must be refused.
3. `common`: each well-known password (built-in list, or `commonPasswords`) that is at
   least `minLength` long must be refused. If no candidate meets `minLength`, the
   case errors before any request, since it would only re-test length.
4. `identifier`: a password equal to the generated identifier must be refused.
5. `long` (opt-in): a strong 64-character passphrase must be accepted.

"Refused" means one of `rejectionStatuses` (default 400/422; 401/403/404/405/408/409/429
are not accepted there). Any other answer, including redirects, 401/403, 409, 429
and 5xx, errors the check at the first occurrence, without retries. Findings use
CWE-521; passwords, identifiers and response bodies are never included in results.

Limitations: this tests the configured endpoint and candidates only. It does not
check breached-password APIs, password change/reset routes, login lockout (see
`rate-limit`), hashing or storage, client-side rules, or policies that differ by
role. Created QA users remain in the disposable environment.
