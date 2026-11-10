# Running the QA platform on a server

One server runs everything with Docker Compose:

```
Internet ──► caddy (HTTPS, Let's Encrypt) ──► dashboard (nginx: app + /api proxy) ──► api ──► postgres
                                                                                      ▲
                                                           runner (optional) ─────────┘
```

- **postgres**: the database. The API connects as `qa_app`, a role that can't change the schema, delete audit history, or see other organizations' rows (row-level security).
- **migrate**: runs once on every start, as the schema owner, then exits. The API refuses to start if a migration is missing.
- **api**: the platform API; also runs the scheduler and sends notifications.
- **dashboard**: nginx serving the built dashboard and forwarding `/api/` to the API on the same origin (no CORS).
- **caddy**: gets and renews the HTTPS certificate for your domain.
- **runner** (profile `hosted`): runs hosted checks and schedules. Leave it off if you only send runs from GitHub Actions.

Step-by-step setup with Supabase (database), an Oracle VM (API) and Cloudflare Pages (dashboard): [`SETUP-GUIDE.md`](SETUP-GUIDE.md).
Dashboard on Cloudflare Pages and API + PostgreSQL on your server: [`CLOUDFLARE.md`](CLOUDFLARE.md).

## What you need

- A Linux server with Docker and the Compose plugin. 2 CPU / 4 GB RAM is plenty for the platform; add 2 GB if the runner runs on the same machine (it starts Chromium). Oracle Cloud's free Ampere (ARM) VM works: every image used here has an ARM build.
- A domain or subdomain, e.g. `qa.mlitech.com`, with an **A record pointing at the server**.
- Ports 80 and 443 open (on the server firewall and, on Oracle/AWS, in the cloud security list).

## First start

```bash
git clone <this repository> qa-agent && cd qa-agent/deploy
cp .env.example .env
```

Fill in `.env`. Generate each secret separately:

```bash
openssl rand -base64 24 | tr -d '/+='   # POSTGRES_PASSWORD, QA_APP_PASSWORD
openssl rand -hex 32                     # JWT_SECRET, RUNNER_TOKEN
openssl rand -base64 32                  # VAULT_MASTER_KEY
```

> Keep a copy of `VAULT_MASTER_KEY` somewhere safe (a password manager). It encrypts the test-account passwords and webhook URLs stored in the database; a database backup without it can't decrypt them.

Then:

```bash
docker compose up -d --build
docker compose ps                 # migrate: exited (0); the rest: running / healthy
docker compose logs -f api        # "[api] listening on :4100 (pg)"
```

Open `https://<DOMAIN>` and **create your account straight away**. With `SIGNUP_MODE=invite` (the default) the first account can sign up freely; after that, new people need an invite from **Members**. Set `SIGNUP_MODE=open` only if you want a public sign-up page.

### Hosted runs and schedules

```bash
docker compose --profile hosted up -d --build
```

The runner logs `runner runner-1 polling http://api:4100`. To run jobs in parallel, start more copies with different `QA_RUNNER_ID`s (or on other machines pointing at `https://<DOMAIN>` with the same `RUNNER_TOKEN`).

### Email notifications

Set `SMTP_URL` (e.g. `smtp://user:password@smtp.sendgrid.net:587`) and `MAIL_FROM`, then `docker compose up -d api`. Without it, email channels can't be added; Slack and webhooks still work.

### Logs and metrics

- `docker compose logs -f api`: one JSON line per request (route, status, time, request id; no bodies, tokens or emails). Every response has an `X-Request-Id` header, and 500 errors show the id, so a user's report can be found in the log.
- Set `METRICS_TOKEN` to turn on Prometheus metrics at `http://api:4100/metrics` (inside the Docker network only; nginx doesn't expose it): requests and durations per route, hosted jobs and notification deliveries by status, organizations, accounts, runs in the last 24 hours, memory. Scrape it with `authorization: Bearer <METRICS_TOKEN>`.

### Forgotten passwords

With `SMTP_URL` set, people reset their own password from the login page and confirm their email address after signing up. Without it, the reset link is written to the API log (`docker compose logs api | grep "reset link"`) for you to pass on.

## Connecting a project (GitHub Actions)

1. In the dashboard: create a project, add the staging environment, verify the domain, add test accounts.
2. **Project → API keys**: create a key with *Send runs* (and *Read test accounts* if CI should use the accounts stored here).
3. In the GitHub repository: secret `QA_PLATFORM_KEY` = the key, variable `QA_PLATFORM_URL` = `https://<DOMAIN>`.
4. **Project → CI** shows the workflow file to add, filled in for that project.

## Backups

The database is the only state (plus `VAULT_MASTER_KEY` in `.env`). A nightly dump:

```bash
# /etc/cron.d/qa-backup
15 2 * * * root cd /root/qa-agent/deploy && docker compose exec -T postgres pg_dump -U qa_owner -Fc qa_platform > /var/backups/qa-$(date +\%F).dump && find /var/backups -name 'qa-*.dump' -mtime +14 -delete
```

Copy the dumps off the server too (object storage, another machine).

Restore into a fresh install (before anyone signs up):

```bash
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U qa_owner -d qa_platform --clean --if-exists < qa-2026-11-08.dump
docker compose up -d
```

## Upgrading

```bash
git pull
docker compose up -d --build      # migrate runs first; the API starts only on an up-to-date schema
docker image prune -f
```

Take a backup before upgrading. Migrations only move forward; to roll back, restore the backup taken before the upgrade and check out the previous version.

## Troubleshooting

| What you see | Why / what to do |
|---|---|
| `[api] Invalid configuration: …` | A value in `.env` is missing or too short; the message names it. |
| `[db] N migration(s) not applied` | The migrate service failed: `docker compose logs migrate`. |
| Browser warns about the certificate | DNS doesn't point at this server yet, or ports 80/443 are closed. `docker compose logs caddy`. |
| Everyone gets "Too many requests" together | Another proxy (e.g. Cloudflare) sits in front of Caddy: raise `TRUST_PROXY` in `docker-compose.yml` by one. |
| Hosted runs stay "Waiting" | The runner isn't started (`--profile hosted`), or its `RUNNER_TOKEN` differs from the API's. |
| Changing `POSTGRES_PASSWORD` / `QA_APP_PASSWORD` later has no effect | They're applied only when the database volume is first created. Change them inside Postgres (`alter role … password …`) and then in `.env`. |

## What was checked

These files are tested without Docker as well: the same migrations and roles on PostgreSQL 16, the nginx config (`nginx -t`) serving the built dashboard in front of the API, the API in production mode (startup checks, SSRF guard, rate limits per client behind two proxies), the image's production-only install (API, migrate and runner start from it), and the full browser test suite run through nginx against real PostgreSQL.
