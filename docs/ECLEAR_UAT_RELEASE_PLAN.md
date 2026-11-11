# ECLEAR 7-field enrichment — UAT release plan (DRY RUN ONLY)

Updated: 2026-11-11. Tracking: #124 / #142. Main baseline:
`5af8f67f6be2a4a36833bc4c5bb2a7faf042e7db`.

## Status and non-negotiable boundaries

- The v2 `/api/eclear/enrichment/preview` and `confirm` routes are implemented
  but disabled in UAT and production by `ECLEAR_ENRICHMENT_LOCAL_ONLY`.
  **Do not set this local-only switch or its review HMAC key in UAT/production**.
- Migration `0005_eclear_enrichment_audit.sql` is tested **locally only**.
  The remote schema is not inspected by this plan. Never infer the remote migration
  state from local CI. A real remote read/migration requires new explicit approval.
- The existing UAT deploy workflow is dispatch-gated, but a main push also
  automatically triggers `cloudflare-d1-readonly-check.yml`, which reads remote
  development D1 **metadata**. Any future main merge under a remote-read ban must
  account for that trigger before the merge; feature-branch Draft PR does not.
- `life-log-ci.yml` on a PR uses npm and local Wrangler only, no Cloudflare
  secrets. The 390px Chromium test runs the actual Vite React app with synthetic
  browser-intercepted `/api` responses. It does **not** use the Worker D1 backend.
  The Worker/DB transaction is separately verified by synthetic local D1 tests.

## Safe approval sequence (none authorized or executed by this document)

1. **Local acceptance**: latest-head TypeScript, full unit/regression suite,
   local D1 migrations and synthetic fixtures, real Chromium 390px E2E,
   browser-level normal CSV vs composition mode, passkey UI, 403/409 and
   uncertain outcomes; run actual local Worker+D1 integration when possible.
2. **Design review / remote enablement**: replace the strictly loopback-local
   v2 flag with a *separate* UAT-only, owner-authenticated and origin-bound
   opt-in design. Review CSRF, session, rate limiting, HMAC key lifecycle,
   audit access, and rollback/forward-fix. This is a **new code/security gate**.
   Do not reuse the local-only flag as a shortcut.
3. **Remote D1 inventory (new explicit approval)**: confirm the single existing
   database UUID `421d0116-5c33-4782-a2b6-28f9684d3956` and environment
   binding; verify applied migrations with metadata-only read. No personal
   record reads without distinct approval. Back up/restore planning before writes.
4. **Remote migration 0005 (separate approval)**: apply only the additive,
   reviewed migration to the existing UAT database; no new D1 instance.
   Record before/after schema version, migration job result and rollback strategy.
5. **UAT secrets / config (separate approval)**: provision only an independently
   reviewed UAT HMAC secret using an approved secret-management workflow.
   Never print it or commit it to GitHub. Do not enable v2 in production.
6. **Protected UAT deploy (separate approval)**: verify the approved exact
   main SHA and dispatch input for the existing protected workflow, its
   Cloudflare binding, deploy guard and secrets scope. Dispatch only after
   the remote migration, auth/security gate and user authorization.
7. **Synthetic UAT acceptance (separate approval)**: first use synthetic
   records under an isolated test Owner and verify 7 fields, NULL vs 0,
   idempotency, stale review, conflict and audit. Explicitly distinguish
   UAT test writes from the user's actual data. Real Android passkey login
   and real measurements need their own approval.
8. **Real-data acceptance (separate approval)**: capture only approved ECLEAR
   source dates/fields; preflight read-only diff, user review and one-time
   write; verify stored values and source attribution. Never silently merge
   date-only records or overwrite non-NULL measurements.
9. **Rollback**: disable UAT v2 endpoint first; prefer forward-fix of additive
   audit tables to destructive rollback. Do not erase audit history or restore
   old snapshots over newer legitimate measurements.

## Release blockers as of this plan

- UAT v2 remote auth/feature flag and HMAC lifecycle: **not implemented**.
- Remote 0005 migration and its actual status: **not checked**.
- Real Worker + browser end-to-end and physical Android passkey ceremony:
  **not accepted**.
- User's actual ECLEAR data import: **not executed**.
- Parent #124 and Stage 2C #142 remain open until these gates are satisfied.

No remote Cloudflare API, D1, Secrets, Worker or personal measurements are
read or changed in this planning change.

Browser E2E uses an explicit synthetic-only origin on 127.0.0.1 and does not
claim hardware WebAuthn authentication; passkey ceremony remains a separate
physical-device acceptance gate. The branch is never automatically merged.
