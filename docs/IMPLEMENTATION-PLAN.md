# VeriQ implementation plan

Source: the user's QA Platform proposal (11 November 2026). The proposal is a
requirements reference; the user's instruction takes precedence over its suggested
two-week live-run prerequisite. Deployment and real-customer validation are deferred.
Provider-neutral integrations; AI disabled.

## Delivery order

1. Establish baseline checks and preserve existing failure assertions.
2. Foundations: safe HTTP retries and credential handling, OpenAPI/Postman imports,
   authentication strategies, validated versioned local plugin SDK, finding metadata.
3. Add the 26 proposed checks using bounded explicit configuration for active tests,
   and structured adapters for external scanners. A missing prerequisite is a skip,
   never a fabricated pass. External-tool output must be validated.
4. VeriQ branding: supplied assets, navy/green accessible light and dark theme.
5. Integrate documentation, examples and regression tests; run existing engine,
   platform, runner and browser checks. Record failures and root causes.

## Check inventory

Priority 1: authz-matrix, auth-session, rate-limit, data-exposure,
validation-coverage, sast, api-contract, test-results, uptime, tls-dns-mail.

Priority 2: race-conditions, file-upload, webhook-security, web-client-security,
web-forms, cross-browser, links-seo, container-iac, mobile-static, post-deploy-errors.

Priority 3: graphql, license-sbom, i18n-rtl, privacy-consent, load-stress,
bundle-budget.

## Security and evidence rules

- No silent gate success when a selected plugin errors.
- Never automatically retry mutations; do not infer destructive test targets.
- Active probes require explicit cases and disposable-environment authorization.
- Reject credential-bearing cross-origin API requests and redirects.
- Do not expose secret or personal response values in new findings.
- Treat external plugins/config scripts as trusted local code, never remotely supplied
  hosted-job code. Validate SDK version, settings and output.
- External scanners require local installations or supplied structured reports.
  Do not execute customer-supplied shell strings.
- Keep missing coverage distinct from a passing check; document adapter limitations.
- No assertion weakening to obtain a green test run.

## Separate infrastructure/product work

The proposal also describes object storage, retention/billing plans, SSO/MFA,
isolated regional workers, issue integrations, localization, a flow recorder,
marketplace distribution, legal review and production reliability. Track actual
delivery separately from plugin availability. These must not be labelled complete
because an interface or configuration field exists. Production credentials,
publishing, payments and deployment remain outside this local implementation run.

## Acceptance

Every added check must have positive and negative or prerequisite/safety coverage.
Existing checks must still detect their planted defects. Record exact commands and
environment/tool limitations in VALIDATION.md. Real MLITech results are validated
with the user after local implementation.

## Current delivery record

Engine/plugins, branding, private evidence, identity, configurable billing,
hosted profiles and collaboration/trends are implemented. The user then requested
a stabilized checkpoint and a prompt for remaining implementation. See
`REMAINING-WORK-PROMPT.md` for that handoff, `ARCHITECTURE.md` for boundaries,
`PLUGINS.md` for coverage and `VALIDATION.md` for actual verification results.
