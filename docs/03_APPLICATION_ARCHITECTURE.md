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
