# MLITech on the QA platform

Files in this folder go into **tmhdigital/loyalty-backend-code**:

| File here | Goes to | What it does |
|---|---|---|
| `qa.config.ts` | `qa.config.ts` (repo root) | What to check: routes, accounts, public routes, admin prefixes, suites |
| `qa-scenarios/` | `qa-scenarios/` | Business API scenarios: promotion lifecycle and rules, checkout points, expired promotions, sign-up and verification, access rules (tags `smoke`, `regression`, `uat`, `security`) |
| `qa-db-checks/` | `qa-db-checks/` | Read-only data-integrity rules for MongoDB (promotion dates and discounts, point balances, orphaned records, duplicate emails) |
| `qa-flows/` | `qa-flows/` | Business flows through the dashboards (rename an `.example` file to turn it on) |
| `qa-mobile/` | `qa-mobile/` | Maestro flows for the customer app (rename the `.example`; needs a device or emulator and Semantics labels in the Flutter widgets) |
| `qa.yml` | `.github/workflows/qa.yml` | PR checks on a throwaway backend, checks after every staging deploy, nightly full run |

Setup takes about 30 minutes once the platform is running.

## 1. Platform (once)

1. Deploy the platform: [`deploy/README.md`](../../deploy/README.md). Say it ends up at `https://qa.mlitech.com`.
2. Sign up first: that account owns the platform. Organization name: **MLITech**. Everyone else joins by invite (**Members → Invite**).

## 2. Project and staging environment

1. **Projects → New project**: name `MLITech backend`, stack *Node / Express*, repository `https://github.com/tmhdigital/loyalty-backend-code`.
2. **Environments → Add environment**: name `staging`, API base URL = the staging backend, e.g. `https://rewaldo-staging.onrender.com`. Add the two staging dashboards (admin, business) as web apps if you want them crawled.
3. **Verify the domain** (shown on the environment): add the DNS TXT record, or serve the file it names. Hosted runs and schedules only test verified domains. On a `*.onrender.com` address use the file method.
4. **Test accounts**: create four dedicated staging accounts through the normal app flows (never used by people: the backend keeps one session per user, so a person would be logged out by every run), then add them on the environment with exactly these names:

   | Name | Role |
   |---|---|
   | `merchantA` | MERCHANT |
   | `merchantB` | MERCHANT (a different business) |
   | `customer` | USER |
   | `admin` | SUPER_ADMIN |

   Their passwords are encrypted on the platform; CI fetches them per run, so they never go into GitHub.

5. Copy the environment's **ID** (Environments tab) for step 4.

## 3. API key

**Project → API keys → New key**: name `loyalty-backend CI`, tick **Read test accounts**. Copy it now; it's shown once.

## 4. GitHub (loyalty-backend-code → Settings → Secrets and variables → Actions)

| Kind | Name | Value |
|---|---|---|
| Secret | `QA_PLATFORM_API_KEY` | the key from step 3 |
| Secret | `QA_AGENT_TOKEN` | fine-grained token with read access to `tmhdigital/qa-agent` (only while that repo is private) |
| Variable | `QA_PLATFORM_URL` | the platform's API address: `https://qa.mlitech.com` with the one-server setup, `https://api.qa.mlitech.com` when the dashboard is on Cloudflare Pages |
| Variable | `QA_PLATFORM_ENV` | the staging environment ID |
| Variable | `QA_STAGING_URL` | the staging backend URL |
| Variable | `QA_CORS_ORIGINS` | staging dashboard origins, comma-separated |
| Variable | `QA_ADMIN_WEB_URL`, `QA_BUSINESS_WEB_URL` | staging dashboards (optional) |

The qa-agent repository needs a `v1` tag (`git tag v1 && git push --tags`), or change `QA_AGENT_REF` in `qa.yml`.

## 5. Add the files and start with a baseline

Add `qa.config.ts` and `.github/workflows/qa.yml` on a branch and open a PR. The first run reports the issues the backend already has. On the current `main` the static checks alone find:

- **4 env names that differ** between the code and `.env.example` (code reads `DATABASE_URL`, `.env.example` documents `MONGODB_URI`; likewise `JWT_REFRESH_EXPIRES_IN`, `STRIPE_API_SECRET`, `WEBHOOK_SECRET`) and 2 required variables missing from it (`SESSION_SECRET`, `ENCRYPTION_KEY`). A server set up from `.env.example` does not start: `validateEnv()` stops it. Fixing `.env.example` takes minutes.
- **`npm ci` fails** because `package-lock.json` is out of sync with `package.json`. The PR job builds the backend with `npm ci`, so run `npm install` once and commit the lockfile first.
- **Vulnerable dependencies**, one critical (`proxy-addr`); most have a fix through `npm audit fix`.
- 4 critical routes without `auth()` (`POST /user/create-admin` and three report exports) and more that aren't in the public list (review each: add `auth(...)` or add it to `publicRoutes` in `qa.config.ts`).
- **Unique email and phone indexes that MongoDB never builds**: `user.model.ts` uses `$ne` in their `partialFilterExpression`, which MongoDB refuses; Mongoose only logs it, so duplicate emails and phones are not prevented by the database.

Run against this backend locally on a throwaway MongoDB 8.3 replica set (19 November 2026), the PR suite also found, live: another merchant can change or delete a merchant's promotion, a customer can open merchant-management routes, sign-up accepts `verified`, `subscription` and points from the request body, an expired promotion is applied at checkout, promotions accept an end before the start, a discount above 100% and a negative value, the `salesActivation` event reaches every connected user, and several business errors return 500 instead of a client error.

Fix what's quick, then accept the rest so only **new** problems block PRs:

```bash
# in loyalty-backend-code, with tmhdigital/qa-agent checked out next to it
node ../qa-agent/bin/qa.mjs run -c qa.config.ts --suite pr --baseline
git add qa-known-issues.json && git commit -m "QA baseline"
```

Accepted issues still show on the platform as known. Don't accept critical ones.

## Business scenarios and data checks

`qa-scenarios/` holds API scenarios written against this backend's code. On the PR job's
throwaway database (`QA_ALLOW_MUTATIONS`, `QA_DISPOSABLE` and `QA_DB_URL` are set in
`qa.yml`) all of them run: they create promotions, tiers, cards, sales and sign-ups, check
the answers and what was stored, and clean up. On staging only the read-only ones run
(role home data, access rules). Sign-ups use `.invalid` email addresses and `+999` phone
numbers, which cannot reach a real person.

`scenario-lint` (in the PR suite) checks these files against the backend's routes on
every PR without calling the API: a renamed route, a removed field or a role change shows
up as "Scenario does not match the backend" instead of a confusing failure later.

`qa-db-checks/` runs only when `QA_DB_URL` is set; give it a read-only user on staging to
check real data nightly.

Run them against a local backend:

```bash
QA_BASE_URL=http://localhost:5004 QA_ALLOW_MUTATIONS=true QA_DISPOSABLE=true QA_DB_URL=mongodb://localhost:27017/mlitech_qa \
  node ../qa-agent/bin/qa.mjs run -c qa.config.ts --only api-scenarios,db-checks
```

A failing scenario names the step, the request and what was expected. Some scenarios
encode business rules the code does not enforce yet (a discount above 100%, a promotion
that ends before it starts, an expired promotion at checkout); confirm each rule with the
product owner, then fix the code, or change the scenario if the rule is different.

## 6. Make it count

- **Branch protection** on `main`: require the `pr` job (and the **QA gate** status).
- **Notifications** (organization → Notifications): a Slack channel for *gate failed*, *issue came back* and *environment unreachable*.
- **Schedules** (project → Schedules) if you also run the hosted runner; otherwise the nightly GitHub schedule in `qa.yml` covers it.
- **Reports**: monthly client report or share link from organization → Reports.

## What each trigger does

- **Pull request**: builds the PR's backend, starts MongoDB (single-node replica set, for transactions) and Redis, seeds the four QA accounts with `seed/seed-ci.ts`, boots the API and tests the routes the PR touches, including write requests (the database is thrown away). One comment on the PR that updates on every push, a **QA gate** status, and the run on the platform.
- **Push to `staging`**: waits until Render serves the new build, records the deployment on the platform, then tests staging read-only with the accounts from the platform.
- **Nightly (02:41 PKT)**: everything, including fuzzing and the dashboard crawl, accessibility and visual checks.
