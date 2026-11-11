# ECLEAR 7-field completion API — UAT enablement design (code only)

Date: 2026-11-12 (Thu, Asia/Tokyo). Tracked by [#149](https://github.com/ha-rookie/life-log/issues/149); user acceptance [#142](https://github.com/ha-rookie/life-log/issues/142), parent [#124](https://github.com/ha-rookie/life-log/issues/124) **remain open**.

## Current status and authority

This change **implements a fail-closed remote UAT entry gate**, NOT actual enablement. It does not modify `wrangler.jsonc`, remote D1, existing Secrets, UAT deployment or real measurements. Remote flag and HMAC key remain absent from all deployed configuration. Both v2 endpoints continue returning HTTP 403 on current UAT until separately approved deployment **and** configuration steps are completed.

## Owner and request trust boundaries

The normal Worker router first establishes `owner` using its existing authentication policy. **Remote ECLEAR** independently requires:

1. Existing `PASSWORD_ONLY_UAT=true` mode **and an existing Owner session cookie**; this is only the UAT application's mode discriminator, not password login (password endpoints were retired).
2. A second DB-backed `sessionIsPasskey` proof requiring a live `owner_sessions` row JOINed to `owner_passkey_sessions`. A legacy Owner session, Access JWT, spoofed `CF-Access-Authenticated-User-Email`, or a client-side boolean is insufficient. Do not conflate an Access JWT identity with WebAuthn authentication.
3. Dedicated environment bindings: `ECLEAR_ENRICHMENT_REMOTE_ENABLED=true`, `ECLEAR_ENRICHMENT_REMOTE_TARGET=uat`, and `ECLEAR_ENRICHMENT_REMOTE_ORIGIN=https://life-log-uat.ha-rookie.workers.dev` (exactly). These bindings must be provisioned explicitly during a future approved UAT release; they are **not** included here. Existing local flag `ECLEAR_ENRICHMENT_LOCAL_ONLY` never enables remote UAT.
4. Canonical HTTPS request URL origin equal to the hard-coded UAT origin, with no URL query/fragment, plus matching `Origin`, `Sec-Fetch-Site: same-origin`, `Content-Type: application/json`, method POST, and `X-Life-Log-Intent: eclear-enrichment-v2`. The app grants no cross-origin CORS. Origin and custom headers alone are not an authentication mechanism.
5. `ECLEAR_ENRICHMENT_REVIEW_KEY` must be a separately approved UAT secret of at least 32 UTF-8 bytes. The same key signs a 5-minute, Owner-/file-hash-/snapshot-bound HMAC token. The key is never shipped to the browser, committed to GitHub, or logged. For security, it **must not** be set via publicly visible `--var` CLI on Remote.

The `isSafeRemoteEclear` check is a defense-in-depth routing guard. The `passkeySession` boolean is **only** set by `src/worker/index.ts` after its actual DB-backed session check; request data cannot override it. The signing/DB transaction logic remains in the original `eclear-enrichment-route.ts`.

## Audit, idempotency and uncertainty

- Preview: Owner-scoped SELECT and non-sensitive counts/reasons only; no source CSV value, raw measurement, or record ID in the response. Preview does **not** write measurements.
- Confirm: requires the exact CSV and signed review token; re-computes the same Owner/file/DB snapshot, rejects expiry or changed snapshots with HTTP 409. An atomic D1 batch guards all existing measurements, fills **only NULL** composition fields, prevents conflicting non-NULL overwrites, and records independent job, row and changed-cell audits. No legacy import-job audit is overwritten.
- Conflict, replay or concurrent modifications return HTTP 409, not false success. DB read/authorization failure returns HTTP 503. A write/transport failure reports uncertain outcome; the client must re-preview/read back state rather than automatically reissue the commit.
- Missing values are NULL and are not equated to zero. Same CSV can be re-previewed; unchanged records are not duplicated.
- Audit tables deliberately store changed-cell values in the existing database for traceability. They are **personal measurements** and must only be queried or changed under future explicit authorization. Logs/CI should never output those values or the actual CSV.

## Test evidence required BEFORE merging or deployment

- Dedicated `tests/eclear-enrichment-uat.test.ts` uses disposable Wrangler local D1, synthetic Owner/session, signed session hash and synthetic ECLEAR values only. Applies 0001/0002/0003/0005 **locally**. Positive Owner-passkey preview/confirm, five-field NULL fill, audit and replay plus negative malformed token, session, Access spoof, flag, Origin/CSRF, conflict and DB error cases.
- Existing unit, schema, local migration, 390px Chromium mock-API and real local Worker/D1/virtual-passkey suites must continue to pass. No Cloudflare credentials or Remote D1 operations on PR CI.
- **Passing synthetic tests is not Android or UAT acceptance.** Issue #142 and #124 must remain open.

## Individually approved future gates (NOT executed here)

1. Final code security review; exact HEAD/main, all required CI SUCCESS, release workflow triggers and Issue closing-reference review before separately authorizing a main squash merge. The existing main metadata-check workflow is manual-only.
2. Approve read-only remote D1 schema/migration ledger inspection. Verify database UUID/name, existing applied migrations and audit-table status without selecting personal measurement rows.
3. Separately authorize remote additive `0005_eclear_enrichment_audit.sql` migration, with recovery/rollback plan and post-migration schema-only checks. Never migrate production or create a new D1.
4. Separately authorize provision of a **new UAT-only** high-entropy `ECLEAR_ENRICHMENT_REVIEW_KEY` Secret, validate ownership and rotation plan. No secret appears in PR artifacts or logs.
5. Separately authorize UAT-only variable bindings `ECLEAR_ENRICHMENT_REMOTE_*` and protected Worker deployment of exact approved main SHA. Confirm UAT bindings preserve Owner passkey policy and avoid production.
6. After separate approval, use synthetic UAT Owner/measurements only to verify 403/409/503, same-origin protections, snapshot race, audit and repeat import without touching the user's actual measurements.
7. Separately authorize physical Android passkey/ECLEAR CSV acceptance, preview the proposed diffs for actual user records, obtain explicit data-write approval, execute **one** controlled import, then read back only authorized values. Keep #142/#124 open until accepted.

Rollback for a future rollout: disable `ECLEAR_ENRICHMENT_REMOTE_ENABLED` on UAT first, verify new writes are blocked, and prefer additive forward fixes to destructive rollback of already audited personal history.
