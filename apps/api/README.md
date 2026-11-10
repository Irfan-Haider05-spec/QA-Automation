# QA platform API (`apps/api`)

The control-plane API for the QA platform: accounts, organizations, clients,
projects, environments, an encrypted credentials vault, project API keys,
run uploads from the engine, an issues inbox and an audit log.

Express + TypeScript + PostgreSQL. Tests and local development can run on
**embedded PostgreSQL (PGlite)**, so no database install is needed to start.

## Run it

From the repo root (`qa-agent/`):

```bash
npm install                     # installs the engine, apps/api and packages/shared (npm workspaces)
npm run api:test                # integration tests on in-memory Postgres
npm run dogfood -w @qa/api      # the QA engine tests this API and uploads the result to it
```

Start a local server (data kept in `apps/api/.data/`):

```bash
# PowerShell
$env:JWT_SECRET = "<64 random hex chars>"
$env:VAULT_MASTER_KEY = "<32 random bytes, base64>"
npm run api:dev
```

```bash
# bash
export JWT_SECRET=$(openssl rand -hex 32)
export VAULT_MASTER_KEY=$(openssl rand -base64 32)
npm run api:dev
```

The API listens on `http://localhost:4100`; `GET /health` should answer `{"ok":true}`.

To generate the two secrets without openssl:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

### With a real PostgreSQL

```bash
cd apps/api && docker compose up -d
```

then set:

```
DATABASE_URL=postgres://qa_app:qa_app_dev_only@localhost:5432/qa_platform
MIGRATION_DATABASE_URL=postgres://qa_owner:qa_owner_dev_only@localhost:5432/qa_platform
```

and run `npm run api:migrate` before `npm run api:dev`.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `JWT_SECRET` | yes | – | ≥ 32 chars, signs access tokens |
| `VAULT_MASTER_KEY` | yes | – | 32 random bytes, base64; encrypts test-account secrets |
| `DATABASE_URL` | – | `pglite://./.data/pg` | `postgres://…` (the `qa_app` role), `pglite://<folder>` or `pglite://memory` |
| `MIGRATION_DATABASE_URL` | prod | `DATABASE_URL` | schema-owner connection used only by `npm run api:migrate` |
| `NODE_ENV` | – | `development` | `production` refuses PGlite and auto-migration |
| `PORT` | – | `4100` | |
| `CORS_ORIGINS` | – | `http://localhost:5173` | comma-separated dashboard origins |
| `ACCESS_TOKEN_TTL` | – | `15m` | access token lifetime |
| `REFRESH_TOKEN_DAYS` | – | `30` | refresh token lifetime |
| `ALLOW_HTTP_VERIFICATION` | – | `false` | allow `http://` domain verification (dev only; refused in production) |
| `RATE_LIMIT_PER_MINUTE` / `AUTH_RATE_LIMIT_PER_MINUTE` | – | `300` / `20` | per client IP |
| `TRUST_PROXY` | – | `1` | proxies in front of the API in production (the Docker setup, Caddy → nginx → API, uses `2`); client IPs for rate limits come from `X-Forwarded-For` |
| `SIGNUP_MODE` | – | `open` | `invite`: only the first account can sign up freely, then only people with an invite link for their own email |
| `INVITE_TTL_DAYS` | – | `7` | |
| `RUNNER_TOKEN` | – | – | shared secret of the hosted runners (≥ 32 chars); unset = hosted runs off |
| `SCHEDULER_ENABLED` / `SCHEDULER_INTERVAL_MS` | – | `true` / `30000` | turns due schedules into jobs, retries jobs of silent runners |
| `JOB_STALE_SECONDS` | – | `180` | a running job without a heartbeat this long is retried once, then failed |
| `SCHEDULE_MIN_INTERVAL_MINUTES` | – | `60` | shortest allowed gap between two runs of a schedule |
| `SMTP_URL` / `MAIL_FROM` | – | – / `QA Platform <qa@localhost>` | outgoing mail for email notifications, e.g. `smtp://user:pass@smtp.example.com:587`; unset = email channels off |
| `NOTIFY_INTERVAL_MS` | – | `10000` | how often queued notifications are sent |
| `ALLOW_PRIVATE_WEBHOOKS` | – | `false` | allow webhooks/Slack to http or private addresses (dev/tests only; refused in production) |
| `LOG_FORMAT` | – | `json` in production, `off` in tests, `text` otherwise | request logs: `json`, `text` or `off` |
| `METRICS_TOKEN` | – | – | turns on `GET /metrics` (Prometheus), Bearer token ≥ 16 chars |
| `APP_URL` | – | – | public dashboard URL, e.g. `https://qa.example.com`; runs then return a `runUrl` used in PR comments and commit statuses |

Server deployment (Docker, HTTPS, backups): [`deploy/README.md`](../../deploy/README.md).

Keep these in your own `.env` file or your host's secret settings; never commit them.

## How customer data is kept apart

1. **API layer.** Every route declares `auth(...roles)`. For URLs with `:orgId`
   the caller must be a member (non-members get **404**, so org ids can't be
   probed), and their role must be allowed. Members limited to some clients
   only see those clients' projects.
2. **Database layer.** Each request runs in one transaction as role `qa_app`
   with `app.org_id` set. Postgres row-level security (`migrations/002_rls.sql`)
   then only returns and accepts rows of that org, even if a query forgets a
   filter. `test/isolation.test.ts` proves this with direct database queries.

Secrets: test-account passwords are envelope-encrypted (AES-256-GCM, a fresh
data key per secret, bound to its org and record) and never returned. API keys,
refresh tokens and invite tokens are stored as SHA-256 hashes; refresh tokens
rotate and reuse signs out every session.

## Roles

| Action | owner | admin | developer | viewer |
|---|:-:|:-:|:-:|:-:|
| See projects, runs, issues | ✓ | ✓ | ✓ | ✓ |
| Create/edit projects, environments, credentials, API keys; triage issues | ✓ | ✓ | ✓ | |
| Mark an environment disposable (write tests allowed) | ✓ | ✓ | | |
| Delete projects/environments, manage clients, members and invites, read the audit log | ✓ | ✓ | | |
| Make/remove owners, delete the organization | ✓ | | | |

## Endpoints (`/api/v1`)

| Area | Routes |
|---|---|
| Auth | `POST /auth/signup` (`inviteToken` when invite-only), `/auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me`, `GET /auth/options` (public: `signupOpen`, `emailVerification`), `POST /auth/forgot-password`, `/auth/reset-password`, `/auth/verify-email`, `/auth/resend-verification` |
| Orgs | `GET/POST /orgs`, `GET/PATCH/DELETE /orgs/:orgId` |
| Members | `GET /orgs/:orgId/members`, `PATCH/DELETE /orgs/:orgId/members/:userId` |
| Invites | `GET/POST /orgs/:orgId/invites`, `DELETE /orgs/:orgId/invites/:inviteId`, `POST /invites/accept` |
| Clients | `GET/POST /orgs/:orgId/clients`, `PATCH/DELETE …/clients/:clientId` |
| Projects | `GET/POST /orgs/:orgId/projects`, `GET/PATCH/DELETE …/projects/:projectId` |
| Environments | `GET/POST …/projects/:projectId/environments`, `PATCH/DELETE …/:environmentId`, `GET …/:environmentId/verification`, `POST …/:environmentId/verify` |
| Credentials | `GET/POST …/environments/:environmentId/credentials`, `PUT/DELETE …/:credentialId` |
| API keys | `GET/POST …/projects/:projectId/api-keys`, `DELETE …/:apiKeyId` |
| Runs | `GET …/projects/:projectId/runs`, `GET …/runs/:runId` (with trigger, git links and deployment) |
| Deployments | `GET …/projects/:projectId/deployments` (each with the result of the run that checked it) |
| Hosted runs | `GET …/projects/:projectId/hosted` (route list status + per-environment readiness), `GET/POST …/jobs`, `POST …/jobs/:jobId/cancel` |
| Schedules | `GET/POST …/projects/:projectId/schedules`, `PATCH/DELETE …/:scheduleId` |
| Notifications | `GET/POST /orgs/:orgId/notifications`, `PATCH/DELETE …/:channelId`, `POST …/:channelId/test`, `GET …/:channelId/deliveries` |
| Reports | `GET /orgs/:orgId/reports?scope=project\|client&id=…&from=…&to=…`, `GET/POST /orgs/:orgId/report-shares`, `DELETE …/:shareId` |
| Public (no login) | `GET /public/reports/:token` (a shared report snapshot) |
| Hosted runner (`RUNNER_TOKEN` + `X-Runner-Id`) | `POST /hosted/jobs/claim`, `POST /hosted/jobs/:jobId/heartbeat`, `POST /hosted/jobs/:jobId/complete` |
| Issues | `GET …/projects/:projectId/issues?status=open`, `GET/PATCH …/issues/:issueId` |
| Audit | `GET /orgs/:orgId/audit` |
| Runner (project API key) | `POST /runner/runs`, `POST /runner/deployments`, `GET /runner/environments/:environmentId/credentials` (only keys with the `credentials:read` permission) |

## Sending runs from the engine

Create an API key for the project, then from the repo root:

```bash
QA_PLATFORM_URL=http://localhost:4100 QA_PLATFORM_API_KEY=qak_... npm run -s qa -- run --suite staging --upload
```

Add `--platform-env <environmentId>` to attach the run to an environment,
`--after-deploy` to report a deployment first and link the run to it, and
`--platform-accounts` to log in with the test accounts stored on the platform
(the key needs "can read test-account passwords", which only owners and admins can grant;
every hand-out is in the audit log by account name).
The platform turns findings into issues (one per fingerprint), marks issues
fixed only after a full-coverage run no longer finds them, and reopens fixed
issues that come back as regressions.

## Notifications

Channels (Slack incoming webhook, email, signed webhook) belong to an organization and
choose events (`run.failed`, `run.recovered`, `run.env_error`, `issue.regression`,
`job.error`) and projects. A stored run writes its messages to an outbox in the same
transaction; the dispatcher sends them and retries after 1, 5, 30 and 120 minutes, then
gives up (shown in the channel's message history). Slack/webhook URLs are vault-encrypted
and only a hint is ever returned. Webhook requests carry `X-QA-Event`, `X-QA-Delivery`,
`X-QA-Timestamp` and `X-QA-Signature: sha256=HMAC(secret, "{timestamp}.{body}")`.
Outgoing URLs must be https, resolve to public addresses, and redirects aren't followed.
Messages never include request/response evidence.

## Reports

`GET /reports` computes pass rate, runs per day, open issues by severity, new, fixed and
returned issues for a project or all projects of a client, over up to a year. A share
link freezes that report as a snapshot, valid 1-90 days, revocable, opened at
`/r/<token>` in the dashboard without an account. Only the token's hash is stored, and
expired, revoked and unknown links look the same (404).
