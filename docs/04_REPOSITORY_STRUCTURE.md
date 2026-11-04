# Repository Structure — ライフログ（仮）

## 1. 文書目的
現在のRepositoryツリーと、今後作成するアプリ専用ファイルの配置計画の正本。

## 2. Current (Bootstrap)
既存のテンプレート共通文書とIssue/PR/CI運用:
- .github/workflows/template-validation.yml
- .github/ISSUE_TEMPLATE/, .github/PULL_REQUEST_TEMPLATE.md
- docs/00_PROJECT_OVERVIEW.md 〜 docs/06_REQUIREMENTS_TRACEABILITY.md
- docs/adr/, docs/playbooks/, docs/instructions/, docs/workflow-templates/
- AGENTS.md, README.md, scripts/

本Issueで新しく追加する:
- wrangler.jsonc — 開発D1 Bindingの識別値、実運用のdeploy targetではない
- .github/workflows/cloudflare-d1-readonly-check.yml — manual GET-only credential/database check
- docs/adr/ADR-0001-life-log-infrastructure.md — D1と認証を含む設計上の決定

## 3. Planned (not created in Bootstrap)
- src/ — React/ViteとWorkerの実コード
- migrations/ — ローカルテスト後に開発用Migrationを導入
- tests/ — Domain、CSV、認証負ケースのテスト
- package.json / lockfile / tsconfig — runtime選定後
- workers/assets/ — 該当する構成に決まった場合のみ

空ディレクトリを作らず、後続Issueで必要になったタイミングで作成する。

## 4. Directory Responsibilities
| Path | Role | Status |
| --- | --- | --- |
| docs/ | 設計の正本 | Existing/updated |
| .github/workflows/ | ローカルCI、手動Cloudflare read-only check | Existing/new |
| wrangler.jsonc | dev D1 Binding ID。Secret値を含まない | New |
| src/ | UI / API | Planned |
| migrations/ | D1 schema changes（Remote適用は別承認） | Planned |
| tests/ | local/negative tests | Planned |

## 5. Generated / Security
生成物・測定原本・実健康情報・API Tokenをリポジトリに保存しない。SecretsはGitHub設定でのみ保持し、値を直接CI出力しない。D1 UUIDは秘密値ではない。

## 6. Naming
Issue専用Branch、設計ID、ADR番号はTemplate規約を継続。本人のデータを含むファイル名・内容は公開Artifactへ出さない。
