# ADR-0004 — Reproducible npm CI and expanded Access negative testing

- Status: Proposed (Issue #7; human merge gate not yet passed)
- Base: main 1f434dc5906d198a04bb6a6ba6c219eedacf6d37
- Related: ADR-0003, Issue #7

## Decision
1. Add an authentic npm package-lock.json (npm 10 format with integrity values) generated from unchanged package.json dependencies by an isolated GitHub Actions npm install. Lock metadata is transported through temporary private PR job logs and immediately removed from the final CI workflow before review.
2. Make app CI run on both pull_request against main and push to main; install with npm ci, which refuses a missing or stale lock and does not write an updated lockfile.
3. Keep CI permissions to contents: read, no Cloudflare credentials, no deployment, no remote SQL. Migrations and synthetic D1 fixture run solely with --local.
4. Enhance negative tests: no credentials/config, spoofed unsigned user headers, unknown cookie, malformed JWT, wrong signature/iss/aud, incorrect email, wrong key, future not-before, unauthorized API/static paths and methods, D1 failure without details.
5. Preserve the existing separate credential-bearing main-only Cloudflare metadata GET workflow.

## Trade-offs and limitations
- npm ci is deterministic with respect to the committed lock; npm registry artifacts must still be trusted and independently audited for security issues.
- App CI will run on main and PR after this PR is merged; main execution is not testable as a push before a separate Human approval.
- Additional negative tests do not prove that Cloudflare Access protects every real hostname or that browser login works; this needs independent staging/production UAT and human approval.
- The local working container cannot access npm registry; a one-time, no-secret GitHub Actions runner generates the lockfile, which is checked in and subsequently verified by npm ci.

## Validation
- PR exact head: Repository validation and Life-log app CI SUCCESS, with npm ci, TypeScript+Vite, JWT/Worker tests, Python SQLite synthetic constraints and Wrangler --local migrations.
- No main merge, Remote D1 migration/queries/writes, Cloudflare Access change or deploy in Issue #7.
