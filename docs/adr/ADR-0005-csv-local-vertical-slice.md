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
