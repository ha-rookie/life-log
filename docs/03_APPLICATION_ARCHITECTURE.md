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


## MVP-α Issue #25 — Daily weight trend / 7-day average (Draft PR)
- New owner-only, GET-only \`/api/weight/trend\` requires signed Cloudflare Access JWT owner allowlist in the existing Worker entry point *before* any D1 work. Static assets and all other routes keep their existing owner gate; #19 CSV confirm local-only POST guard remains untouched.
- Request: either no dates (current Tokyo date and previous 89 days) or exactly \`from=YYYY-MM-DD&to=YYYY-MM-DD\`. Both parameters required together, no unknown/duplicate parameters, valid Gregorian dates 1900–2100, inclusive display range max 366 days. Method other than GET -> 405 Allow GET without DB calls. All errors private/no-store and generic.
- Query: parameterized D1 \`body_measurements\` with \`owner_id\` predicate and inclusive JST start/exclusive next JST midnight end, \`unixepoch(measured_at)\` for consistent explicit timezone-offset handling, six-day preceding fetch for a fair first seven-day window, max 2000 returned rows. 2001st row -> 422 \`RANGE_TOO_DENSE\`, never partial result.
- Domain: for each JST day, select the last eligible actual \`source_kind=measured\` with \`anomaly_flag=0\` and realistic non-null weight, tie break by \`measured_at\` instant then stable \`id\`. Do not delete or merge original same-day readings; exclude reported/estimated/flagged values from primary trend. Emit count of eligible observations, excluded observations, missing days, safe source label (ECLEAR or その他), measured timestamp. Never expose raw source ID, owner ID, row key, fingerprint or CSV content.
- Seven-day mean: rolling **calendar** seven-day window of the representative daily weights, minimum **four observed days**. The first six days of lookback are included only in calculation; they are not returned as visible days. On missing days, both observed weight and displayed average are null and the graph segments do not cross the missing date (even if previous days were observed). No missing-value zeros or interpolated measurements.
- Browser: accessible SVG graph with observed solid line/dots, dashed seven-day mean and a labelled goal band, adjacent numeric/coverage summary and expandable daily source table. Start/end date selection and goal lower/upper bounds are interactive; default 75–76kg and 2026-12-22 are *visual* planning values, editable within the view and **not persisted**. CSS contains narrow/mobile layout and horizontally scrollable detailed table. No external chart library, no health data persisted in localStorage or caches.
- Synthetic unit and ephemeral Wrangler local D1 integration tests use short-lived signed test JWTs, owner-separated mock data, invalid dates, no DB access on denied inputs, abnormal/estimated weights, JST midnight, multi-readings/tie, insufficient observations, DB outage and bounded 2000-row query. **Actual Android Chrome visual/E2E sign-off and live Access integration remain pending #31**; code-only green CI does not claim real-device acceptance.
- No new D1 migration, remote bindings, secrets, Cloudflare Access, deployment or main merge in this Issue.
