# Application Architecture — ライフログ（仮）

## 1. 文書目的
アプリ内部の責務とデータ処理の正本。実装は未着手、以下は提案設計。

## 2. Logical Architecture
UI (React) → Use cases → pure analysis / domain rules → secured Worker API → D1 repository。
CSV parse/previewはBrowser責務だが、最終検証と書込みはWorkerで実施する。

## 3. Component Responsibilities
| ID | Component | Responsibility | Must Not Do |
| --- | --- | --- | --- |
| APP-001 | Today & Plan UI | 体重進捗・今日の記録・実験中の次の一手 | データ品質を推測で補う |
| APP-002 | Historical Analysis | 減量期／増量期を比較し根拠と欠測を提示 | 相関から因果を断定 |
| APP-003 | Hypothesis & Experiment | 行動目標、期間、評価指標、本人判断の管理 | 自動診断／自動判断確定 |
| APP-004 | CSV Preview | 列対応・型確認・警告・確認UI | 本人の確定前に書込 |
| APP-005 | Secured API | Access identity検証、所有者認可、入力再検証 | 未認証でDBアクセス |
| APP-006 | D1 Adapter | 冪等取込・測定・日別記録・実験の永続化 | 他アプリD1への接続 |

## 4. Dependency Rules
Domainはブラウザ/SQL/外部APIに依存しない。Workerでは本人認可確認後にDB処理。UIでの可否判断だけで認可を完了しない。循環依存禁止。

## 5. Routing / Screen Composition
| ID | Screen | Purpose | Main Actions |
| --- | --- | --- | --- |
| UI-001 | 今日・次の一手 | 直近体重・計画・簡易記録 | +1、訂正、計画確認 |
| UI-002 | 過去分析 | 増減期間と行動指標の比較 | 期間選択・根拠確認 |
| UI-003 | 仮説・検証 | 介入目標・比較期間の記録 | 計画・振り返り |
| UI-004 | 履歴・データ管理 | カレンダー、CSV取込・出力 | 取込プレビュー・確定・出力 |

## 6. State Management
- D1が本人の測定・生活・仮説・実験の正本。
- Browser内のCSVプレビュー状態は一時情報、取込の確定前は保存しない。
- 実健康データをservice workerやlocalStorageに恒久保存しない。
- 認証状態はAccessとWorkerの検証結果に従い、古いSessionはfail-closed。

## 7. Runtime Sequence
1. BrowserがUIを開く → 認証 → 本人allowlist → 認可済API。
2. CSV選択 → Browser検査とプレビュー → 本人確定 → APIバッチ再検証 → D1冪等保存 → 結果。
3. 既存記録比較 → 日付・出典・欠測を揃える → 支持／反証・不確実性の表示 → 本人が行動を選ぶ。

## 8. Data Model (planned)
| ID | Model | Key Fields | Persistence |
| --- | --- | --- | --- |
| DATA-001 | body_measurements | timestamp, weight, fat, source, quality flags | D1 |
| DATA-002 | lifestyle_days | day, meals, drinking_presence, notes | D1 |
| DATA-003 | drink_entries / outings | timestamp, category, quantity / session | D1 |
| DATA-004 | activity_daily | day, steps, source | D1 |
| DATA-005 | import_jobs / audit | hash, original source, result | D1 |
| DATA-006 | analysis_periods | period, metric, coverage, evidence | D1 |
| DATA-007 | behavior_hypotheses / experiments | hypothesis, action, baseline, outcome | D1 |

## 9. Interfaces
| ID | Interface | Direction | Contract |
| --- | --- | --- | --- |
| IF-API-001 | Record CRUD | Browser → Worker | authenticated, authorized, validated |
| IF-API-002 | CSV batch import | Browser → Worker | preview/confirm, idempotence |
| IF-API-003 | Analysis/experiments | Browser → Worker | results include coverage and uncertainty |

## 10. Error Handling
入力不正は検証エラー、欠測は不明、外部エラーは失敗と表示。失敗時に0を返して隠さない。再送で二重登録しない。

## 11. Identity / Session Boundary
External identity、Application user、Sessionを分離し、失効・不一致・不明identityは拒否。本人専用としownerの認可をサーバー側で行う。詳細のCookie/Access JWT methodはTBD。

## 11.1 First local vertical slice (#5)
- `src/client/App.tsx`: minimal React read-only Today screen; `/api/summary` fetch is no-store and missing weight renders as no record, not 0kg.
- `src/worker/auth.ts`: validates issuer/audience/RS256 signature/expiry and exact owner allowlist using Cloudflare Access JWKS; direct spoofable identity headers are never trusted. Missing config is always denied.
- `src/worker/index.ts`: every static and API path is authenticated before `ASSETS.fetch` or D1. No write routes.
- `src/worker/summary.ts`: owner-scoped parameterized D1 SELECT.
- `src/shared/legacy.ts`: converts legacy drinking 0→(no,0), 1→(yes,unknown cups), blank→(unknown,unknown cups); preview dedupe uses source identity or reliable cross-file fingerprint. D1 constraints protect row and fingerprint uniqueness.
- Body measurements preserve multiple readings on one day; activity sources are separate and never summed implicitly. Imported data itself is not processed by any API in this Issue.
- Unit tests use synthetic JWT signing and injection, not live credentials or Cloudflare resources.

## 12. Operational Boundary
本Issueは設計とCloudflare開発D1 Bindingの準備まで。実際のWorker / Schema / APIは後続Issueで実装する。

## 11.2 Synthetic CSV preview/confirm (#11)
- Canonical synthetic-only UTF-8 headers: lifestyle `local_day,drinking_presence,drink_cups,steps`; ECLEAR `measured_at,weight_kg,body_fat_pct`. Real vendor mapping remains TBD pending sample and Human approval.
- Browser previews transient CSV, row errors and explicit confirm; Worker re-parses, checks hash and authenticated owner, rejects invalid batch; no DB read/write on preview.
- Existing D1 schema, no remote Migration. A single D1 batch atomically writes owner, job and rows. File hash enforces same-file idempotence; trusted ECLEAR timestamp+measurements fingerprint handles cross-file duplicates; lifestyle day+source uniqueness applies.
- Lifestyle conflict policy: compare every existing source's owner/day values with NULL-safe SQLite `IS NOT`, including unknown versus explicit zero. If any value differs, return 409 `LIFESTYLE_CONFLICT` with day and changed fields; do not write an import job or any rows. Equal values from another file/source are skipped, not duplicated.
- Prevent concurrent check-then-write races by revalidating all lifestyle rows inside the atomic `import_jobs` insert with a `CASE` status guard. The existing `status` CHECK constraint rejects the reserved invalid `conflict` status, aborting the entire D1 batch. After rollback, return an explicit 409 upon re-reading the conflict.
- D1 batch SQL error must roll back *all* job/row writes, including mid-batch failure; failed confirmation can retry safely. The actual ephemeral Wrangler D1 integration suite executes migration SQL in a local workerd D1 proxy (`persist:false`, `remoteBindings:false`) and tests persistent state after conflict, rollback and retry. Existing imported file returns already_imported.
- No real data, Access live UAT, remote D1 or deployment in Issue #11.

## 11.3 Per-row import audit and explicit conflict resolution (Issue #13)
- Existing `import_row_audit`: every accepted CSV row is inserted **in the same local D1 transactional batch** as its destination record and `import_jobs` row. SQL classifies observed destination state as `inserted`, `skipped`, or `conflict`, with error_code `LIFESTYLE_CONFLICT_KEPT` for explicit conflict skips. Rejected/unconfirmed previews do **not** write jobs or audit rows.
- Initial lifestyle conflict returns 409 with day, differing fields and a reviewToken tied to owner + raw CSV digest + complete existing per-day source/key/value snapshot. UI offers Cancel or Keep existing conflicting rows and import others; no replacement. Confirmation carries exact token; stale owner/CSV/DB snapshots return `REVIEW_STALE` and require new review.
- All preflight owner/day snapshots are revalidated in the **same transaction** as job, destination rows and audit inserts: each date's expected row count and every stored source/key/NULL-safe value must match. Stale snapshots produce an invalid job status rejected by existing `import_jobs.status` CHECK; atomic rollback covers rows and audit. No Migration.
- Conflict resolution creates a `partial` job. Both `confirmed` and `partial` are idempotent by owner/source/file hash. The original per-row audit persists; retry creates none. Matching duplicate records are skipped, not double-counted.
- User choice in UI is not authorization. Worker-first signed Cloudflare Access issuer/audience/owner verification remains mandatory. No real CSV files, remote D1, Access, Preview/Production or main merge in this Issue.

## 11.4 Audit compatibility and no historical fabrication (#13)

- The pre-audit job marker `csv:<source>` is preserved for recognition only; audited-v2 jobs write `csv:audited-v2:<source>` to `import_jobs.source_id`. The destination's `source_id` is not changed.
- Confirmed legacy jobs with no audit replays are no-op, marked `auditStatus=legacy_unavailable`; no original row results are guessed. Audited jobs missing all or part of their audit fail closed, and legacy partial jobs without audit are not treated as successful.

## Audit history read-only slice (#17)
GET /api/import/history and /api/import/history/:jobId are gated by signed Access owner identity before DB access. Owner-bound SQL returns bounded keyset pages (max 25), no raw CSV, file hashes, source keys or owner selectors. Legacy zero-audit jobs are explicitly unavailable. Inserted rows may show persisted NULL vs 0; skipped/conflicted rows never fabricate original values. No migrations or remote changes.

Both list and detail now reconcile owner-scoped destination row count with recorded inserted audit outcomes. Any mismatch is labeled incomplete, and unverified detail summary counts are null. This detects missing inserted audits while destination rows remain. Legacy confirmed zero-audit jobs still read legacy_unavailable. Missing skipped/conflict audit records cannot be proven without an original expected-row count.

## Issue #19 — Fail-closed local CSV confirmation boundary (Draft PR)
- `POST /api/import/confirm` retains the signed Cloudflare Access JWT owner verification performed by `src/worker/index.ts` **before** inspecting the DB, any assets or request payload. A caller-supplied identity header, query parameter or form value cannot authorize writes.
- A separate **runtime-only** `IMPORT_LOCAL_ONLY === "true"` flag is required for the confirmation route; missing, false, mixed-case or other strings fail closed with HTTP 403 (`LOCAL_IMPORT_DISABLED`). This flag must be provided **only** in a trusted loopback-local development environment; it is deliberately absent from `wrangler.jsonc`, GitHub Actions secrets and all remote Worker configurations.
- The exact request URL hostname must be `localhost`, `127.0.0.1`, or `[::1]` (strict literal allowlist). `Origin` is mandatory and must equal `new URL(request.url).origin`; `Sec-Fetch-Site` may be absent or `same-origin`, never `cross-site` or `same-site`. Only HTTP(S) POST is considered. Host/Origin can be spoofed by non-browser clients and **do not** make a public deployment safe: never enable the runtime opt-in on a deployed Worker.
- On denial, the confirm route does not invoke `handleImport` or any D1 `prepare`/`batch` operation; signed-identity denial still occurs first. `/api/import/preview` remains read-only and gated by signed identity but **does not require** the write opt-in. Non-POST confirm requests return 405 with `Allow: POST`.
- The original CSV parser, review token, stale conflict handling, transactional row+audit batch, idempotence, legacy audit compatibility, `NULL` vs `0` and read-only history paths are unchanged. No schema migration, GitHub CI workflow, remote D1, Access, Secret, or deployment changes in this Issue.
- Synthetic regression uses a real ephemeral local Wrangler D1 (`remoteBindings:false`, `persist:false`) and locally signed test JWTs; all denial cases assert zero D1 calls. This is not evidence of live Cloudflare Access/remote D1 acceptance.


## Issue #25 — MVP-α weight trend read-only slice (Draft)
- `GET /api/weight/trend?from=YYYY-MM-DD&to=YYYY-MM-DD` is reached only after Worker-first signed Cloudflare Access owner verification. No anonymous assets/API fallback. Only GET; default last 30 JST days; both date params required together, max 366 calendar days, reject unknown/duplicate parameters.
- Read-only owner-bound D1 SELECT uses `unixepoch(measured_at)` with UTC boundaries for JST calendar dates, includes six prior days for 7-day average, and LIMIT 2001 (422 on overflow, no silent truncation). No raw source ID, fingerprint, owner ID or CSV contents in response. Errors are 400/405/422/503 with no-store.
- Daily representative is latest valid measured weight per JST date; same timestamp tie-break by ID. Exclude flagged anomalies, NULL/invalid weight and reported/estimated source. Preserve original measurement timestamp and label only as measured; never fabricate 0 for missing days.
- Seven-calendar-day average uses valid daily representative weights and is displayed only if at least four measured days in window; count n/7 remains visible for incomplete windows. Six-day prefetch is read-only and does not inflate the requested measured-day count.
- React SVG plot shows gaps, accessible text table, date selectors and editable UI-only goal 75–76kg. No goal persistence, new dependency, Migration or remote Cloudflare change. Actual Android device UAT remains Issue #31; this Draft alone is not evidence of live Access.


### User-selected chart granularity (MVP-α follow-up, 2026-11-06)
- The authenticated GET API and its maximum **366 JST calendar days** are unchanged. The React UI can switch between **日 / 週 / 月** without extra D1 endpoints or migrations. Each switch sets a transparent date interval: day=last 30 days, week=12 Monday-based weeks including the current incomplete week, month=12 calendar months including the current incomplete month. Date inputs remain editable; custom ranges may cover fewer/more periods within the 366-day bound.
- Daily mode shows the original observed daily representative and 7-day moving average (minimum 4 observed days). Weekly and monthly modes compute the mean of **one already-validated daily representative per actually observed day**; unrecorded days, weeks and months remain missing, never zero or interpolated. Counts show `observedDays/calendarDaysInRequestedInterval`, including partial edge weeks/months; a single-observation mean is expressly a reference value, not high-coverage evidence.
- Mobile display: 390px Chromium test harness verified 12 calendar-month averages fit a chart region of 312px without chart/page horizontal scrolling, while 12 weeks and 30 days retain keyboard-accessible horizontal scroll. Per-period table shows year/month or week label, exact measured-day count, and missing periods; SVG points carry accessible value/count labels.
- Browser evidence is from the **exact source Git Blob** for the UI, shared aggregation, and CSS, bundled with a **React16 compatibility harness and mocked synthetic API** rather than production React19 / Worker JWT / D1 / real Android. The real local-D1/JWT and CI tests remain separate; live Cloudflare/Android acceptance remains unverified.

#### Fixed MVP-α viewing blocks (current approved behavior, 2026-11-06)
- The present presets are **日 30 consecutive JST days**, **週 12 Monday-first calendar weeks**, **月 12 calendar months**, always ending at the present JST date for the latest incomplete week/month. The former day-90/week-26 presets are superseded.
- Manual start/end selections remain available but are constrained to **at most 30 days / 12 distinct Monday weeks / 12 distinct calendar months**, never beyond JST today, and always within the read-only API's 366-day upper bound. The API itself rejects future ranges.
- Previous/next navigation moves by the displayed number of days/weeks/months, across year and leap boundaries. It never invents future days; "最新へ" resets to the current preset. No writes or alteration of original timestamps. Monthly 12 points and the per-month measured-day table fit a 390px Chromium viewport without horizontal page or chart scrolling.
- The local Chromium check uses an exact-Blob React UI/CSS/shared-code mirror with synthetic fetch and a React16 compatibility adapter. This checks layout and controls, not full production React19 / Worker Access / Android; those require separate integration evidence.


### Issue #29 — manual-entry local-only vertical slice (2026-11-07)
- New authenticated owner-only `GET /api/manual/records` returns only the selected owner's **manual** weight timestamps and daily steps, bounded to 31 JST calendar days / 500 records, no-store. CSV rows are never exposed as editable manual rows.
- `POST/PATCH/DELETE /api/manual/weight` requires a true measured JST datetime (not a fabricated midnight), positive valid weight, UUID idempotency key, and only permits updates/deletes to `source_id=manual:weight`. `POST/PUT/DELETE /api/manual/steps` maintains one row per JST day in existing `activity_daily`; 0 steps differs from missing. A same-day non-manual activity or lifestyle step entry blocks writes with 409, never auto-overwriting CSV sources. Optimistic old-step checks detect stale edits.
- Every manual mutation first passes the existing **signed Access JWT + owner allowlist** and then independent trusted `MANUAL_ENTRY_LOCAL_ONLY=true` plus exact loopback URL and matching Origin/Fetch-Site. The runtime flag is not added to `wrangler.jsonc` or deployment configuration. `IMPORT_LOCAL_ONLY` stays separate and unchanged.
- Small-screen `ManualEntry` provides weight/time and date/steps forms plus edit/cancel for recent manual records, with messages only after server confirmation. On success `App` reloads its latest summary and remounts the read-only weight-trend view.
- Scope is a Draft branch only. Actual Cloudflare Access, deployed Worker and remote D1 writes, Preview/Production and personal-health data remain forbidden/unverified. No schema migration or new dependency. More complete Android acceptance remains Issue #31.


### Issue #29 — independent UAT write gate and conflict recovery (2026-11-07)
- **No Cloudflare configuration has been changed.** Current remote deployments (if any) are not enabled for manual writes. This Draft adds a dormant UAT-only policy: `MANUAL_REMOTE_WRITE_ENABLED=true`, `MANUAL_REMOTE_TARGET=uat`, and a trusted exact HTTPS `MANUAL_REMOTE_ORIGIN` must all be deliberately provisioned later under independent approval. The Worker still verifies Cloudflare Access JWT signature/issuer/audience/expiry and the one allowed owner **before any API or asset access**. This remote gate does not accept the local write flag `MANUAL_ENTRY_LOCAL_ONLY`; the CSV confirm flag is completely separate. There is no production mode.
- Remote writes additionally require the browser's exact Origin equal to the configured HTTPS origin and request origin, `Sec-Fetch-Site: same-origin`, JSON content type, and `X-Life-Log-Intent: manual-write-v1` custom header. The value is an **intent marker, not a shared secret or substitute for JWT**. Rejected cross-site/missing-header requests are denied before preparing any D1 query; do not add permissive CORS. Requests without Fetch Metadata fail closed in UAT.
- Weight PATCH/DELETE now use an atomic SQL compare-and-swap on source/owner/key **and the last observed measured_at + weight_kg**, with D1 affected-row verification. Step PUT/DELETE likewise reject 0-change stale edits. The client sends expected values derived only from the selected manual-history row. A lost response is not interpreted as a success: the UI reloads the authoritative history so the user can assess whether to retry. UUID-based weight POST and same-day steps POST remain replay-safe; no automatic second mutation.
- Release gate remains separate: provision an **isolated** UAT D1, approved exact HTTPS host, Access protection of **all** assets/API routes, configured secrets/bindings and audited backup/rollback before any remote write test. Verify actual Android Chrome and deployed Worker independently. A passing signed synthetic JWT + local D1/Chromium test is **not** proof of real Cloudflare Access policy or a deployed host. Production write enablement requires a future explicit design/approval.


## ECLEAR seven-field enrichment (Stage 2B; synthetic local D1 only)

The authenticated Worker exposes separate `POST /api/eclear/enrichment/preview` and
`POST /api/eclear/enrichment/confirm`. Neither endpoint is connected to the
existing v1 CSV import contract. Both are **disabled** unless the trusted
loopback-local Worker has `ECLEAR_ENRICHMENT_LOCAL_ONLY=true` and a distinct,
high-entropy `ECLEAR_ENRICHMENT_REVIEW_KEY` (minimum 32 UTF-8 bytes).
These settings **must not** be configured in UAT or Production. A matching
same-origin `Origin`, `Sec-Fetch-Site`, JSON content type and custom
`X-Life-Log-Intent: eclear-enrichment-v2` are required after signed Owner auth.
A remote Worker intentionally returns 403. No remote D1 migration is approved.

The client decodes official ECLEAR CP932/Shift_JIS bytes before submission; the
Worker re-parses the official ten columns. Each request is limited to 40 rows
and 64 KiB of UTF-8 CSV. Read-only preview uses the owner-scoped Stage 2A
classifier and computes a private snapshot digest of the complete incoming
seven values and the bounded owner measurement records. A five-minute HMAC
review token binds owner, CSV hash, snapshot and expiry. The token contains no
raw measurement values. Confirm independently re-reads and revalidates the
current snapshot, then executes all guarded checks, NULL-only UPDATE/new
INSERT, row/cell audit and final count assertions in a single D1 `batch()`
transaction. Failed assertions cause CHECK constraint failures and rollback.

The local-only migration `0005_eclear_enrichment_audit.sql` introduces separate
`eclear_enrichment_jobs`, `eclear_enrichment_row_audit` and
`eclear_enrichment_cell_audit`. The old `import_jobs` and `import_row_audit`
remain immutable. Existing measurement IDs, timestamps, provenance,
fingerprints, body weight, fat percentage and original job associations are
preserved when filling missing cells. New exact timestamps use the historical
ECLEAR v1 fingerprint; date-only ambiguities are treated as conflicts.
Duplicate file submissions with no new cells return unchanged without new
audit jobs. Conflict rows block the entire submitted chunk until re-reviewed.

No Android UI or real-UAT data operation is part of Stage 2B; Stage 2C is
tracked separately in Issue #142. Do not claim remote applicability from
local unit tests or a successful Draft PR CI.

## MVP-M07 — registered action experiment evidence (Issue #201)

- `GET /api/mvp/experiments/evidence?id=<UUID>` is read-only; existing Worker signed-owner/passkey session authorization remains mandatory **before** database access. The experiment lookup binds both `id` and `owner_id` and another Owner's id is indistinguishable from missing.
- Baseline and intervention use the **same observed JST calendar day count**. For a started plan, intervention is from its saved `starts_on` through `min(ends_on,today JST)`. Baseline is the same number of days ending immediately before `starts_on`. They never overlap. A plan not yet started returns `not_started` with null evidence: future measurements are not invented. A running plan is expressly marked `in_progress` (not the outcome of its future full duration).
- Both periods reuse M02/M03 representative-day aggregation and the canonical source precedence: ECLEAR for body weight, Google Fit for steps; other sources cannot masquerade as canonical historical records, and missing days are not zero. An old `drinking_presence=1` never implies a 1-cup drink.
- Each period's **trailing 7-calendar-day weight mean** requires a full seven-day observed calendar window and at least **4 separate measured days**. Otherwise the mean is `null`, with `observedDays` and `windowDays` reported so a one-day reading cannot be called a trend. This follows the existing REQ-003/MVP-α 4/7 threshold and does not impute missing days.
- UI displays the two dated windows, their first/last measured weight and coverage, 7-day mean and sufficiency, mean steps and source, drinking yes/no/unknown days, recorded cups and unknown/observed coverage, outings and meals. Read-only values are **observational evidence, not a causal effect estimate**; the user's saved `continue/revise/stop/unknown` decision is never auto-generated or modified.
- No new table, migration, cache, client permanent record, Cloudflare variable, authorization exception or automatic data upload. Android touch acceptance and richer plan modification remain separate from synthetic desktop/390px Chromium tests.

## Japanese lifestyle CSV single-target adapter (Issue #205, parent #20)

- Android browser decodes original bytes using the existing strictly fatal UTF-8/Shift_JIS decoder (optional UTF-8 BOM); the local form selects a source by **strict, unambiguous headers**, never by the filename. Japanese lifestyle requires \`日付\` and \`飲酒\`; it may include \`歩数\`, \`体重_kg\`, \`測定時刻\` in any order. Duplicate, mixed English/Japanese, or unknown header names are rejected before the confirmation button is enabled.
- This **single-target slice** maps 1 input source row to exactly 1 canonical \`lifestyle_days\` row (\`local_day,drinking_presence,drink_cups,steps\`). \`飲酒=1\` means drinking is observed but cups unknown, \`飲酒=0\` means explicitly sober with 0 cups, and blank means entirely unknown. \`歩数=0\` is an observed zero, blank is missing. Date validation must reject nonexistent calendar dates and duplicate days even across upload partitions.
- If optional \`体重_kg\` **or** \`測定時刻\` contains a nonempty value, the *entire file* is rejected before preview/import: the two-target fanout and date-time/precision contract have not been approved. No destination, field or timestamp is ever silently discarded or invented.
- Validated canonical chunks are re-parsed by the existing Worker on explicit Owner confirmation, with signed identity, same-origin write gate, original \`csv:audited-v2:lifestyle\` one-to-one row-audit convention, atomic batch and keep-existing conflict/replay behavior. Audit history may compare inserted destination count to inserted source-row audit count **only while** exactly one destination is written per row. Synthetic D1 tests must show a healthy audit marked available and an intentionally deleted inserted audit marked incomplete.
- The original file is decoded **on the device** and normalized/partitioned before Worker submission. The Worker hashes canonical chunk text; it does not receive nor attest the original source byte SHA-256. This distinction does not fulfill #23's literal raw-byte hash contract. A later two-target/audit-v3 stage requires a new explicit per-target cardinality and migration design before any remote rollout. Neither raw personal CSV nor private memo fields belong in GitHub tests, logs or URL parameters.

## Original UTF-8 source-byte provenance (Issue #209, bounded Stage 1 of #23)

- The **existing** Owner-authorized canonical CSV import remains the durable idempotence identity: \`import_jobs.file_sha256\` is always SHA-256 of the canonical UTF-8 chunk, not of the original file. Never replace it with raw-file hash, since changing BOM/CRLF must not duplicate measurements.
- For an original, **strict UTF-8** (fatal decoder) CSV of <=65536 bytes whose validation produces **exactly one canonical chunk**, the browser may submit \`originalBase64\` and \`originalSha256\` alongside the normal canonical \`csv\` and \`hash\`. Base64 is canonical (no whitespace/URL alphabet), hash matches the **unaltered bytes**, and the Worker independently re-normalizes the original and checks its only canonical chunk is identical to the submitted \`csv\`. Optional UTF-8 BOM and CRLF remain part of the verified original hash. Malformed UTF-8, UTF-16, invalid base64, source/header mismatch, multi-chunk or normalized mismatch are rejected before any D1 query/write.
- On the **first successful job**, the Worker persists an appended \`:raw-utf8-sha256:<64 lowercase hex>\` suffix to that job's existing \`csv:audited-v2:<source>\` marker in \`import_jobs.source_id\`; Owner-only audit-history pages may expose that SHA-256 to verify its source bytes. No new schema/Remote D1 Migration, no raw content stored, no actual CSV, private memo or source keys in API/history. The source marker does not replace the existing canonical \`file_sha256\` or any destination source ID.
- A later upload that produces an **identical canonical chunk** but different original encoding/BOM/newline must not create another job, overwrite its original proof or falsely claim the later bytes were recorded. A replay explicitly distinguishes a matching stored proof from a different/missing stored proof.
- A source file requiring partitioned upload, or original Shift_JIS/CP932 bytes, retains the current normalized canonical import **without** an original-byte proof. The UI must not present a verified original-byte hash for those cases. This bounded Stage 1 is not a claim of full original-file provenance or Stage 2 multi-target audit completion.
- Original file bytes remain transient in browser memory and the authenticated Worker request, are never logged, and the existing **local-only** confirmation route is not enabled on UAT/prod.

## CSV target audit v3 / date-only lifestyle weight (Issue #211, parent #20)

- New canonical source \`lifestyle_weight\`: required \`local_day,drinking_presence,drink_cups,steps,weight_kg\`. Device-side strict Japanese \`日付\` + \`飲酒\`, optional \`歩数\` + \`体重_kg\` in arbitrary order is accepted as two-target input only when at least one weight value is present; all-empty weight columns stay the earlier one-target \`lifestyle\` contract. Nonempty \`測定時刻\` is **rejected**, not silently ignored. All original-byte proof rules from #209 apply only to bounded, single-chunk verified UTF-8.
- Each input row always has one \`lifestyle_days\` target. An explicit nonblank \`体重_kg\` adds a second target in \`body_measurements\`, with \`measured_at=YYYY-MM-DD\`, \`source_kind=reported\`, \`source_timezone=Asia/Tokyo\`; the application MUST NOT fabricate a clock or claim a measured-device ECLEAR reading. A pre-existing body-weight observation for that owner/JST calendar day makes the optional weight target \`skipped\`, **never overwritten**. Existing ECLEAR source priority and the separate \`weight_day\` path remain intact.
- New additive-only \`migrations/0006_csv_target_audit_v3.sql\` adds (1) \`import_job_target_manifest\` with exact expected source row count and expected target count and (2) \`import_target_audit\` with an independently classified outcome per source row **and target type**, including attempted/inserted/skipped/conflict. Neither existing user row nor existing table may be modified by the migration. There is no backfill, no rewrite of v2 history or reclassification of legacy jobs.
- A v3 job's D1 \`batch\` must atomically insert the existing \`import_jobs\` row, manifest, one existing source-row audit, the mandatory lifestyle target audit and optional weight target audit, and all destination records. Target-audit \`inserted\` count must match the actual persisted destinations linked to that job, independently of the existing source-row-audit count. The manifest expected source/target counts detect deletion of an audit row (including skipped targets); loss of an inserted destination is additionally detected via the linked destination count. A v3 job is \`incomplete\` if any check fails, and is NEVER silently backfilled.
- \`import_row_audit\` remains one result per input source row for backwards-compatible summary and history. v3 target audit offers its own outcomes; old \`csv:audited-v2\` and truly pre-audit \`csv:<source>\` jobs keep their original semantics. After input validation and Owner authentication, the \`lifestyle\` day snapshot race guard remains effective. Batch exception or a stale review token fails closed and rolls back every inserted target, manifest and audit.
- \`GET /api/import/history\` remains Owner-scoped, paginated and \`no-store\`. v3 history reports target-audit status/counts without exposing raw CSV rows, owner IDs, original memo values or internal source keys. Old v2/legacy jobs are not retroactively rewritten.
- **Deployment distinction:** the UAT Worker may contain this new code while its existing CSV confirm guard remains localhost-only; UAT does not accept remote personal uploads. Applying a new remote D1 Migration requires a separate strict SQL provenance checksum, metadata-only preflight, unchanged existing-data proof and single-use deployment gate. If these cannot be verified, do not perform the Remote D1 Migration or claim physical Android import acceptance.


## Issue #227 — personal alcohol estimates, editable tequila and distinct evidence

For a personal low-friction workflow, the normal drink action requires kind, integer 1–50 cups and an observed JST time; original \`volume_ml\` and \`abv_pct\` columns remain **nullable** and are never overwritten by preset values. The volume/ABV fields remain optional in a collapsed detail panel. Existing rows, including size-only historical rows, must remain unchanged.

Known fixed **personal assumptions** (\`personal-2026-11-15-v1\`, not manufacturer averages):
- highball (restaurant), green-tea highball, lemon sour: 250 ml actual liquid × 5% = 10 g ethanol per cup;
- beer: 350 ml × 5% = 14 g per cup;
- tequila shot: 30 ml × 40% = 9.6 g per shot;
- Japanese sake: 100 ml × 15% = 12 g; wine: 120 ml × 12% = 11.52 g; straight shochu: 60 ml × 25% = 12 g, each explicitly provisional rather than the mixed-drink 5%;
- other alcohol: **unknown** without entered numbers; non-alcohol: exactly 0 g.
Formula: cups × actual liquid ml per cup × ABV percent / 100 × 0.8 g/ml. Missing entered component can be filled from personal estimate but is **always labeled estimated**; both provided numerical inputs yield “entered-values calculation”, not proof of an actual manufacturer measurement. Do not imply estimates are clinically safe exposure levels. Preserve null separately from 0; expose estimate provenance and version in compare/CSV.

The v0001-v0006 D1 schema is immutable for this iteration. Existing CHECK constraints permit the legacy kind \`other_alcohol\` but its \`drink_variant\` permits only \`beer\`. To avoid remote migration and any existing-data rewrite, new controlled subtypes are persisted as an explicit, allowlisted \`source_id\` discriminator (for example \`manual:drink:tequila_shot\`), while keeping \`drink_kind=other_alcohol\` as the backward-compatible base class, original \`source_row_key\` UUID, and immutable record id. This source identifier denotes a **manual drink type subsource**, not an external measurement provenance. Owner-only queries accept only \`manual:drink\` and enumerated subtype IDs; updates can move a record between subtypes and compare the exact original source_id to prevent lost updates. Unknown/free-text values never become SQL identifiers. Old beer remains represented by \`drink_variant=beer\`; do not infer tequila from 30ml/40%. Repeated UUIDs across sources fail closed rather than duplicate. Existing signed Owner authentication, CSRF intent, write policy and Worker scope remain unchanged.

A future normalized drink-kind schema may replace this bounded compatibility encoding via its own additive migration, but the current user-visible kind must round-trip through GET, correction, cancellation and CSV. Neither real user records nor UAT D1 data are accessed in tests.


## Read-only observation-quality metrics (Issue #229)

- GET /api/mvp/metrics (optional asOf=YYYY-MM-DD) is routed behind the existing signed Owner/passkey gate, with no write permission or new storage. Invalid/duplicate query keys, future dates and excessively old dates are rejected before querying D1. Queries bind Owner and a maximum 28-day JST window; LIMIT 10001 fails closed rather than treating truncated data as complete. Responses are private, no-store. No actual personal data is seeded by the app, tests or release.
- Windows 7/14/28 calendar days are derived in memory and all report their observation denominators. Missing data is null/missingDays, not observed zero. For weight, at most one non-anomalous measured row per JST day is used; ECLEAR precedes manual and legacy/reported/unsupported records do not silently substitute. A qualified 7-day weight average requires at least 4 separate measured days. Short-term and monthly summaries are observations, not predictive or causal claims.
- Google Fit steps precede manual steps, never added together on the same day. An observed 0 step count is real, not missing. Imported lifestyle CSV step values are not silently promoted into canonical Fit data.
- Every available ECLEAR body-composition column is returned with per-field observed-day counts: weight (kg), body-fat (%), skeletal-muscle (%), device BMI, visceral-fat level, bone mass (kg), basal metabolism (kcal). Estimated fat mass = weight×fat%/100, skeletal-muscle mass = weight×skeletal-muscle%/100, fat-free mass = weight×(1-fat%/100). These values remain consumer BIA-derived estimates. Values are never merged from different sources/measurements on the same day. Without a stored/configured height, calculated BMI and FMI are null, not fabricated.
- Alcohol observations retain separately entered-value calculated grams, personal-profile estimated grams, unknown alcoholic cups, and separately recorded nonalcoholic cups. The personal personal-2026-11-15-v1 assumptions are explicitly provisional; missing drink entries do not mean abstinence, and explicitly reported sober days differ from unknown days. This read-only projection does not change historical drink rows or permanently freeze/persist a new profile; downstream analyses must carry the version and this limitation.
- Synthetic ephemeral Wrangler local D1 tests cover Owner isolation, zero-vs-missing, same-day ECLEAR/Google Fit priority, BIA field/derived precision and tequila shot assumptions. Remote D1 data, UAT real Owner records, schema migrations, Secrets/vars and production are outside this implementation. #228 will consume the shared observed-only inputs for lag comparison; #230 supplies an appropriate mobile visualization.


## Non-overlapping weekly lag evidence (Issue #228)

- GET /api/mvp/lag (optional asOf=YYYY-MM-DD) is a read-only signed Owner/passkey route. Only the latest 12 **completed** Monday–Sunday JST weeks are included; a selected/current Sunday itself is conservatively omitted until the following day. Four time offsets are not fabricated: the explicitly explored prior intervals are 1, 2 and 4 whole weeks. A bounded 84-day SQL window is Owner-filtered, GET only and fails closed on large/invalid input. No user-row writes or new storage.
- Every week is computed using #229's shared canonical source precedence and its separate 7-day observation denominators. Weight weekly means require at least 4 measured JST days, and predictor walking and reported drinking weeks each require at least 4 observed days; missing days never become 0. Alcohol weeks with unknown alcoholic cups are excluded from grams-based comparisons. Entered-derived and provisional personal-estimate grams remain differentiated, with the assumption version disclosed.
- A lag pair compares the *difference in observed weekly weight means* between the target week and the immediately preceding **different** week, against the change in the preceding weekly step average or recorded alcohol grams versus the predictor's earlier week. The included input week and outcome week do not overlap. Adjacent comparisons are serially correlated and multiple lag hypotheses are exploratory; they must not be sold as independent experiments.
- Results retain both supportive and counter-direction examples. The descriptive label is suppressed until at least six comparable week-pairs and six non-flat signs are observed; even then a 75% same-direction rule is only an explicitly disclosed heuristic, **not** statistical significance, a p-value, causal attribution, a medical conclusion or a kilogram forecast. With missing data, results remain undetermined and display the exact support/counter/flat and paired counts.
- Synthetic local D1 and pure tests cover 1/2/4-week window boundaries, fit/ECLEAR evidence via the #229 shared analyzer, negative/missing data, opposite-direction counterexamples, signed-Owner routing, and GET-only semantics. Real Owner data is never migrated or rewritten.


## #251 Phase 1 — observational hypothesis dashboard
- Under the existing Owner-only `#insights` route, the browser loads `GET /api/mvp/metrics` and `GET /api/mvp/lag` with same-origin credentials and no-store; there is no write endpoint, background mutation, cache or schema change.
- The 7/14/28-day summary exposes actual observed coverage for canonical ECLEAR weight and Fit steps. Explicit 0 steps are distinct from missing; a date without a drink record is not a confirmed non-drinking day. Alcohol values separate entered-value calculation, personal 5%/40% estimation, and unquantifiable cups.
- Completed non-overlapping JST weeks are graphed with gaps at missing values. Each chart shows its own observed min/max; the expandable evidence table shows source window and daily coverage. No future or missing outcomes are extrapolated.
- H1 displays 1/2/4-week *descriptive sign-count* support/counter/hold from #228; at least six valid comparisons are necessary, not sufficient for causal inference. H2 daily weight, H3 next-day same-weekday steps, H4 composition longitudinal inference, and H5 multivariate analysis remain **explicitly pending** (not falsely shown as successful). Parent #230 stays open.
- Synthetic 390px Chromium checks exact source separation, missingness, H1 evidence and all H1–H5 labels. Existing passkey and Owner auth protect the endpoints. Production, actual user row changes, Secrets/vars and Remote D1 migration are out of scope.


## #255 Phase 2 — per-JST-day paired observations for H2–H4
- The existing Owner-only `/api/mvp/metrics` read path now includes at most 28 canonical daily summaries without a new SQL query or storage change. Per-day records derive from the same ECLEAR/Fit-priority maps as the 7/14/28-day summaries, not duplicated alternatives. Each day retains missing vs actual zero; drinking is yes/no/unknown and `alcoholG=null` whenever alcohol was declared but no calculable drink detail exists.
- H2 contrasts observed next-day and 2-day weight differences after explicitly known drinking vs explicitly recorded no-drinking days. It withholds a directional label unless both delays have at least four measured pairs in each group and agree beyond a 0.2kg **exploratory display threshold**; neither significance nor causality is established.
- H3 compares observed next-day steps to the non-drinking next-day baseline for the **same weekday** only, requiring two control observations per weekday and at least four valid pairs before even a descriptive sign tendency. Missing days are never controls.
- H4 shows only changes in *consumer BIA estimated* fat/muscle mass where at least three fully measured days span >=14 days. Its verdict remains pending because home-device fluctuations do not prove actual tissue changes.
- H5 remains pending because food energy intake and sleep are unmeasured confounders. The UI never labels this a fitted multivariate model. All observations, sources and uncertainty remain owner-scoped read-only; local synthetic D1 + 390px Chromium test without any Remote D1 record processing.


## #259 Phase 3 — guarded H5 two-exposure descriptive groups
- H5 is computed entirely from the already Owner-scoped, read-only canonical 28-day array. It requires both today's observed Fit steps and calculable alcohol grams (explicit drinking/no-drinking; unknown status or unquantified cups excluded), plus today's and the next contiguous JST day's observed weight.
- Split complete pairs into four groups via within-window medians: steps above vs at/below median, alcohol above vs at/below median. Require at least 12 paired days and >=3 observations in **each** of four groups. If any group is undersized, hide group mean weight changes rather than extrapolating a relationship; never regard missing as 0.
- If qualified, display the four group counts and mean *next-day* observed weight difference as descriptive evidence only. No regression, health score, treatment suggestion, p-value, causality or future-weight estimate. H5's status remains **判定保留** because dietary intake, sleep, time trend, hydration and day-to-day autocorrelation are uncontrolled.
- The read-only dashboard links to the pre-existing M07 user-directed behavior experiment section without creating or saving experiments on its own. All validations use synthetic local fixtures and the 390px browser with zero external data writes.
