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


## 5.3 Synthetic CSV preview-confirm local slice (Issue #9)
- REQ-002/REQ-006/APP-004: lifestyle + ECLEAR synthetic UTF-8 CSV parse, mapped preview, explicit confirmation, server-side revalidation and local-only D1 batch storage.
- NFR-001/REQ-001: Access owner verification precedes every route. Confirmation also requires local flag + loopback hostname + Origin matching; no public import route by default.
- NFR-002: blank fields remain NULL, explicit drinking=0 has cups=0, past drinking=1 keeps cup count NULL. Equal row overlaps skip, conflicts produce 409, and data/job/audit use one atomic batch.
- Tests: synthetic Vitest parser/API and Python SQLite transaction rollback, plus existing Wrangler local-only D1 checks. Final PR HEAD CI must be inspected before completion claims.
- Deferred: actual user CSV, Google Fit/Shift_JIS/XLSX/TXT, editable mapping, import cancellation, larger batch protocol, live Access/Worker/D1 end-to-end.
- No main merge, remote D1 SQL/Migration/write, Access mutation or deployment.

## 6. Coverage Review
Release前に全ACTIVE要件の実装・テストEvidenceを確認し、未実装／未検証を明確に残す。

## 5.2 Reproducible build and negative authentication (Issue #7)
- REQ-001/NFR-001: add synthetic negative JWT signatures, identity spoofing, issuer/audience/time validity and all Worker route types; real Cloudflare Access integration remains NOT VERIFIED.
- CI reproducibility: `package-lock.json` + `npm ci` on both PR and main push (main execution only after separate approved merge). The existing Cloudflare credential GET-only workflow remains separate.
- No remote D1, Cloudflare Access configuration, Preview/Production deployment or actual user data is modified.
