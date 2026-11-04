# ADR-0005 — Explicit-confirmation synthetic CSV import bound to local D1 only

- Status: Proposed (pending Human approval; Issue #9)
- Date: 2026-11-05
- Base main: 0ea474741d3099ef92d73a6161e8d9632db0cb4a
- Complements ADR-0003/0004.

## Context
MVP needs historic lifestyle/ECLEAR CSV without fabricating measurements or exposing sensitive data. Existing D1 schema already provides provenance, job, row audit and NULL/zero semantics. Real personal files and all Cloudflare mutations are outside this work.

## Decision
1. Use a conservative pure TypeScript CSV parser for UTF-8 BOM, quotes, dates/time and nullable data. Only lifestyle and ECLEAR columns, max 30 rows/30KB. Editable mapping UI deferred.
2. Browser preview has zero side effects. Explicit confirmation submits raw CSV + SHA-256; Worker rehashes/reparses and verifies same format.
3. Signed Access owner verification always precedes requests; import has extra IMPORT_LOCAL_ONLY=true, localhost/127.0.0.1 host, same Origin and JSON POST checks. The flag is not configured in Wrangler; no public write route is enabled. Tests use a synthetic injected authorizer only.
4. Lifestyle identity uses owner/source/date; ECLEAR uses owner/source/exact timestamp. Same-file replay no-op; equal cross-file overlaps skip; differing overlaps conflict and reject whole file. Do not infer that a lifestyle date-only measurement equals a timed ECLEAR measurement from another source.
5. Write owner/job/new records/audit in a single transactional D1 batch. On failure the full batch is rolled back; there is no partial success status. This follows the D1 batch transaction contract.
6. Never store raw CSV permanently or log it; only normalized values and hash/source/audit metadata persist. Missing data remains NULL; explicit absence of drinking remains 0.
7. Local SQLite and injected-authorizer tests do not prove remote Worker/Access routing, live JWT identity, browser integration, real source mappings or Workers Free performance; require subsequent gated UAT.

## Alternatives
- Write during preview: prohibited.
- Per-row partial success: rejected, adds retry/recovery complexity.
- Overwrite existing rows: rejected until user conflict review.
- Cross-source all measurements on same date: not enough evidence to dedupe.
- Enable import on any deployed hostname: prohibited.
- Single request for all historical rows: deferred; design bounded batches first.

## Validation / rollback
- Parser synthetic cases: BOM, quotes, CRLF, size/row limits, bad date/number, null vs 0.
- Worker synthetic API: local-only + Origin + owner gate; replay/conflict/atomic failure tested.
- SQLite schema tests: uniqueness and rollback of multi-statement transaction.
- All changes GitHub-only until separate approval. No remote D1 SQL/Migration/write, Access change, main merge or deploy.
