# Requirements Traceability — ライフログ（仮）

## 1. 目的
初期要求、設計、実装、テストの対応を追跡する。Bootstrap時点では実装を済ませたと見なさない。

## 2. Status Definitions
- ACTIVE: 合意済・適用対象
- DEFERRED: 将来の別検討
- TBD: 詳細の合意・Evidence待ち
- NOT IMPLEMENTED: 設計のみで実コード・テストなし

## 3. Traceability Matrix
| Requirement | Summary | Design IDs | ADR | Issue | Implementation | Test | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-001 | 本人限定ログイン・API認可 | ARCH-001, ARCH-013, APP-005 | ADR-0001 | #1 / future | Not implemented | 未認証負テスト予定 | ACTIVE |
| REQ-002 | 過去記録の移行 | ARCH-002, DATA-001/004/005 | ADR-0001 | #1 / future | Not implemented | 重複・欠測検証予定 | ACTIVE |
| REQ-003 | 体重・行動の期間比較 | APP-002, UI-002, DATA-006 | ADR-0001 | #1 / future | Not implemented | 期間比較予定 | ACTIVE |
| REQ-004 | 飲酒・食事簡易記録 | APP-001, UI-001, DATA-002/003 | ADR-0001 | #1 / future | Not implemented | 入力/取消予定 | ACTIVE |
| REQ-005 | 仮説・行動検証 | APP-003, UI-003, DATA-007 | ADR-0001 | #1 / future | Not implemented | 支持・反証予定 | ACTIVE |
| REQ-006 | CSV継続取込 | APP-004, IF-API-002, DATA-005 | ADR-0001 | #1 / future | Not implemented | 不正・冪等予定 | ACTIVE |
| REQ-007 | データ再出力 | APP-006, UI-004 | ADR-0001 | #1 / future | Not implemented | Export予定 | ACTIVE |
| REQ-008 | AI写真解析（MVP対象外） | ARCH-003 | ADR-0001 | Future | Not implemented | PoC未実施 | DEFERRED |
| REQ-009 | 排便記録なし | UI-001/004 | - | #1 | No feature planned | 受入時確認 | ACTIVE |
| NFR-001 | Security fail-closed | ARCH-001, APP-005 | ADR-0001 | #1 / future | Not implemented | Access/Direct API予定 | ACTIVE |
| NFR-002 | Data integrity | ARCH-002, APP-006 | ADR-0001 | #1 / future | Not implemented | 欠測/重複予定 | ACTIVE |
| NFR-003 | Free performance | ARCH-003, APP-004 | ADR-0001 | #1 / future | Not implemented | CPU/行読書き実測予定 | ACTIVE |
| NFR-004 | Mobile usability | UI-001/004 | - | Future | Not implemented | Android実機予定 | ACTIVE |
| NFR-005 | Cloudflare月額0円目標 | ARCH-003 | ADR-0001 | #1 / future | Not implemented | Usage実測予定 | ACTIVE |
| NFR-006 | Health data privacy | ARCH-001, APP-005 | ADR-0001 | #1 / future | Not implemented | Logs/Repo監査予定 | ACTIVE |

## 4. Bootstrap Acceptance
- User-provided development D1 UUIDをwrangler.jsoncに配置し、存在を検証済みと表現しない。
- Cloudflare API TokenとD1 metadata GETの検証ワークフローを提案。実行はmain反映後の別工程。
- GitHub TemplateのProject validation通過を確認。Application Runtime・remote validation・deploymentは未実施。

## 5. Credential Verification Transition (Issue #3)
- Bootstrap時点の手動Workflow採用理由をADR-0001へ残し、トリガーのみADR-0002で変更する。
- PRではCloudflare Secretsを使用しない。既存Repository validationのみ実行する。
- GitHub mainへの承認済みpush後、GitHub ActionsがToken activeとD1 metadataのGETを自動実行する。実行結果が確認されるまではRemote D1認証・存在は **未検証**。
- D1の行読み書き、SQL、Migration、Worker Binding実行、DeployはこのWorkflowの検証範囲外。

## 5.1 Local bootstrap (#5)
- REQ-001 / NFR-001: Access JWT signature, issuer/audience/owner checks and Worker-first assets/API boundary implemented and tested with synthetic JWTs; live Access / all hostname routes remain **UNVERIFIED**, not delivered/accepted.
- REQ-002 / REQ-006 / NFR-002: local D1 schema and synthetic SQL with double-insert checks; actual CSV parser, import jobs orchestration, transactions and cross-file conflict workflow **NOT IMPLEMENTED**.
- REQ-003: read-only most recent body weight API and React UI; advanced period comparison **NOT IMPLEMENTED**.
- REQ-004: legacy drinking 1→unknown count, 0→confirmed zero; daily entry API and 1-tap UX **NOT IMPLEMENTED**.
- Production/Preview, real import, User Acceptance, remote D1, Cloudflare Access provisioning **NOT EXECUTED**.
- Validation: Issue #5 PR tests (Vitest, TypeScript+Vite, offline SQLite and Wrangler D1 local) require actual CI evidence; do not mark success from code presence.

## 6. Coverage Review
Release前に全ACTIVE要件の実装・テストEvidenceを確認し、未実装／未検証を明確に残す。

## 5.2 Reproducible build and negative authentication (Issue #7)
- REQ-001/NFR-001: add synthetic negative JWT signatures, identity spoofing, issuer/audience/time validity and all Worker route types; real Cloudflare Access integration remains NOT VERIFIED.
- CI reproducibility: `package-lock.json` + `npm ci` on both PR and main push (main execution only after separate approved merge). The existing Cloudflare credential GET-only workflow remains separate.
- No remote D1, Cloudflare Access configuration, Preview/Production deployment or actual user data is modified.

## 5.3 Synthetic CSV import vertical slice (#11)
- REQ-002/REQ-006/NFR-002: strict synthetic CSV mapping, preview-before-confirm, Worker-side revalidation, missing vs zero, per-file SHA-256 idempotence and ECLEAR cross-file reliable fingerprint. Atomic local D1 batch; real export columns remain TBD.
- NFR-001/NFR-006: Worker signed Access authorization before all import routes, owner-scoped parameterized SQL; no raw CSV in logs. Real Access and real personal data UAT NOT EXECUTED.
- Verification: Vitest CSV/Worker negative cases and existing PR CI (npm ci, TypeScript/Vite, SQLite and Wrangler --local); no Remote D1/Preview/Production.

## Issue #11 collision fix and real local D1 integration (unmerged)
- REQ-002/006 NFR-002: NULL-safe source-independent per-day lifestyle conflict comparison; conflicting values return HTTP 409 with day and differing field names, no job/row writes, no automatic overwrite or silent ignore. Equal duplicate days are skipped.
- Concurrency: a transactional job-status CHECK guard revalidates every day inside the D1 batch, closing the read-to-write race. SQL failure rolls back the entire batch. Main and remote still unchanged.
- `tests/import-worker.test.ts` runs actual ephemeral Wrangler D1, not only an in-memory mock, and verifies preview no-write, NULL vs zero, same-file retry, cross-file duplicate, conflict persistence, raced insertion, mid-batch SQL failure/rollback and clean retry.
- Actual user data, actual CSV vendor layout, remote D1, Cloudflare Access setup and deployment remain NOT VERIFIED / NOT EXECUTED.

## 5.4 Row-level audit and safe conflict decision (Issue #13)
- REQ-002/006, NFR-002: per-row `import_row_audit` has result inserted/skipped/conflict, source row number/key and conflict code; same D1 transaction as imported rows/job. Rejected and stale conflicts create no committed audit by design.
- APP-004/UI-004: explicit two-stage conflict resolution; owner selects Keep existing/skip conflicts or Cancel. No automatic replacement; no confirmation means no write. Review token binds owner, file hash and owner-scoped DB snapshots.
- APP-005/006/NFR-001: signed Worker-first owner auth unchanged; server recomputes token and D1 batch rechecks row count and NULL-safe stored source values for all dates, preventing preflight/write race. All job/data/audit rolled back on SQL failure. Partial same-file imports remain idempotent.
- Evidence: actual ephemeral local Wrangler D1 with synthetic CSV, authorization/invalid/stale/rollback/retry tests; TypeScript/Vite, SQLite Python and GitHub PR CI on final HEAD. Real vendor mapping, Cloudflare Access live UAT, Remote D1 and deployment not executed.

## 5.5 Backward-compatible idempotence for PR #12 jobs (Issue #13)

- Legacy discriminator: confirmed `import_jobs.source_id=csv:<source>` and no `import_row_audit` rows, matching the already-merged pre-audit code path, return `already_imported` + `auditStatus=legacy_unavailable` + `original=null`. Never fabricate counts, write audit backfills or reinsert rows.
- Newly audited jobs identify themselves with `source_id=csv:audited-v2:<source>`, without schema changes or destination source ID changes. Normal audited replay returns original audit summary.
- A partial/zero missing audit for new-format jobs, any incomplete audit in either format, or partial legacy jobs with no audit must fail closed (`INCOMPLETE_AUDIT`, 503).
- Verify on ephemeral local Wrangler D1 with pre-audit confirmed fixture, same-file replay, modern complete/empty/partially removed audits, and previous fault rollback, NULL≠0, owner, race and retry tests. Real personal CSV and Cloudflare remote bindings remain forbidden.

## Issue #17 audit history
- Owner-only GET job list and row detail; no unauthenticated DB access; SQL parameter binding and owner filter.
- Bounded cursor pagination (10 default, 25 max), invalid cursor rejection, no raw CSV/file hash/source key in API.
- Legacy confirmed zero-audit shown as unavailable; modern missing audit as incomplete; no fabricated skipped/conflict values; inserted lifestyle NULL distinct from zero.
- Synthetic local D1 integration and security regression tests; no merge or remote operations.

- Issue #17 follow-up: list/detail reconcile owner-bound persisted destination count against inserted audit outcomes; mismatch => incomplete and null summary counts. Synthetic ephemeral local D1 tests cover partially missing inserted audits for both sources, legitimate skipped/conflict non-inserts, and legacy zero-audit with persisted rows. Missing skipped/conflict audit records remain unprovable without the original expected-row count.

## Issue #19 — CSV confirmation local-only security gate (Draft PR)
- **NFR-001, NFR-006, REQ-002/006:** Signed owner JWT still gates all routes first. A trusted runtime opt-in `IMPORT_LOCAL_ONLY=true` plus loopback URL, exact same `Origin`, valid fetch-site context and POST method is required for `/api/import/confirm`. Missing or forged opt-in cannot be provided by the client. Disabled/mismatched confirm requests return 403 **before any D1 access**.
- **APP-004/005/006:** Preview requires signed identity but is still DB-write-free and does not require the new opt-in. Existing conflict, audit, idempotence and atomic synthetic local-D1 behavior is deliberately unchanged.
- **Evidence:** `tests/import-local-guard.test.ts` contains signed synthetic JWT acceptance/rejection and ephemeral Wrangler local D1 confirmation, replay, conflict, NULL-vs-zero and no-DB-on-denial tests. Existing `tests/import-worker.test.ts`, `tests/audit-history.test.ts` and required TypeScript/Vite, Vitest, Python SQLite, Wrangler `--local`, repository validation and app/D1 CI must remain successful on the Draft PR HEAD. Actual CI result is reported separately, never assumed from source code.
- **Not verified / prohibited:** Cloudflare Access live routing, real health CSV, Remote D1 SQL/reads/writes/Migrations, GitHub Secrets or Access configuration, Preview/Production deploy and main merge.

- **Runtime flag exposure note:** The runtime opt-in is deliberately absent from committed `wrangler.jsonc`, GitHub Actions configuration and deployment configuration. Enable it only in a locally controlled Wrangler process bound to loopback for synthetic UAT, then stop the process; request headers/cookies cannot supply the opt-in. The PR uses exactly the Issue #19 `Planned Files` paths and must pass its repository Scope Guard on the latest event/HEAD.


## Issue #20 Stage 1 — byte-preserving CSV adapter evidence
- **REQ-002, REQ-006, NFR-002:** Legacy canonical text route unchanged; uploaded file bytes are SHA-256 hashed **before** UTF-8/BOM/line-ending normalization. New \`csvBase64\` route rejects mixed text+bytes, malformed/noncanonical base64, missing/wrong hash, illegal UTF-8/UTF-16/Shift_JIS, out-of-range dates/numbers and unsupported headers. Worker revalidates the complete source bytes and selected source before DB; no silent CSV field dropping.
- Japanese \`lifestyle\`: required \`日付\`, \`飲酒\`; optional \`歩数\`; presence/cups null-vs-zero semantics preserved. Nonempty \`体重_kg\` / \`測定時刻\` fail closed instead of silently ignoring a second target or fabricating a measurement time. Japanese \`eclear\`: \`年月日\`/\`時刻\`/\`体重\` required, \`体脂肪率\` and \`骨格筋率\` optional, single existing measurement row only. Explicit type/source selection prevents ambiguous detection.
- **NFR-001, NFR-006, APP-004/005:** Browser preview remains transient and no-write; owner JWT verified first, Issue #19 loopback+Origin+runtime-only local flag gate continues to reject confirm before D1. JSON byte transport does **not** bypass the guard. Private file contents and personal records are never written to GitHub issues, source or test fixtures.
- **Tests:** \`tests/csv-byte-mapping.test.ts\` covers UTF-8 strictness, BOM/raw hash, malformed base64, physical line numbers, Japanese mappings, missing fields, measurement-time ambiguity, canonical backwards compatibility, 64KiB/100 rows. \`tests/import-byte-mapping.test.ts\` uses signed synthetic JWT + ephemeral Wrangler D1 \`remoteBindings:false,persist:false\` for new byte route, Japanese records, muscle, duplicates, source/hash mismatches, zero-write rejection, original text route, legacy audit status and Issue #19 guard regression. Existing 59 tests plus both required PR workflows must pass at exact HEAD; test claims only after CI results are observed.
- **Explicitly deferred:** 1 input row -> 2 targets, target-level audit, expected row count, audit v3, schema Migration, date-only reported weight, vendor real-source compatibility and remote environments. All require a separate scoped Stage 2 contract/approval; this Stage 1 PR must **not close Issue #20**.

### Review corrections to Stage 1 (#23)
- **BOM negative evidence:** `tests/csv-byte-mapping.test.ts` and `tests/import-byte-mapping.test.ts` assert that zero or one initial BOM is accepted and two/embedded BOMs are rejected with no D1 access. Explicit `ignoreBOM:true` prevents the TextDecoder from silently hiding a second BOM.
- **ECLEAR v1/v2 collision evidence:** `tests/import-byte-mapping.test.ts` covers both insertion orders (missing to measured muscle, measured to missing), same-file conflicting variants, existing-value preservation, replay/idempotence, no additional job/audit, and a synthetic race inserted after preflight but before D1.batch. New `409 ECLEAR_MEASUREMENT_VARIANT` is safe to expose (no personal value or fingerprint) and never authorizes overwrite.
- **Remaining uncertainty:** different weight/fat for one timestamp, cross-source identity, reconciliation/enrichment of old records and real vendor CSV remain outside this Stage 1 scope and require separately approved acceptance before any automatic merge policy. CI claims must be verified on latest HEAD.
