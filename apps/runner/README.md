# Hosted runner

Runs QA checks for customers without their CI: it claims jobs from the platform
("Run now" and schedules), runs the QA engine against the customer's **verified**
environment and reports the run back. It never has the customer's source code.

## How a hosted run works

1. A CI run with `--upload` sends the platform a **project profile**: the route list
   read from source plus the non-secret parts of `qa.config.ts` (login path, public
   routes, tenant-isolation pairs…). No logins, no source files.
2. Someone clicks **Run now** or a schedule comes due: the platform queues a job.
3. A runner claims it. The platform only hands out jobs whose environment's domain
   is verified, and never two running jobs for one environment (test accounts
   usually allow one session at a time).
4. The runner writes an engine config to a throwaway folder (test-account logins go
   only into the engine's environment variables, never to disk), runs the engine with
   `--routes-file`, sends a heartbeat every 15 s and stops the engine when the user
   cancels. Write requests are allowed only on environments marked *disposable*;
   the request rate is capped at 120/min.
5. The run is stored like any upload (`source: hosted`), so issues, fixes and
   regressions are tracked the same way.

Checks per suite: **staging** = health/CORS, API auth and roles, smoke, tenant
isolation, dashboard crawl · **nightly** = staging + dashboard accessibility. API
checks need a profile and an API URL; dashboard checks need dashboards on the
environment.

## Run it

```bash
# on the API: RUNNER_TOKEN=<32+ random chars>
QA_PLATFORM_URL=https://qa.example.com QA_RUNNER_TOKEN=<same token> npm run runner:start
```

| Variable | Default | |
|---|---|---|
| `QA_PLATFORM_URL` | – | platform API URL |
| `QA_RUNNER_TOKEN` | – | the API's `RUNNER_TOKEN` |
| `QA_RUNNER_ID` | `host-pid` | shown on jobs and in the audit log |
| `QA_RUNNER_POLL_MS` | `5000` | wait between empty polls |
| `QA_JOB_TIMEOUT_MIN` | `20` | engine is stopped after this |
| `QA_RUNNER_WORKDIR` | OS temp | job folders (deleted after each job) |
| `QA_CHROMIUM_PATH`, `QA_CHROMIUM_ARGS` | – | browser for dashboard checks (or `npx playwright install chromium`) |

One runner process runs one job at a time; start more processes or machines for
parallel jobs. A runner that dies mid-job is detected by missing heartbeats
(`JOB_STALE_SECONDS` on the API): the job is retried once, then marked failed.

## Tests

```bash
npm run runner:test   # fixture API as "staging": CI upload → Run now → runner → issues; cancel; config rules
```
