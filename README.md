# MLITech QA Agent

> **Platform (Phase A):** this folder now also holds the QA platform. `apps/api` is the
> multi-tenant control-plane API (organizations, clients, projects, environments,
> credentials vault, runs, issues). See [apps/api/README.md](apps/api/README.md).
> The engine below uploads runs to it with `--upload`.

A plugin-first QA agent for the MLITech backend. It finds the routes in the
source code, decides which checks to run, runs them against a live API, triages
the results and posts one report with a pass/fail gate.

**It makes zero LLM calls.** Every check uses a deterministic tool or rule, so a
run costs CI minutes only, however many routes or runs per day.

```
discover routes (TS AST) → select by git diff → run plugins → triage → report + gate
```

## What it checks (18 plugins)

| Plugin | Type | What it catches |
|---|---|---|
| `route-auth` | static | Routes without `auth()` that are not on the public allowlist, privileged routes without roles, routes with no handler, routes shadowed by an earlier `/:param` route, duplicates |
| `env-drift` | static | Env vars the code reads but `.env.example` doesn't document, and likely name mismatches (`DATABASE_URL` vs `MONGODB_URI`) |
| `secrets` | static | Committed `.env` files and hard-coded keys (uses `gitleaks` if installed, built-in rules otherwise) |
| `deps` | static | `npm audit` on the backend lockfile |
| `health-cors` | live | Health check, security headers, CORS rejects unknown origins and allows the dashboards |
| `api-auth` | live | Every protected route returns 401 without a token or with a bad token, and 403 for a disallowed role. Confirms unprotected routes live |
| `api-smoke` | live | Every parameter-free GET with the right role: no 5xx, not slow |
| `tenant-isolation` | live | Merchant B cannot read (or, on the CI database, edit) merchant A's records |
| `api-fuzz` | live | Schemathesis property-based fuzzing from an OpenAPI spec generated from the routes + zod schemas |
| `socket-fanout` | live | Socket.IO: connections without a token or with a tampered token are refused; a logged-in user connects on every instance; an event reaches the user's sockets on every instance (shared adapter, e.g. Redis); another tenant's socket doesn't receive it (`io.emit` to everyone); the per-user connection cap holds |
| `load-smoke` | live | A short burst of concurrent GETs (capped at `load.maxRps`, built in, no k6 needed): error rate, p95 latency, response times that grow under load; 429s from the rate limiter are reported separately |
| `zap-baseline` | live | Passive security scan of the API and dashboards: OWASP ZAP baseline when installed (or in Docker), otherwise built-in rules: readable `.env`/`.git`/dumps, stack traces and database errors in error responses, login cookies without Secure/HttpOnly/SameSite, version numbers in `Server`, dashboard security headers and public source maps, HTTP not redirecting to HTTPS, directory listings |
| `web-crawl` | dashboard | Logs in to the admin and business dashboards and visits every reachable page: uncaught JS errors, console errors, failed API calls (5xx, 401 after login, CORS blocks), broken assets, blank pages, pages that bounce back to login, slow pages |
| `web-a11y` | dashboard | axe-core WCAG 2 A/AA on every crawled page, grouped per rule |
| `lighthouse` | dashboard | Lighthouse (desktop) on key dashboard pages after logging in: performance score, LCP, TBT, layout shift, best practices, with the biggest savings and an HTML report per page |
| `flows` | dashboard | Scripted business flows (create a promotion, redeem a reward) from `qa-flows/*.ts`, logged in, in a real browser: the step that failed, a screenshot, server and console errors during the flow; flows that change data run only with `allowMutations` |
| `mobile` | mobile | Maestro flows (`qa-mobile/*.yaml`) on a device or emulator for the Flutter apps: each failed flow with Maestro's message and screenshot; account logins reach the flows as variables. Skipped when Maestro or a device isn't available |
| `web-visual` | dashboard | Screenshot of every page compared with an approved baseline (pixel diff image in the report) |

## Quick start (local)

```bash
npm ci
cp .env.qa.example .env.qa              # fill in staging URL + QA account credentials
npm run -s qa -- discover               # writes qa-out/routes.json + qa-out/openapi.json
npm run -s qa -- run --suite local      # static + live checks
open qa-out/report.html
```

Useful flags:

| Flag | Meaning |
|---|---|
| `--suite pr\|staging\|nightly\|local` | Which plugin list from `qa.config.ts` to run |
| `--only api-auth,tenant-isolation` | Run specific plugins |
| `--changed-from origin/main` | Test only routes in modules the diff touches (global files select everything) |
| `--base-url`, `--backend-dir` | Override `QA_BASE_URL` / `QA_BACKEND_DIR` |
| `--baseline` | Record every current finding as known (first adoption, see below) |
| `-v` | Debug logging |
| `--upload` | Send the run to the QA platform (`QA_PLATFORM_URL`, `QA_PLATFORM_API_KEY`, optional `QA_PLATFORM_ENV` or `--platform-env`) |

Exit codes: `0` gate passed · `1` gate failed · `2` config or usage error · `3` target unreachable.

Login body: by default the agent posts `{ identifier, password, device }` to `login.path`.
For other APIs set `login.bodyTemplate`, e.g. `{ email: "{{identifier}}", password: "{{password}}" }`.
Routes with ids: set `target.pathParams` (e.g. `{ orgId: "…" }`) so live checks and the smoke test
use real ids instead of a non-existent one.

## GitHub Action (any repository)

This repository is also a GitHub Action. In any backend repo:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: your-org/qa-agent@v1
  with:
    suite: pr
    platform-url: https://qa.example.com
    platform-api-key: ${{ secrets.QA_PLATFORM_API_KEY }}
```

On a pull request it tests only the routes the PR touches, posts one PR comment that
updates on every push, puts annotations on the changed lines, sets a **QA gate** commit
status linking to the run on the platform, and fails the job when the gate fails. After a
staging deploy (`after-deploy: true`, `wait-for-deploy: true`, `base-url: …`) it waits for
the new build, reports the deployment and links the run to it. With `platform-accounts: true`
the test-account logins come from the platform's vault instead of CI secrets.

The workflow needs `permissions: { contents: read, pull-requests: write, statuses: write }`.
All inputs and outputs are in `action.yml`; a complete workflow is in
`workflows/qa-platform.example.yml`, and the dashboard's **CI setup** tab generates it with
your project's IDs plus a starter `qa.config.ts` (a plain object, no imports needed).
For a private action repository, allow access under its Settings → Actions → General →
Access. `npm run test:action` tests the action end to end against fake GitHub and platform APIs.

## Hosted runs and schedules

The platform can also run the checks itself: **Run now** on a project's Runs tab, or a
**Schedule** (every night, weekdays at 09:00, every 6 hours…, in your time zone). A
hosted runner (`apps/runner`) tests the deployed environment from the project profile
that CI uploads, with the test accounts stored on the platform. It only tests domains
you've verified, never runs two jobs on one environment at once, sends write requests
only to environments marked disposable, and keeps to 120 requests a minute. See
`apps/runner/README.md`.

## Notifications and client reports

**Notifications** (organization → Notifications): Slack, email or a signed webhook when a
gate fails, passes again, a fixed issue comes back, the environment is unreachable or a
hosted run couldn't run, per project. Every channel has a "Send test" button and a
message history with retries. **Reports** (organization → Reports): pass rate, runs per
day, open/fixed/returned issues for a client or a project over any period; download as
PDF (print layout), export issues as CSV, or send the client an expiring share link that
opens without an account and contains no request details.

## Running the platform on a server

`deploy/` has everything for one server with Docker Compose: PostgreSQL, the API, the
dashboard behind nginx, automatic HTTPS with Caddy, and the optional hosted runner.
Accounts are invite-only by default (`SIGNUP_MODE`). See [`deploy/README.md`](deploy/README.md)
for setup, backups and upgrades.

## Setting it up in CI (MLITech backend)

**With the platform (recommended):** follow [`integrations/mlitech/README.md`](integrations/mlitech/README.md).
It adds `qa.config.ts` and `.github/workflows/qa.yml` to the backend repo; test-account
passwords stay on the platform and every run shows up in the dashboard.

**Without the platform** (reports as workflow artifacts only):

1. **Push this folder as its own repo**, e.g. `tmhdigital/qa-agent`. Its own workflow
   (`.github/workflows/selftest.yml`) checks that the agent still catches every planted
   bug in `test/fixture-api`.
2. **Create four QA accounts on staging** through the normal app flows: two merchants
   (two separate businesses), one customer, one admin. Use them for nothing else:
   the backend keeps one session per user, so a person using these accounts gets
   logged out on every agent run.
3. **Add repo settings to `Loyalty-Backend-Code`** (Settings → Secrets and variables → Actions):
   - Variables: `QA_AGENT_REPO`, `QA_STAGING_URL`, `QA_CORS_ORIGINS`, and for dashboards
     `QA_ADMIN_WEB_URL`, `QA_BUSINESS_WEB_URL` (optional `QA_ADMIN_WEB_LOGIN`, `QA_BUSINESS_WEB_LOGIN`)
   - Secrets: `QA_MERCHANT_A_ID/PASS`, `QA_MERCHANT_B_ID/PASS`, `QA_CUSTOMER_ID/PASS`, `QA_ADMIN_ID/PASS`,
     and `QA_AGENT_TOKEN` (read-only PAT) if the qa-agent repo is private
4. **Copy `workflows/backend-qa-agent.yml`** to `Loyalty-Backend-Code/.github/workflows/qa-agent.yml`.
   Change `branches: [staging]` under `push` if Render deploys staging from another branch.
5. **Make it required**: once the baseline is in (next section), add the `pr` job as a
   required check in the branch protection rule for `main`.

What each trigger does:

- **Pull request:** builds the PR's backend, starts MongoDB (single-node replica set,
  needed for transactions) and Redis, seeds QA data with `seed/seed-ci.ts`, boots the API
  and runs the `pr` suite on the routes the PR touches. Mutating checks are allowed
  because the database is thrown away. The result is posted as a single PR comment that
  updates on every push.
- **Push to staging:** waits until Render serves the new build (`wait-for --fresh`
  compares the process uptime), then runs the `staging` suite (API checks + dashboard
  crawl). It sends read-only requests with real tokens.
- **Nightly (02:41 PKT):** the full suite against staging, including fuzzing, load smoke,
  the passive security scan (full OWASP ZAP in Docker), Lighthouse, business flows,
  accessibility and visual diffs.

## Dashboards (Phase 2)

The three `web-*` plugins share **one** browser crawl per dashboard per run:

1. Open `<url><loginPath>` and log in through the real form with the configured
   account (admin dashboard → `admin`, business dashboard → `merchantA`). Fields are
   auto-detected; set `web.apps[].selectors` if the form is unusual.
2. Visit the seed routes, every same-origin link found on each page, and (if
   `QA_ADMIN_WEB_DIR` / `QA_BUSINESS_WEB_DIR` point to a checkout of the dashboard
   repo) every absolute path in its React Router config.
3. Per page: collect errors, run axe, take a full-page screenshot.

The crawl is **read-only**: it follows links, never clicks buttons or submits forms
after login, and skips logout/delete paths (`excludePaths`). It caps at `maxPages`
per dashboard and groups `/promotions/<id>` pages as `/promotions/:id`.

Web plugins always run after the API plugins, because a dashboard login starts a
new session and invalidates that account's API token.

**Setup:** set the repo variables `QA_ADMIN_WEB_URL` and `QA_BUSINESS_WEB_URL`
(staging dashboard URLs), plus `QA_ADMIN_WEB_LOGIN` / `QA_BUSINESS_WEB_LOGIN` if the
login page isn't `/login`. Locally, put the same names in `.env.qa` and run
`npx playwright install chromium` once. If that download is blocked on your network,
point `QA_CHROMIUM_PATH` at an installed Chrome or Chromium instead (and add
`QA_CHROMIUM_ARGS=--no-sandbox` inside containers).

**Visual baselines:** run the workflow manually with *update_visual* ticked. It
uploads a `visual-baselines` artifact; review the screenshots, then commit the
folder into this repo as `visual-baselines/`. Baselines must come from CI (same
OS, fonts and browser), not from a laptop. Staging numbers and charts change daily,
so mask them: `canvas`, `time` and any element with `data-qa-mask` are hidden in
screenshots by default (`web.visual.mask`).

## Adopting on an existing codebase: the baseline

The first run on the current backend reports many existing issues. To start
gating new problems straight away without blocking every PR on old ones:

```bash
npm run -s qa -- run --suite nightly --baseline
git add known-issues.json && git commit -m "QA baseline"
```

Every finding gets a stable fingerprint (plugin + normalised title + route), so the
same bug keeps its fingerprint across runs. Baselined issues still appear in reports,
marked **known**, but don't fail the gate. Remove an entry when it is fixed, or add
`"until": "2026-12-31"` to make an accepted issue block again after a date.

Fix the critical findings before you baseline. Don't baseline them.

## Configuration (`qa.config.ts`)

- `publicRoutes`: routes that are meant to work without a token, as `"METHOD /path"` (globs allowed, e.g. `"GET /rules/*"`).
  Anything else without `auth()` is reported.
- `privilegedPrefixes`: route prefixes that must declare roles in `auth(...)`.
- `tenantIsolation.sharedResources`: detail routes that are intentionally readable
  across merchants. Add one only after confirming it is meant to be shared.
- `tenantIsolation.pairs`: extra list → detail pairs the auto-matcher can't infer
  (it pairs `GET /x` with `GET /x/:id` automatically).
- `globalPaths`: files whose change means "test every route".
- `suites`: which plugins run in which trigger.
- `gate.failOn`: lowest severity that fails the gate (default `high`).
- `backend: false`: a project without backend source (only dashboards or mobile apps); the source checks are skipped.
- `socket`, `load`, `zap`, `lighthouse`, `flows`, `mobile`: settings of those plugins (see the comments in `src/core/config.ts` and `integrations/mlitech/qa.config.ts`).

## Safety rules built in

- Unauthenticated write requests are never sent to a live system. Static analysis
  reports those routes instead.
- Write requests with tokens only happen when `allowMutations` is on, which only the
  PR job enables on its throwaway database.
- Path params are filled with a non-existent ObjectId (`000…0`) unless the test
  collected a real id from the owner's own list.
- Requests are throttled under the backend limiter (120/min/IP); 429s are retried
  after `Retry-After`.
- The fuzzer skips `/auth/`, logout, delete, webhooks and payment callbacks.
- `seed/seed-ci.ts` refuses to run against any non-local MongoDB host.
- Tokens are redacted in every report (`Bearer $QA_TOKEN_MERCHANTB`).
- The dashboard crawler only follows links; it never clicks buttons or submits
  forms after login, and skips logout/delete paths.

## Adding a plugin

1. Create `src/plugins/<name>.ts` that exports a `QaPlugin` (`name`, `layer`, `needs`, `run(ctx)` returning `Finding[]`).
2. Register it in `src/plugins/index.ts`.
3. Add it to a suite in `qa.config.ts`.
4. Add a planted bug to `test/fixture-api` and an expectation to `test/selftest.ts`.

`ctx` gives you the discovered routes, the routes selected for this run, a throttled
HTTP client (`ctx.http`), logged-in tokens per account (`ctx.auth`) and the config.

## Self-test

```bash
npx playwright install chromium     # once
npm run selftest                    # fixture API + dashboard + all non-fuzz plugins
SELFTEST_FUZZ=1 npm run selftest    # include Schemathesis (needs schemathesis or uvx)
SELFTEST_PART=main npm run selftest # only the detection checks (SELFTEST_PART=visual: only the baseline cycle)
npm run test:action                 # the GitHub Action, end to end (ACTIONLINT=/path/to/actionlint also lints generated workflows)
npm run runner:test                 # hosted runner end to end against the fixture API
npm run test:all                    # everything: engine, action, platform API, runner, dashboard browser tests
```

## Roadmap (next phases)

- Dashboard checks on every dashboard PR, using Cloudflare Pages preview deployments
- More recorded business flows per dashboard, and Maestro flows once the Flutter widgets have `Semantics` labels
