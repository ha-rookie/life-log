# ADR-0005 — Synthetic CSV import vertical slice

- Status: Proposed, Issue #11; Human merge gate remains
- Baseline: main `0ea474741d3099ef92d73a6161e8d9632db0cb4a`

## Decision
- Implement synthetic-only canonical CSV headers for lifestyle and ECLEAR. Do not claim actual ECLEAR vendor layout is known.
- Browser preview is transient and performs no write. Confirmation requires explicit user action, SHA-256 match, and Worker-side full revalidation after signed Access owner authorization.
- Bound CSV to 64KiB/100 rows, reject malformed quotes, invalid dates, nonnumeric/negative/out-of-range values and inconsistent drinking presence/cups.
- Existing D1 import_jobs unique file hash and measurement reliable fingerprint implement idempotence. Multiple valid measurements per day are retained. SQL uses bind parameters and D1 batch transaction.
- No schema migration, remote SQL, Access change, deployment or actual user data.

## Limitations / Risk
- Real source mappings and import quality require approved sample data and a separate Issue.
- Concurrent cross-file same-measurement imports rely on DB uniqueness; skipped rows do not overwrite earlier source provenance.
- D1 batch failure must rollback all statements; preview-only path must not touch DB. Client confirmation is not an authorization control.
- Full import row audit and user-directed conflict resolution are follow-up work; import_jobs and source keys remain available for provenance.

## Revised conflict isolation and integration gate (Issue #11, same PR)
- Same owner/day different `drinking_presence`, `drink_cups` or `steps` is a conflict **across source files and source IDs**, including `NULL` versus explicit `0`. HTTP 409 returns date and differing field names; user resolution is deferred. Exact matching days are skipped and never duplicated.
- Previous `INSERT OR IGNORE INTO lifestyle_days` silently discarded different same-day data. Replace it with explicit preflight reads plus owner-scoped transactional guard on `import_jobs` status. A reserved invalid `conflict` status violates the existing CHECK constraint, causing D1 batch rollback if a conflicting write races preflight. The guard dynamically repeats only a fixed bound SQL predicate and binds all values.
- Integration tests use Wrangler `getPlatformProxy` with `remoteBindings:false`, `persist:false` and apply the existing migration to an ephemeral local D1. SQL failure is injected into a *real* D1 batch after an initial insert; the batch must rollback, with no import job or rows, and clean retry must succeed.
- No schema/config/CI changes, migration, real data or any Cloudflare remote operation. The test harness does not prove production concurrency behavior; that remains a later UAT gate.
