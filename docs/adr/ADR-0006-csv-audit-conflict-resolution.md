# ADR-0006 — Atomic import_row_audit and non-destructive conflict review

- Status: Proposed; Issue #13. Human merge approval remains mandatory.
- Baseline: main `7c003968c2a9265e77bd900d762df78d03c643be`.
- Extends ADR-0005: granular audit is now implemented for accepted imported CSV rows; schema unchanged.

## Problem
File-level import status concealed which input rows were actually inserted, skipped as equal duplicates or kept as existing because of a conflict. A stale UI resolution could mislabel audit records if existing data changes before write.

## Decision
- Default fail-closed: return 409 with conflicting date/fields and an optimistic review token, and perform no writes. Owner can cancel or explicitly keep existing conflicting rows while importing remaining rows; never automatically replace existing data.
- Compute reviewToken from the signed owner's identity, full CSV digest and all existing source IDs, source row keys and NULL-safe observed values for each submitted date. Token is **not authentication** and does not substitute for signed Access JWT.
- Revalidate all source rows (counts, source key and NULL-safe values) inside the same D1 batch as the job, destination rows and audits. A mismatch selects an invalid job status rejected by the existing CHECK constraint, rolling back all writes.
- For every confirmed source row, write the actual inserted/skipped/conflict outcome to `import_row_audit` using SQL that examines the new destination state *after* insertion, in the same atomic batch. Store source row number/key and `LIFESTYLE_CONFLICT_KEPT` error code for explicitly skipped conflicting rows.
- `partial` status indicates that existing conflicting data was deliberately kept; both partial and confirmed jobs are idempotent for the same owner/source/file hash. Replays read the original audit and never create additional audit rows.
- For ECLEAR, keep its existing measurement fingerprint duplicate logic; audit inserted/skipped and do not infer a conflict from same-day different legitimate observations.

## Limitations and recovery
- An unconfirmed or rejected conflict creates no audit: audits describe **committed import decisions**, not every attempted preview.
- Replacing/merging historical records, a complete audit-history UI and real vendor CSV column mapping are future work requiring separate scope.
- Local Wrangler D1 is tested with synthetic data; no Cloudflare Access live verification, Remote D1, Migration, Access change, Production/Preview deployment or real data use in Issue #13.
