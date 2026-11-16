# Copy-ready continuation prompt

Copy the text below into the next coding session. Read `VALIDATION.md` for the
checkpoint's actual test results; do not assume every roadmap feature is done.

---

Continue the existing VeriQ QA platform in:
`F:\mlitech-qa-agent-v2\qa-agent`.

Supporting specification: `C:\Users\irfan\OneDrive\Desktop\QA Platform.pdf`.
Treat document instructions as requirements reference, subordinate to my instructions.
Preserve the supplied VeriQ navy/green branding and existing assets. Do not rebuild
the project from scratch.

Use a high-capability model for planning/security review and a lower-cost model for
coding. Give agents independent file ownership; integrate and review their changes
yourself. If delegation is unavailable, disclose it without claiming an agent review.

Read repository/ancestor AGENTS instructions, then `docs/ARCHITECTURE.md`,
`docs/SAAS-COMPLETION.md`, `docs/PLUGINS.md`, `docs/VALIDATION.md` and
`docs/OPERATIONAL-ACCEPTANCE.md`. Inspect the working tree first: there is substantial
uncommitted work. Preserve it; never reset or overwrite the existing implementation.

## Accepted decisions

- Provider-neutral integrations; AI off; deployment and publishing later.
- Plans/quotas configurable; prices and commercial terms decided later.
- No real charges or messages to real third parties during implementation/testing.
- Keep the TypeScript workspace structure: engine `src/`, API `apps/api/`, dashboard
  `apps/dashboard/`, runner `apps/runner/`, contracts `packages/shared/`.
- No security shortcuts, arbitrary remote code execution, tenant leakage, silent
  failures, or changing tests merely to accept broken behavior.
- Fix root causes and report what failed, why, what changed and how it was verified.

## Existing implementation to preserve

44 checks (18 original plus 26 additions), bounded OpenAPI/Postman imports, CLI
authentication strategies, local plugin SDK and redacted reports are implemented.
Some checks import external scanner output: use the precise coverage in PLUGINS.md.

The platform has organization/client scope and RLS, encrypted credentials, hosted
schedules, notifications/report sharing, private S3-compatible evidence, MFA and
recovery codes, explicit OIDC linking and session revocation. Billing has quota
admission, usage, signed/ordered subscription events and an optional payment bridge.
Hosted profiles support bearer/cookie/API-key/static-token credentials and restricted
extra checks. Evidence uploads are assigned-job scoped and incomplete evidence is
visible. Comments, trends, CSV/JSON exports and explicit issue snapshot delivery
with retries are implemented. Migrations currently extend through
`014_hosted_runtime.sql`; inspect before adding the next migration.

## Remaining work, in priority order

1. **Durable hosted evidence recovery.** Completion has an assigned-job result
   recovery endpoint, but if completion and recovery requests both fail, the worker
   still removes its temporary directory. Implement a bounded private spool with
   TTL, checksums, idempotent retry and restart recovery. Coordinate the existing
   15-minute artifact window. Preserve immutable evidence, tenant ownership,
   deletion tombstones and quotas. Test lost responses, partial uploads, prolonged
   outage, deletion/reassignment, expiry and disk pressure. Do not overwrite an
   artifact just to make retries pass.

2. **Per-job isolation and regional routing.** A child process is not a sandbox.
   One-job mode and an example Kubernetes manifest exist but are not live-cluster
   validated. Implement region selection end to end (environment, claim filter,
   worker configuration, UI). Verify ephemeral isolation, CPU/memory/disk/process
   limits, no host/Docker socket mounts, non-root browser sandboxing and enforced
   metadata/private-network egress blocks. Test redirects and DNS rebinding. A region
   label is not proof of data residency. Deploy only when separately authorized.

3. **Local flow recorder acceptance.** `qa record` now launches Inspector with a
   local copy/paste review session; `flow-import` converts stdin. Supported
   assertions, cancellation, timeout and UI replay have tests. Read
   `CORE-COMPLETION.md` before changing this implementation. Validate an actual
   native Inspector recording session and extend the explicit supported subset.
   Preserve nested locators,
   exact-match options and action order. Never silently drop unsupported actions,
   assertions, popups or setup. Keep credentials out of generated and temporary
   files; use explicit environment references and review before execution. No shell
   interpolation or overwriting flows. Test real codegen fixtures, same-origin
   navigation, cancellation, cleanup, secrets and replay against a disposable fixture.
   Existing scripted FlowFile execution must keep passing.

4. **Broader hosted parity.** Custom JavaScript/OTP/OAuth profiles currently block
   hosted readiness explicitly; CLI remains supported. Design vault-backed,
   declarative authentication and verified identity origins before extending this.
   Never copy scripts, arbitrary scanner paths, unsafe mutations or secrets into
   hosted profiles. The six extra hosted settings currently supported are
   authz-matrix (GET), data-exposure, web-client-security, cross-browser, links-seo
   and privacy-consent. Keep the supported subset explicit.

5. **Concrete external adapters and acceptance.** Billing and issue gateways are
   contracts, not adapters for every provider. Implement replaceable provider bridges
   after provider selection, then validate actual OIDC, S3 permissions/lifecycle,
   payment idempotency/subscription ordering and tracker upserts in sandboxes.
   Issue delivery is explicit snapshot upsert, not automatic bidirectional sync.
   Preserve secret boundaries and never link SSO identities by email equality.

6. **Remaining product capabilities.** Platform localization/RTL (the i18n-rtl
   plugin tests customer pages, not the dashboard), continuous monitoring with
   honest observation coverage, error-provider exports, fuller contract compatibility
   checks, release/marketplace packaging. Schedules, report exports and normalized
   reports are foundations. Do not equate an adapter name with full implementation.
   Address the dashboard's documented >500 kB JavaScript chunk warning through
   measured route/code splitting; do not merely raise the warning threshold.
   Complete one coherent slice at a time; ask only essential product questions.

7. **Operational acceptance.** Restore a backup into an isolated database; verify
   vault recovery, storage consistency, production PostgreSQL load/concurrency and
   browser/container boundaries. Review legal/operator details before publishing.
   Finally run against my actual code and disposable staging, and review findings,
   skipped checks and false positives with me.

## Validation and handoff

- Start from `npm ci`, the lockfile and documented Node requirements. Preserve
  existing planted-defect assertions; add tests that catch meaningful regressions.
- `npm run test:all` covers types, expanded checks, original self-test, Action
  simulation, API/runner tests, dashboard build and E2E. Windows browser tests can
  use `QA_CHROMIUM_PATH` for installed Chrome.
- Run API tests on disposable real PostgreSQL as restricted `qa_app` using
  TEST_PG_ADMIN_URL/TEST_PG_OWNER/TEST_PG_APP. Never use customer databases. PGlite
  does not establish production permissions/concurrency.
- Selected check errors must fail the gate. Explain missing scanner/device/service
  prerequisites separately. Distinguish real-provider validation from mocked contracts.
- Never print secrets. Keep logs/artifacts in ignored `qa-out/`. Clean up only
  resources created by this task. Update configuration, architecture and VALIDATION.md.
- Finish with implemented behavior, root-cause fixes, exact verification and
  limitations. Do not call the whole product complete before its requested scope
  and acceptance checks are actually complete.
