# ADR-0007 — Owner-only read-only CSV audit history

Status: Proposed (Issue #17)

## Decision
Use authenticated GET /api/import/history (job list) and GET /api/import/history/:jobId (row detail). Both run behind the existing signed Cloudflare Access JWT owner gate. Every query is owner-scoped and parameter-bound. Pagination uses bounded keyset cursors, validated against owner-owned anchors; max page 25.

Return minimal audit metadata, no raw CSV, file hashes, source row keys, owner IDs or source contents. Persisted values are exposed only for successfully inserted rows; missing numeric values remain null and zero remains 0. Skipped/conflicted original incoming values cannot be reconstructed from existing schema and must not be invented. Legacy confirmed jobs without audits are labeled legacy_unavailable; modern empty audits are incomplete. No schema migration or writes.

## Constraints
Synthetic/local D1 only; real vendor CSV unknown; Remote D1, Access changes, Preview/Production deploy and main merge prohibited until separate human approval.
\nOpaque job handles are local SQLite rowids, not the import_job.id (which embeds the file SHA-256). Keyset cursors contain only a handle and timestamp; all handles are owner-bound before use.\n