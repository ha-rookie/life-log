# System Architecture — ライフログ（仮）

## 1. 文書目的
Hosting、認証、D1、外部データ経路と環境分離の正本。

## 2. Architecture Goals
- ARCH-001: 匿名・他人から私有データへ一切アクセスさせない。
- ARCH-002: データを欠測・推定・実測・出典付きで保持し、再現可能に比較する。
- ARCH-003: Cloudflare無料枠を設計目標とし、従来アプリのD1やSecretsから独立させる。

## 3. System Context
Browser/Android Chrome → Cloudflare Access (予定) → Workers/Static Assets (予定) → D1 (開発用IDを設定予定)
CSVは本人選択後にブラウザで解析・確認し、認証済APIが再検証してD1へ分割登録。
将来の画像AI API、R2、商用公開はMVP外。

## 4. Deployment Architecture
| ID | Component | Platform | Responsibility | Production | Preview/Development |
| --- | --- | --- | --- | --- | --- |
| ARCH-010 | SPA | React/Vite + Workers Static Assets | 画面表示とCSVプレビュー | 未作成 | 未実装 |
| ARCH-011 | API | Cloudflare Workers | 認可・データ操作・分析 | 未作成 | 未実装 |
| ARCH-012 | DB | Cloudflare D1 | 個人データの正本 | 未作成・未設定 | 開発D1 IDはHuman提供・API未検証 |
| ARCH-013 | Identity Gate | Cloudflare Access | 入口保護、署名済identityの検証 | 未作成 | 未設定 |

### Environment Separation
- Development DB: life-log-dev。user-provided UUID: 421d0116-5c33-4782-a2b6-28f9684d3956。存在と名前はread-only APIで後日確認。
- Binding: DB (env.DB)、Wrangler configはBootstrap時点の接続定義のみ。
- ProductionとPreviewのD1、Worker、Access、Secrets、Hostは独立して設計・承認してから作成する。
- PreviewやProductionの設定に開発D1を自動流用しない。
- 既存mahjong-score等のDBと共用しない。

## 5. Runtime Data Flow (planned)
本人 → Access検証 → Worker認可確認 → D1で取得・保存 → 体重推移／仮説の支持・反証を表示。
未認証はUI・Static Assets・APIの全公開経路でfail-closed。CORSとCSRFは認証方式確定後に設計する。

## 6. Build / Update Data Flow
Project Bootstrap PR → Repository validation → Human merge gate。
PRでは既存のRepository validationのみを実行し、Cloudflare Secretsは一切渡さない。Human承認後のmain pushでだけGET Token VerifyとGET D1 metadataが自動実行され、遠隔DB書込・SQL・Migration・Deployは行わない（ADR-0002）。
CSV取込は将来ブラウザで前処理し、Workerが再検証と冪等性を担う。

## 7. External Dependencies
| ID | Service | Purpose | Runtime Dependency | Auth | Failure Behavior |
| --- | --- | --- | --- | --- | --- |
| IF-001 | Cloudflare Access | 本人認証 | Yes (planned) | Browser login + Worker verify | 拒否/利用不可、fail-closed |
| IF-002 | Cloudflare D1 | データ保存と分析 | Yes (planned) | Worker binding | 明示エラー、架空データを返さない |
| IF-003 | Google Fit由来CSV | 歩数の初回／継続取込 | No, manual import | 本人アップロード | サンプル形式確認・取込保留 |

## 8. Trust Boundaries / Security
- Public edgeでは本人の認証を全URLで確認。Identity検証はaud/iss/署名/期限、本人allowlistと合わせて検証する設計（詳細TBD）。
- WorkerはD1のowner scopeをサーバー側で確認。UI表示非表示は認可の代替にならない。
- GitHub Actions Secretsの値は出力・保存・ソース化禁止。D1 UUIDはSecretではない。
- 元ファイル・ヘルスデータをGitHub CIやログへ送らない。
- PWAのオフラインキャッシュは個人データを保存しない。

## 9. Availability / Failure Strategy
| Failure | Behavior | Recovery |
| --- | --- | --- |
| Access unavailable/invalid | APIとUIを拒否 | 再認証、運用確認 |
| D1 unavailable | 不明/失敗と表示 | 再試行。部分登録・重複を避ける |
| Data missing | 欠測/比較不可と表示 | ソース追加 |
| Free quota exceeded | 明示的な制限エラー | 使用量調整。自動有料化しない |

## 10. Observability
構造化した安全な処理結果のみ。個人データ・画像・token・認証ヘッダは出力しない。既存他アプリのメトリクスと分けて監視（アカウントFree枠は共有）。

## 11. Performance / Cost
Cloudflare Free月額0円を設計目標とする。Workers CPU、D1行読書き、Actions使用量は実測。CSV解析はブラウザ主軸、APIは分割受信。

## 12. Architecture Decisions
docs/adr/ADR-0001-life-log-infrastructure.md に初期選定を記録。検証トリガーの手動→main push自動化は docs/adr/ADR-0002-auto-readonly-cloudflare-check.md に記録。

## 12.1 Local full-stack implementation proposal (#5)
- `wrangler.jsonc`: Worker entrypoint `src/worker/index.ts`; Static Assets `./dist` with `binding: ASSETS` and `run_worker_first: true` on **every** request, not just `/api/*`.
- Important Cloudflare official limitation: Static Assets routing may not propagate `ctx.access` to the User Worker, so the runtime independently verifies a **signed** Access JWT (`Cf-Access-Jwt-Assertion`) using Cloudflare Access JWKS, exact issuer, audience and owner email. This is a design implementation under local test; no live Access configuration exists.
- All routes fail closed (403) without `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL` or a valid token; no header spoofing, no public asset fallback.
- User data is only available to GET `/api/summary` using the validated singleton owner scope `owner`; POST and import writes are not implemented. All responses force no-store.
- Local D1 schema and synthetic fixture verification only; `wrangler d1 migrations apply life-log-dev --local` must always carry `--local`. Remote migration/deploy are prohibited.
- CI `.github/workflows/life-log-ci.yml` triggers on PR with no Cloudflare Secrets. Prior Cloudflare read-only metadata workflow remains main-push-only.
- Real Access, Worker binding end-to-end, mobile/browser negative smoke and public hostname protection are unverified; deployment is forbidden until separate human approval.

## 13. 未決事項
Access保護対象URLと本人ID、別Preview/Production D1、Workers runtime entrypoint、Google Fit CSV実形式。どれもBootstrap時点では未検証。

## 14. 2026-11-07｜既存リモートD1を実利用先に再利用する方針（Issue #36）

ユーザー方針：D1 Freeの最大10個枠を保全し、別のUAT/Production D1を作らず、既存 `life-log-dev` （ID `421d0116-5c33-4782-a2b6-28f9684d3956`）を最初のAndroid本人利用先に転用する。上記の「Production/PreviewのDBを新規作成する」は旧候補であり、初期利用に限って本節で上書きする。

- `wrangler.jsonc` のrootは引き続きlocal開発/CI専用。Wrangler local D1はリモートD1の個数制限を消費しない。自動CIに `--remote` を追加しない。
- 永続利用Workerは明示的な`--env uat`の `life-log-uat`。Binding `DB` は既存の `life-log-dev` UUIDと完全一致。名前がdevでも、これ以降はテストデータを無断投入する使い捨て開発D1として扱わない。
- 登録・訂正のRemote APIは、既存Worker本人JWT/owner検証に加え、`MANUAL_REMOTE_TARGET=uat`、`MANUAL_REMOTE_WRITE_ENABLED=true`、正規HTTPS OriginとFetch Metadata/custom intentの検証に成功したときだけ許可する。既定はfalse。CSV確定POSTのローカル限定制御は変更しない。
- GitHub Actions `.github/workflows/life-log-uat-deploy.yml` はPR時にLocalテストとUAT bundle dry-runのみ。リモートDeployは`workflow_dispatch`で承認済main SHAと正確な確認文字列が必要。bootstrapは書込禁止のWorkerのみ作成、activateは既存D1のメタ情報・必要テーブル読取確認後、GitHubの専用SecretsからAccess認証情報をアップロードして実行する。新しいD1作成、Remote Migration、テストデータ投入は含まない。
- WorkerレベルでCloudflare Accessを設定し、全ホスト/Preview/asset/API経路を保護する。入口保護に加えてWorkerの署名済JWTのissuer/audience/所有者メール一致を強制する。GitHub Secret候補：`LIFE_LOG_ACCESS_TEAM_DOMAIN`, `LIFE_LOG_ACCESS_AUD`, `LIFE_LOG_OWNER_EMAIL`（値をコード・Issue・ログに書かない）。
- リモートD1について確認済みなのはCloudflare API GETで名前/UUIDが一致した点だけ。実テーブル/レコード数、Migration履歴、既存データ、Worker/Access設定の実態は未確認。既存データを消すinit・seed・resetは禁止。必要なMigrationを実行する場合はデータ保持/復旧点を確認し別承認。
- **現段階はWorkflow準備であり、UAT WorkerのDeploy、Access設定、Secrets設定、Remote SQL、Android実機受入は未実施。** 動作可能との表示をしない。Android本人ログイン→体重登録→履歴→訂正→再ログイン後保持、匿名403/認証切れ/誤Origin拒否を実測してから「利用可能」とする。
- D1個数制限と無関係なWorkersリソースも他アプリに影響させない。既存mainへのマージ・UAT bootstrap/activate・Remote Migration・本番変更はそれぞれ別途承認する。

## 15. 2026-11-07｜GitHub Actions自動デプロイ承認（Issue #38）

ユーザーは開発中のライフログを毎回「実装→CI→mainへの承認済みマージ→開発環境デプロイ→smoke」まで一連の作業として進める方針を指定。Issue #36の手動デプロイだけという限定は開発用Workerの自動配信について本節で更新する。

- main pushで `.github/workflows/life-log-uat-deploy.yml` を自動起動（アプリコード・設定・workflow・Migration等の関連変更）。PRはCloudflare Secretsを使わずローカルテスト/Bundle dry-runのみ。
- deploy直前に最新main SHA、build、CI、Cloudflare API token、既存D1 `life-log-dev` UUID/nameを確認。失敗時はRemote操作に進まない。
- Access team/aud/ownerの3シークレットがすべて未設定なら、初回は本人JWTを要求する登録無効のWorkerだけ自動配信する。Secretsが一部のみならDeployを失敗停止。3つ揃った場合は既存リモートD1の必要テーブル存在を読取確認した後にだけ、本人JWT + Remote write制御を有効にして配信する。
- 新しいD1作成、既存他アプリ/Productionの変更、Remote Migration/fixture/seed、実個人データの自動操作は含まない。既存D1の中身が不明な場合はMigrationを自動適用しない。
- GitHub ActionsのデプロイはAndroidの利用可能状態を保証しない。Cloudflare Access本人許可ポリシーの実設定と、Android実機での本人ログイン/書込/再読込は別の実測が必要。Workerに本人JWTの設定がない場合、HTTPS配信に成功していても403（fail-closed）になる。

## 16. 2026-11-07｜Android本人利用に向けた既存D1とAccessの初回診断（Issue #42）

- 初回Workerデプロイはmain `aca93383029dbfdbdb19fecaab711c10a6eaaed3` にて成功。UAT URLの匿名アクセス403を確認。ただし403はWorker内のJWT検証がAccess未設定でも返せるため、Zero Trustの本人限定入口が構成された証拠にはならない。
- `.github/workflows/life-log-uat-preflight.yml` はmainへの承認済変更で自動起動し、既存リモート `life-log-dev` のID/name一致と `sqlite_master` のテーブル名だけをread-onlyで診断する。Access Apps APIもGETだけ。Github Secretは有無だけ記録し値を表示しない。
- この診断はDBの行データ・個人情報を読まず、D1 Migration/初期化/削除、Access Application作成/設定、Secrets登録、デプロイも実施しない。DBの状態を `EMPTY`（リモート利用前の空）、`TABLES_PRESENT`（少なくとも期待11テーブルが存在）、`PARTIAL_OR_UNKNOWN` として区別する。存在のみの確認ではカラム/制約や既存データ保持は未確認とする。
- D1を安全に初期化する場合も、対象が完全に空である事実を確認し、既存データ消失を伴わないMigrationのみ適用する。空でないDBを既知スキーマで無条件に上書きしない。
- Androidへの入口はCloudflareの「Workers & Pages → life-log-uat → Access」で**当該WorkerのみAll trafficを保護**し、ユーザー本人だけのAllowポリシーにする。Workers全体を保護する設定は他アプリへ影響するため選ばない。GitHub側の専用シークレット `LIFE_LOG_ACCESS_TEAM_DOMAIN`、`LIFE_LOG_ACCESS_AUD`、`LIFE_LOG_OWNER_EMAIL` の実設定が必要（値はリポジトリ/ログに記録しない）。
- SecretsとAccessを設定しただけでは、本人端末からの保存成功を証明できない。保存APIの権限・正規Origin、実D1スキーマ、Androidでの体重・歩数の追加/再表示/修正/再ログイン後保持を実測してから利用可能と認定する。

## 17. 2026-11-07｜既存D1の初期スキーマ構築（Issue #46）

- 最新のRemote read-only診断Run `42356870861` で、唯一のテーブルがCloudflare内部予約テーブル `_cf_KV` であり、ライフログ11テーブルがすべて不存在と確認した。Cloudflare公式D1資料にも内部用 `_cf_KV` が記載されている。
- `.github/workflows/life-log-uat-schema-init.yml` はmain承認済更新または手動実行時に、既存 `life-log-dev` のUUID/name、Migrationファイルが正確に `migrations/0001_initial.sql` のみであること、SQLが非破壊的CREATE TABLE/INDEXのみであることを静的確認する。
- Remote `sqlite_master` で実行直前にも**テーブル名が `_cf_KV` のみ**と一致しない場合は、Migrationを書き込まず停止。条件一致時だけWranglerの標準D1 migration applyを一度実施し、必要11テーブルの存在とOwnerの行数0を再検証する。Wrangler migrationのバックアップ機構を利用。
- 既存D1以外のDB作成/削除、個人行データの初期化・Seed・Import、他アプリ資源変更は行わない。初期化成功でも、Access本人許可・3種Secretが未設定の間はAPI書込有効化されず、Android実機保存は未検証。

## 18. AI連携：専用Google Sheets Bridge（Issue #299 / Proposed）

**Status:** 設計提案のみ（未接続・未実装）。Authoritative decision rationale, external official references and remaining TBD gates: [ADR-0008](adr/ADR-0008-chatgpt-sheets-sync-boundary.md)。設計項目の実装が存在しない間、現行 `src/worker/index.ts` のOwner認証境界を維持する。

| ID | Element | Responsibility / trust boundary |
| --- | --- | --- |
| ARCH-020 | ChatGPT Plus → dedicated private Google Spreadsheet | 利用者接続のGoogle Drive権限で読み取り・Commands追加。コネクタ権限をSheetタブ単位の分離とみなさない |
| ARCH-021 | Google Spreadsheet | Read_* / Read_DrinkDays は非正本・期間制限付きの副本。Commandsは本人署名のない外部入力。Results/Sync_Statusも改ざん可能な参照表示であり、**D1確定の独立証拠にはならない** |
| ARCH-022 | Dedicated scheduled-only Sync Worker | Cron Trigger `scheduled()`。外部から任意HTTPで実行する公開APIなし。許可済みSpreadsheet ID固定・Google OAuth2 service credentials管理・取得/登録/訂正業務の内部処理のみ |
| ARCH-023 | Existing life-log D1 | 唯一の個人データ正本。owner固定・source policy・transaction/CAS/ledgerにより責任ある確定。既存UAT D1の追加bindingは別途Human承認 |
| ARCH-024 | Failure/revoke boundary | Google 401/403, 429/5xx, Cron停止, credential失効時も、既存ブラウザアプリは独立稼働。D1を暗黙修正せず、同期不明/遅延を表示 |

**Data flows:** D1 → Worker → staging snapshot → published generation/manifest → Sheets Read_*/Read_DrinkDays → ChatGPT（照会）。ChatGPT → Sheets Commands → Worker validation → atomic D1 mutation + ledger → Sheets Results → ChatGPT（登録/訂正）。**どのSheetsセルもUser Editorに変更可能**であるため、Google Sheetsへの書込み・Resultsセルの成功表示だけでは D1 commit の独立した証明にならない。署名検証可能なレシート/本人認証済みD1の再取得など、Sheet外の確認経路を後続設計で成立させるまではユーザーへ『D1登録済み』と断定しない。

**Service identity:** Google service accountはprivate documentを個別共有する方式を候補とし、管理者権限/ドメイン全権委任を与えない。Service Account OAuth scope `drive.file` と `spreadsheets` の適用可否を実接続前に検証。資格情報をコード、Sheet、ログ、Issueに置かず、Secrets/vars・Cron・D1 binding・共有設定は今回は変更しない。D1 binding自体にrow-level grantはないため、Owner filter / allowlist /入力検証が必須。

**Quota / cost:** Cloudflare Workers Freeでは **Cron実行のCPU上限10ms**。署名生成/JSON処理/DB同期の実負荷が収まるか未実証であり、Free実現性は `TBD-AI-009` として合成負荷検証まで未確定。Google Sheets API はquota制限・429があり、2026年中の課金条件変更が公式に予告されている。読取Snapshotを毎15分で全量再生成するのは避け、**日次のread更新と15分のcommand確認を別候補**として検討。日次/15分cronと保持上限は**未確定**。実サービス有効化前に最新Google/Cloudflare仕様、Google Cloud billing設定、無断課金防止・停止条件を再確認する。Cron時刻はUTC。

**Environment separation:** 開発はFake Sheets + synthetic local D1のみ。既存 `life-log-uat` の唯一のリモート D1 は実利用データを含み得る。共有D1/環境・Secretの変更はRemote D1操作と区別して承認対象。既存認証・CSRF/Origin防護の迂回や信頼できないHeadersの捏造を禁止。

**Review stop:** 一つのWorkbookのファイル共有権限で `Commands` のみをEditorにし `Results/Read_*` を同じアカウントから改ざん不能にすることはできない。**writeを有効にする前に TBD-AI-007 / 008 と独立した本人確認・検証・期限切れコマンドの拒否を解決する。** `Read_DrinkDays` の明示禁酒/未記録分離を保持する。

**Interfaces and schema:** `docs/03_APPLICATION_ARCHITECTURE.md` の `IF-AI-001..004`、`DATA-AI-001..004` を正本とする。Releaseは #300 → #301 → #302 → #303 の独立段階で、#299の設計PRは配信対象ではない。
