# Project Overview — ライフログ（仮）

## Project
- Project: ライフログ（仮）／データ駆動の減量支援
- Repository: ha-rookie/life-log (Private)
- Planning context: Notion 企画・要件定義 v0.7 (2026-11-04)
- Project status: Bootstrap design proposal. No application, deployment, or D1 migration is implemented.

## User Problem
単に数値を記録するのではなく、過去と現在の体重・飲酒・食事・歩数・体組成から、体重が減った時と増えた時の違いを整理し、実行可能な行動を選んで効果を検証したい。記録負担は最低限にしたい。

## Target User
本人1名のみ。匿名・第三者利用は非対象。

## Success Condition
1. 過去データを重複なく取り込み、出典・欠測を識別できる。
2. 減量期・増量期を比較し、行動仮説の支持材料と反証材料を確認できる。
3. 行動計画を記録し、体重の変化を検証して継続・修正・終了を選べる。
4. 未認証ではUI/API/個人データへアクセスできない。
5. Cloudflare Freeを目標とし、実測で利用枠・セキュリティを評価する。

## In Scope (MVP)
- 体重進捗と過去比較、飲酒・食事区分・歩数の分析
- 1タップ飲酒杯数記録と行動実験
- 既存生活記録、体組成・旧体重記録、Google Fit由来歩数のCSV/初回移行
- 認証必須、私有データの分離、CSV再出力
- Android Chrome向けレスポンシブUI（PWA候補）

## Out of Scope (MVP)
- 写真AIカロリー推定（将来PoC）、自動の有料AI API
- 排便記録、食品重量の常時入力、複雑なカロリー追跡
- 不特定利用者への公開、SNS、外部有料サービス
- Bootstrap時点のRemote D1 Migration / deployment / Cloudflare Access作成

## Technology (proposed)
- Frontend: React + TypeScript + Vite
- Runtime/Hosting: Cloudflare Workers + Static Assets
- Database: isolated Cloudflare D1, local-first development
- Authentication: Cloudflare Access + Worker/API-side identity and authorization verification (details TBD)
- Source workflow: Issue → Branch → PR → CI → Human Merge Gate
- Template: AI Driven Web App Template governance; full-stack template patterns selectively consulted

## Human Decision Points
- Project-specific requirements and privacy policy; unresolved authorization details
- Preview/Production binding and hostname isolation, authentication and billing
- Important design PR merge; all Cloudflare resource mutations and deployments
- AI food recognition expansion and provider selection

## Release Definition of Done
See RELEASE_CHECKLIST.md and CONVERGENCE_GATE.md. Bootstrap document approval ≠ application release.
