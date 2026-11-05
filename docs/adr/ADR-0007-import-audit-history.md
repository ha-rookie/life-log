# ADR-0007 — Owner-only CSV import audit history (read-only)

- Status: Proposed, Issue #15, Human merge approval required
- Baseline: main 41b10e6d92c380dd529f99f053410e396060b551
- No migration, remote D1 action or schema change

## Problem
The confirmed import job and its per-row audit records are persisted locally but
have no user-visible read-only retrieval interface. A simple list must not claim
that absent audits are zero inserted rows, accidentally disclose another owner's
health records, or reconstruct historical CSV field values that were not stored.

## Decision
- Cloudflare Access signed JWT and exact owner allowlist are checked in the Worker
  **before** any API, D1 or static-asset call. The two GET-only routes use the
  authenticated "owner" ID; client query parameters cannot select a tenant.
- GET /api/import/history?page=1&limit=10 lists completed/partial CSV import
  jobs in deterministic (completed_at / started_at, id) descending order.
  GET /api/import/history/rows?job=...&page=1&limit=10 selects a single
  owner-bound job, then inner joins the job table **with owner predicate in the
  row SQL**. No cross-owner row is returned, even with a guessed job ID.
- Page is 1..200, limit 1..20; duplicate, invalid or extraneous query params
  fail 400 before D1 work. SQL is static and all values/limits/offsets are
  bound. A page reads at most limit+1 rows to derive hasMore. Offset pagination
  can shift when new imports are committed; UI should restart at page 1 on refresh.
- Show source, confirmed/partial status, timestamps, audit counts and result
  categories without full CSV, row provenance key, email, measurement or
  exception details. The API necessarily gives the authenticated owner a
  deterministic job identifier (which incorporates the SHA-256 file digest) to
  request detail; the UI must not print that identifier. No new logs,
  analytics, third-party scripts, localStorage or raw CSV payload persistence.
- Classify a confirmed old-marker job with zero audit records as
  legacy_unavailable and report unknown counts as JSON null. A new audited-v2
  job with zero audit rows, or an incompatible marker, is incomplete and also
  returns null counts. New audited-v2 jobs with >=1 audit entry are recorded
  with observed counts, NOT labelled fully verified: import_jobs stores no
  expected per-file row count, so partial loss of audit rows cannot be
  established from this list alone. Full replay integrity remains checked by
  the confirm endpoint when the CSV is supplied.
- Row detail shows source line number, result and a small allowlist of safe
  error codes. For *inserted lifestyle records only*, optionally join the
  current stored daily values; JSON null remains null and numeric 0 remains 0.
  These are expressly labelled "current saved values", NOT historical CSV
  values; missing, skipped or conflicting row values are never guessed.
  ECLEAR values are intentionally not returned.
- All responses use private/no-store, nosniff, no-referrer headers. Unknown
  job or foreign owner returns the same 404. D1 exceptions return a generic
  503. The history UI/API has **no mutation endpoints**.

## Alternatives and limitations
- Offset pagination is simpler and avoids embedding file hashes inside a
  pagination cursor. New imports between page requests may move items; page
  identity is not a transactional snapshot.
- Legacy source markers can be spoofed only by DB writes outside this feature;
  historical row count is not recoverable from the current schema. A future
  schema change may add expected_row_count and a genuinely opaque stable
  history identifier, subject to a separate Human-approved Issue.
- Live Cloudflare Access and remote D1 are NOT used or tested here. Evidence
  is synthetic, owner-scoped local Wrangler D1 integration only.
