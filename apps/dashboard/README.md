# QA Platform dashboard

React web app for the QA platform: organizations, clients, projects, environments
(with domain verification and test accounts), API keys, runs, issue triage,
members and invites, audit log.

## Run it locally

```bash
npm install                       # from the repo root
npm run api:dev                   # API on :4100 (needs apps/api/.env, see apps/api/README.md)
npm run dashboard:dev             # dashboard on http://localhost:5173
```

The dashboard calls the API on the same origin (`/api/...`). Vite forwards those
calls to `VITE_API_PROXY` (default `http://127.0.0.1:4100`). In production, serve
`dist/` and the API behind one domain, or set `CORS_ORIGINS` on the API.

## Tests

```bash
npm run dashboard:build
npm run dashboard:e2e             # 31 browser tests: every screen and action, plus accessibility
npm run dashboard:dogfood         # the QA engine crawls the dashboard (broken pages, console errors, a11y)
SCREENSHOTS=1 npm run e2e -w @qa/dashboard -- screens   # desktop + phone screenshots in e2e-results/screens
```

The E2E tests start their own API on an in-memory database (port 4111) and a
`vite preview` (port 4174). Use another Chromium with
`QA_CHROMIUM_PATH=/path/to/chrome` and extra flags with `QA_CHROMIUM_ARGS`. Don't pass `--single-process`: that Chromium mode can't open the second
browser window the invite and role tests need.
