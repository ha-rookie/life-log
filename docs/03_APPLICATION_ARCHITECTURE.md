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
