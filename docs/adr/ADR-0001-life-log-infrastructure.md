# ADR-0001 — Life-log infrastructure bootstrap and isolated development D1

- Status: Proposed (PR review pending)
- Date: 2026-11-04
- Context: Personal weight-management app, Notion plan v0.7.
- Decision owners: Human for merge/environment creation; implementation by project workflow.

## Context
D1 is available as a Workers binding without a per-database password. GitHub Actions uses an account-scoped API token and account ID to interact with Cloudflare. An isolated development D1 UUID was supplied by the Human, but this repository cannot inspect GitHub Secret values or Cloudflare API access directly.

## Decision
1. Initial runtime candidates: React + TypeScript + Vite, Workers Static Assets + Worker API, D1, Cloudflare Access.
2. Use existing AI Driven Web App Template for governance; borrow security and migration ideas selectively from full-stack template, no wholesale copy.
3. Development D1 Binding name DB, database_name life-log-dev, UUID 421d0116-5c33-4782-a2b6-28f9684d3956 (Human-provided, not yet API-verified).
4. No runtime Worker, migration file, automated deploy or Access mutation in the Bootstrap PR. Production/Preview have no configured database; never reuse dev binding as a production target.
5. GitHub Actions secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are checked using a manual-only workflow. No token values in Git or logs. Workflow uses GET token verification and GET D1 metadata to confirm name/ID, no Cloudflare mutations.
6. Cloudflare Free/monthly 0-yen is a target, not a guarantee. Performance, auth boundary and shared quota require measurement.

## Alternatives
- D1-specific Secret: rejected; Worker Binding and account-scoped API token are the supported mechanisms.
- Existing mahjong-score D1: rejected; unacceptable data isolation risk.
- Auto-verify Secrets on PR: rejected; credential-bearing checks should not execute on unreviewed PR code. Manual workflow becomes runnable after approved merge.
- Auto-deploy from Bootstrap: rejected; Access and safe host are not set up.
- Full-stack template replacement: rejected for unnecessary initial complexity.

## Consequences / Risks
- Registering a UUID in Git does not confirm database existence or token permission.
- The initial Wrangler config is intentionally not deployable until a Worker entrypoint and an explicit deployment approval exist.
- Manual workflow requires approved merge to main, then explicit human operation; evidence cannot be claimed beforehand.
- Workers Free CPU and D1 limits must be tested; no automatic paid upgrade.
- No user data, images, or personal credentials are committed.

## Revalidation
Cloudflare official docs: https://developers.cloudflare.com/d1/reference/migrations/
Cloudflare API read-only: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/
Cloudflare API token verify: https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/
