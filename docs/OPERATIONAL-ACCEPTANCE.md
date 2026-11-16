# Operational acceptance

This is an acceptance checklist for the operator. Local automated tests do not
certify production services. Deployment, prices and external accounts remain
deferred at the user's request. AI integrations remain disabled.

## Identity

Configure one HTTPS OpenID Connect issuer, client ID/secret and fixed callback
`https://YOUR_DASHBOARD/sso/callback`. Link identities from an authenticated account;
email equality must never link accounts automatically. Verify an actual provider's
discovery, PKCE, nonce/state validation, rejected/replayed authorization codes,
unlinking, and MFA after SSO. Keep a tested recovery procedure for lost MFA devices.
Recovery codes are displayed once and are single-use.

## Plans and payment bridge

`BILLING_PLANS` is a JSON array of unique plans. The first plan is the fallback for
accounts without an active subscription; configure it intentionally. All prices
and commercial terms remain unset until the operator decides them. Each plan has
`id`, `name`, `projects`, `monthlyRuns`, `monthlyHostedMinutes`, `storageBytes`,
`retentionDays`, optional `priceLabel`, and `checkoutEnabled`. Null limits mean
unlimited. `priceLabel` is display text, never an amount to charge.

The payment bridge is optional. `BILLING_GATEWAY_URL`, `BILLING_GATEWAY_TOKEN`,
`BILLING_WEBHOOK_SECRET` and `APP_URL` must be configured before checkout. The bridge
maps a configured plan ID to its provider's price. It must authorize the organization
and preserve checkout request idempotency. VeriQ does not accept price amounts from
the browser. Test subscription expiry, cancellation, upgrades, duplicate/out-of-order
events and provider outages before allowing real charges.

The bridge posts subscription events to `/api/v1/billing/events`. Sign the exact
JSON bytes with HMAC-SHA256 over `${timestamp}.${body}` using the webhook secret;
send hex signature in `x-veriq-signature` and Unix seconds in `x-veriq-timestamp`.
Events contain `id`, `orgId`, monotonic per-organization `sequence`, `planId`,
`status`, `periodStart`, and `periodEnd`. The freshness window is five minutes.
An event ID must never be reused with a different payload.

## Issue bridge

Configure an operator-owned HTTPS `ISSUE_GATEWAY_URL` and `ISSUE_GATEWAY_TOKEN`.
The bridge receives a versioned issue snapshot, organization/project/issue IDs and
the project destination. The request's `idempotency-key` is stable across retries.
Use `(orgId, issueId)` as the remote issue identity and the delivery key to deduplicate
requests. Return JSON `{ "url": "https://your-tracker/issue/123" }` only after a
durable upsert. Map tenant destinations to authorized tracker repositories; never
interpret destination text as a shell command or arbitrary outbound URL.

Issue delivery is explicitly requested from the issue panel. It is a snapshot
export/upsert, not bidirectional tracker synchronization. Test ambiguous timeouts,
retries, revoked permissions, disabled integrations and repeated deliveries against
the chosen tracker. Do not send secrets in issue titles, targets or comments.

## Storage and database

Use a private S3-compatible bucket and a least-privilege service identity. Confirm
signed-link expiry, content disposition, retention, deletion retries and uploads
racing run deletion. An unavailable artifact store must remain visible as missing
evidence; it must not change a finding into a pass.

Run all API integration tests using `TEST_PG_ADMIN_URL`, `TEST_PG_OWNER` and
`TEST_PG_APP` against a disposable PostgreSQL service. The helper creates a fresh
database for each test file and uses `qa_app` for requests. Never point these
settings at customer databases. Test backups by restoring into an isolated database
and verifying migrations, tenant isolation, encrypted credentials and artifact keys.
Restoring a database without the matching vault key cannot recover vault secrets.

## Hosted execution boundary

A temporary directory and a child process are not tenant isolation. An operator
must verify an ephemeral container/VM boundary, CPU/memory/process/disk limits,
non-root execution, browser sandboxing and enforced outbound network policy.
Do not mount the Docker socket, host directories or cloud credentials in workers.
Block cloud metadata and private networks except explicitly required control-plane
services. Test DNS rebinding and redirects at the network boundary. Do not advertise
regional residency from a label alone; verify placement and storage/log locations.

Playwright's guidance for untrusted websites requires an appropriate non-root user
and seccomp configuration: [Playwright Docker guidance](https://playwright.dev/docs/docker).
Network policy behavior depends on the actual cluster network implementation:
[Kubernetes network policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/).

## Release and actual-project acceptance

Run `npm run test:all`, inspect skipped prerequisites, and retain the reports with
the exact lockfile/commit. Test migrations on a restored staging database before
release. Validate CLI/API/dashboard compatibility together. Review legal documents,
operator details, recovery ownership and incident procedures before publishing.
Marketplace publishing and production rollout are separate authorized operations.

Finally run the tool against the user's actual code and a disposable staging
environment. Review route coverage, configured accounts, mutation permissions,
skips, errors and false positives together. A green gate covers the checks that
actually executed; it is not a guarantee that the application has no bugs.
