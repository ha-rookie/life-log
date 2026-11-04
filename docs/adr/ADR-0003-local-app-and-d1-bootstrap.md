# ADR-0003 — Local Workers/React+D1 skeleton with fail-closed access boundary

- Status: Proposed (Issue #5, human merge gate pending)
- Date: 2026-11-04
- Previous: ADR-0001 (infrastructure), ADR-0002 (main-only Cloudflare metadata check)

## Decision
- Build initial React+Vite SPA and Worker in one repository. Static Assets are configured `run_worker_first: true` so **every asset and API request** reaches the Worker before anything is served.
- Because Cloudflare documents that Workers Static Assets can suppress `ctx.access` propagation, rely on independent signature verification of the `Cf-Access-Jwt-Assertion` Access token using `jose` remote JWKS, strict issuer, app audience, RS256 and owner email. Values of ACCESS_TEAM_DOMAIN, ACCESS_AUD, OWNER_EMAIL are not committed and are unset by default: fail-closed.
- No local auth bypass is introduced to Worker code. Unit tests can inject synthetic verified principals into a non-deployed handler factory but default export uses actual `verifyOwner`.
- No admin provisioning, Access domain, Worker deploy, live session, or hostname exposure in this issue. Need security review on Cloudflare actual Access injection and all Worker routes before enabling remotely.
- D1 owner scope is a constant internal id ('owner') only **after** signed identity passes. GET summary is read-only; no write API.
- Schema preserves original measurement rows, day/time/source, provenance, nullable drinking observation and cups. Rows from a single source are unique, and cross-source duplicates use nonnull **reliable** fingerprint; unknown fingerprints are not guessed. Further dedupe resolution requires actual source samples.
- Keep local SQL and unit tests synthetic. Only Wrangler `--local` in CI; no actual health data in GitHub.
- PR CI uses npm install because lockfile cannot be generated and validated without dependency registry access in the current authoring environment; direct dependencies are exactly pinned, lockfile is a follow-up before deployment.

## Alternatives / Tradeoffs
- Trust `ctx.access` alone: rejected until Static Assets context propagation can be verified.
- Trust `Cf-Access-Authenticated-User-Email`: rejected, spoofable without cryptographic verification.
- Exempt static assets from auth for speed: rejected, anonymous UI is forbidden.
- Local dev auth bypass: rejected; blocked UI is safer until real Access environment is approved.
- Implement CSV import writes immediately: deferred until Source Mapping, transaction/error semantics, and local API negative tests are complete.

## Verification / Stop
- Synthetic JWT tests: wrong issuer/aud/email/expired/forged denied; default all URL paths must 403 without valid access.
- Python offline SQLite asserts 11 tables, same-day readings retained, bad counts blocked, source/fingerprint dedup, null-vs-zero exactness.
- Wrangler D1 migrations and fixture execute with `--local` only. CI must pass before Human merge review.
- No Remote D1 migration/write/query/deployment, no Cloudflare Access changes or main merge.
- Real deployment/Access protection and exact hostname routing remain future gates.
