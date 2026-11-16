# Stabilized platform checkpoint

Latest user direction: professionally stabilize existing work and provide a prompt
for the remaining implementation. No new roadmap features in this checkpoint.

Identity, configurable billing, restricted hosted profiles/evidence and
collaboration/trends now have implementations and regression coverage. Worker
settings and an isolation manifest are foundations; regional execution and real
isolation acceptance remain outstanding. The interrupted flow-recorder draft was
removed from the active CLI after review found incomplete action conversion and
missing acceptance tests. Existing scripted flows remain available.

See `REMAINING-WORK-PROMPT.md` for the copy-ready next task and `VALIDATION.md`
for the exact current results. The sequence below is the original delivery plan,
not a claim that every operational requirement is complete.

User direction: complete the remaining product code. External integrations must
remain provider-neutral, AI stays off, prices are configured later, and deployment
is deferred. No production payment, publishing or identity-provider connection is
performed as part of local implementation.

Delivery sequence:

1. Platform identity: TOTP MFA, recovery codes, session revocation, OIDC SSO and UI.
2. Billing: configurable plan catalog, usage/quotas, subscription event ledger,
   authenticated payment adapter, owner UI and per-plan evidence retention.
3. Hosted parity: safe profile settings/authentication and private evidence upload.
4. Collaboration: issue comments, trends, provider-neutral issue integration.
5. Operations: isolated runner packaging, regional configuration, local recording,
   export/monitoring workflows and release/acceptance documentation.

Each delivery needs meaningful positive and negative integration tests. Record the
actual outcome and remaining external acceptance steps; interfaces alone do not
establish successful production operation. Legal approval, real-provider accounts
and production deployment remain external acceptance steps, not fabricated results.
