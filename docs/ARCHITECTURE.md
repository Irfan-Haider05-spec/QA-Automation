# VeriQ architecture and delivery status

## Components

| Location | Responsibility |
|---|---|
| `src/cli.ts` | Config, discovery, plugin selection, reports and CI/platform upload |
| `src/core/` | Shared contracts, HTTP/authentication, SDK validation, redaction, triage |
| `src/discovery/` | Express AST discovery and bounded OpenAPI/Postman imports |
| `src/plugins/` | Original checks and the 26 additions under `expanded/` |
| `src/web/` | Shared browser login/crawling; cached only within one run |
| `apps/api/` | Organization/project authorization, vault, jobs, runs, issues and artifacts |
| `apps/dashboard/` | React interface for configuration, findings, evidence and reports |
| `apps/runner/` | Claims verified-environment jobs and invokes the engine in a child process |
| `packages/shared/` | Validated wire contracts shared by platform, CLI and runner |

The CLI accepts trusted local TypeScript configuration. Local SDK/authentication
modules execute with the user's privileges. Hosted profiles remain restricted data;
they do not accept arbitrary modules or shell commands. A child process is not a
security sandbox: production worker isolation remains a deployment requirement.

## Execution and evidence

Discovery produces a route inventory. Selection can narrow it to changed routes.
Plugins declare prerequisites and return findings or an explicit skip/error.
Static checks run together; network checks share a throttled client; web checks run
after API checks to avoid invalidating single-session account tokens. Logout probes
run after other API checks.

Findings are schema-checked and redacted, then fingerprinted and triaged. Confirmed
transient smoke failures stay visible as flaky; writes are never silently repeated.
Selected plugin errors fail the gate. A passing gate only covers executed checks;
review skipped checks, route selection and configured cases before accepting a run.

The platform scopes runs/issues/artifacts to organizations and projects. It marks
issues fixed only after full route coverage by a check that actually ran. Flaky
findings do not open/reopen issues or erase previously confirmed findings.

CLI uploads store artifact metadata before contacting private object storage, then
mark successful uploads ready. Download links require project authorization and
expire after five minutes. Deletion retains tombstones until remote cleanup succeeds.
Cleanup avoids racing an upload in flight. Failed uploads remain visible as warnings;
retain local CI artifacts when cloud evidence delivery is incomplete.

## Delivery boundaries

Implemented in this change:

- All 26 plugin entries with checked configuration and bounded implementations;
  exact functionality and limitations are in `PLUGINS.md`.
- OpenAPI 3.0/3.1 and Postman 2.1 imports; original OpenAPI contracts are preserved.
- CLI bearer, cookie, API-key, OAuth2 client-credentials, OTP and trusted custom login.
- Versioned local SDK, finding metadata, redaction and safe smoke confirmation.
- Provider-neutral private evidence interface with an S3-compatible implementation,
  retention cleanup, CLI upload and authorized dashboard download.
- Supplied VeriQ logo/icon and navy/green theme.
- Platform TOTP MFA/recovery codes, session-version revocation and sign-out-everywhere;
  explicit OIDC identity linking with PKCE/state/nonce and no email-based linking.
- Configurable plans/quotas, usage, ordered signed subscription events and an
  optional payment bridge. Hosted usage includes failures, cancellations and retries.
- Restricted hosted profiles, six safe extra plugin settings, assignment-scoped
  evidence uploads and pending/complete/failed evidence state.
- Tenant-scoped comments with precise pagination, explicit issue snapshot delivery
  with retries, daily/plugin trends and CSV/JSON exports.
- Bounded worker settings, one-job mode and explicit browser sandbox configuration.
  The isolated-worker manifest is an unvalidated deployment example.

The current checkpoint is a local implementation, not the complete SaaS roadmap or
production certification. `REMAINING-WORK-PROMPT.md` scopes durable evidence recovery,
regional routing and proven isolation, recording, broader hosted authentication,
localization, concrete provider bridges, monitoring/error exports and distribution.
External-service acceptance, backup/restore drills, legal review and actual-project
validation remain separate. Real PostgreSQL test results are in `VALIDATION.md`.

External integrations remain optional and provider-neutral. No deployment, payment,
production credentials, third-party account connection or AI service was enabled.
