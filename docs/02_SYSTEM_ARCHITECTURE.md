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
