# Requirements — ライフログ（仮）

## 1. 文書目的
本書は機能／非機能要件の正本。構成・ファイルはArchitecture文書、運用操作はCLOUDFLARE_SETUP.mdに分離する。

## 2. 対象ユーザー
本人1名。スマートフォンのAndroid Chromeを優先し、PCブラウザにも対応する。

## 3. 解決する課題
食事・飲酒・歩数と体重増減の関係を過去実績から検討し、行動仮説の実行と検証を回す。単なるデータ収集やカロリー推定自体は目的でない。

## 4. 利用シナリオ
| ID | シナリオ | 成功条件 |
| --- | --- | --- |
| REQ-001 | ログイン後に本人の記録を閲覧・編集 | 未ログインの画面・API・データ閲覧不可 |
| REQ-002 | 既存履歴をCSV等からインポート | 元出典・日時・欠測を維持し冪等登録 |
| REQ-003 | 減量期・増量期を比較 | 体重変化、行動指標、欠測を同一期間で比較 |
| REQ-004 | 飲酒の杯数等を最小操作で記録 | 追加・訂正・取消と日付修正が可能 |
| REQ-005 | 行動仮説を試して評価 | 行動・期間・評価基準・支持／反証を確認 |
| REQ-006 | CSVを継続取り込み | プレビュー、エラー、重複判定、明示確定 |
| REQ-007 | 個人データを出力 | CSVで再エクスポート可能 |

## 5. 機能要件
| ID | 要件 | 優先度 | 受け入れ条件 | 状態 |
| --- | --- | --- | --- | --- |
| REQ-001 | 本人認証と全経路のアクセス制御 | Must | 未認証UI/API/Assets/別ホストは拒否 | Planned |
| REQ-002 | 既存履歴の移行 | Must | 生活記録・体組成・旧体重・歩数の出典と重複管理 | Planned |
| REQ-003 | 体重推移と比較分析 | Must | 測定数・代表値・欠測が明示される | Planned |
| REQ-004 | 飲酒・食事区分の簡易記録 | Must | 飲酒なし／未入力／杯数不明を区別 | Planned |
| REQ-005 | 仮説・行動実験の記録と効果検証 | Must | 支持と反証、継続・修正・終了を記録 | Planned |
| REQ-006 | CSVプレビューと安全な取込 | Must | 本人確定前に書込みなし、再取込で二重計上なし | Planned |
| REQ-007 | CSV再出力・削除の設計 | Must | 本人のデータ持ち出しが可能 | Planned |
| REQ-008 | 画像AIカロリー下書き | Later | 別PoC後に本人確認で保存、数値は推定扱い | Deferred |
| REQ-009 | 排便記録を持たない | Must | 画面・DB項目に設けない | Planned |

## 6. 非機能要件
| ID | 分類 | 要件 | 測定・確認方法 |
| --- | --- | --- | --- |
| NFR-001 | Security | UI/API/CSVも含め本人のみ。認証・認可を別判定、fail-closed | 未ログイン直アクセスの負ケース |
| NFR-002 | Integrity | 欠測≠0、過去飲酒有無≠杯数、重複投入は冪等 | データ移行と再実行テスト |
| NFR-003 | Performance | Workers FreeのCPU/リクエスト枠を意識した分割取込 | ローカル・専用環境で計測 |
| NFR-004 | Usability | 小画面・ワンタップ中心。頻繁な手入力を強制しない | Android実機受入 |
| NFR-005 | Cost | Cloudflare月額0円を設計目標とし有料化しない | アカウント共用枠の実測 |
| NFR-006 | Privacy | 個人健康データをCIや公開Issueに置かない | 内容・ログ・キャッシュ監査 |

## 7. データ・外部情報要件
- Source: Boxの生活CSV、体組成CSV/TXT、旧体重Excel、Google SheetsのGoogle Fit由来歩数。原本は不変更。
- 現時点の確認記録数はNotion企画 v0.7に記載。実際の移行・重複解決は未実施。
- Google Fit新規CSV列はサンプル入手後に確定する。
- 時刻はAsia/Tokyo基準、実測／自己申告／推定と元ファイルの識別子を保持。
- 欠損はnull、明示的な非飲酒のみ0。写真を自動送信・保存しない。

## 8. 制約
- React/Vite + Workers + 専用D1、Cloudflare Access候補。
- まずローカル開発と合成データ、Preview/ProductionはDB・Secrets分離。
- 有料サービス/API・デプロイ・Cloudflare資源変更は別承認。
- Private Repositoryでも秘密値や実健康データをGit履歴に入れない。

## 9. Out of Scope
画像AI、排便、商用化、既存三麻スコアのD1やSecretsの転用。

## 10. 未決事項
| ID | 論点 | 決定者 | 条件 | 状態 |
| --- | --- | --- | --- | --- |
| TBD-001 | Accessの本人認証方式と保護対象ホスト | Human | deploy前 | Open |
| TBD-002 | Production/Preview専用D1とURL | Human | 環境作成前 | Open |
| TBD-003 | 実Google Fit CSVの列仕様 | Human+AI | サンプル取得後 | Open |
| TBD-004 | 体重代表値と最低測定数、実験比較ルール | Human+AI | 分析実装前 | Open |

## 11. 要件変更管理
ID・状態を維持し06_REQUIREMENTS_TRACEABILITY.mdへ反映する。新規仕様は別Issueに分離する。
