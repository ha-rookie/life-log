# ADR-0008 — ChatGPT Plus / Google Sheets bridge with D1 as sole source of truth

- **Status:** Proposed — design review required; not approved for runtime implementation
- **Issue:** #299 (parent #298; implementation follow-ups #300–#303)
- **Baseline:** main `9a6bf549707c0d726dd5b65e4fc0c7334799f340`, reviewed 2026-11-21
- **Decision risk:** High (private health-related data, external integration, service credentials, future mutation)
- **Scope:** Design only. No Sheet, Google credentials, Cloudflare resources, D1 schema, deployment or actual data changed in this issue.

## Context

The existing owner-only life-log application uses Cloudflare Workers + D1; browser access uses verified Cloudflare Access JWT or an owner/passkey session in the current UAT configuration. `src/worker/index.ts` resolves the owner before protected APIs. `manual-entry.ts` / `mvp-features.ts` further restrict remote browser mutations using a separate explicit UAT opt-in, exact Origin, Fetch Metadata and intent header. These must not be weakened or spoofed for scheduled jobs.

The user has ChatGPT Plus with Google Drive connectivity but no available custom-MCP registration in that plan's current workflow. The user wants AI-assisted history reads and explicitly requested new/corrected entries without asking the user to export files by hand each time.

Current manual weight and steps have source-aware identity/CAS logic, and drinks/meals have their own constraints. ECLEAR weight and Google Fit steps take precedence for canonical analyses. Existing `/api/mvp/export` is **source-record CSV**, not an automatically canonical daily series.

## Options and decision

| Option | Benefit | Cost / residual risk | Disposition |
| --- | --- | --- | --- |
| Cloudflare scheduled Worker ↔ dedicated private Google Spreadsheet ↔ existing ChatGPT Drive connector | Works with current account connector; no public mutation API; async receipt/result | External copy of health data; API quotas/credentials; spreadsheet is mutable and not a queue | **Propose for staged rollout** |
| Direct custom MCP server connected to ChatGPT | Natural read/write tools | Current account capability limitation; would still need auth design | Defer; keep business operations reusable |
| Manual CSV/Drive export/import | No Google service credential, simple read-only | Manual, stale, lacks safe bidirectional completion | Fallback only |
| OpenAI API embedded in life-log | Direct UX, independent of ChatGPT connector | Separate billing, token/privacy/deployment design | Outside Phase A |

This is a **design proposal**, not an authorization to create the bridge. Phase A approval gates implementation; Phase B read-only must pass before Phase C create, then Phase D correction. See `docs/03_APPLICATION_ARCHITECTURE.md` for the single authoritative column-level contract.

## Trust boundaries and non-negotiable invariants

1. **D1 is authoritative** for record identity, source precedence, revision and committed outcomes. The spreadsheet is a *copy* for reads and a *request inbox* for writes, never a second database.
2. **Spreadsheet content is untrusted input**, even when the workbook is private. Sheet editor access cannot prove a command was genuinely spoken by the owner to ChatGPT. `requested_by` is untrusted metadata, not authentication; no impersonated user/session headers. A compromised connector or sheet editor can submit commands: restrict allowlist and blast radius; decide whether sensitive correction requires independent owner approval before Phase D.
3. **Service credentials are distinct from browser identity.** Proposal: dedicated Google service account with only the dedicated document explicitly shared to its email. Use OAuth2 short-lived access tokens and secrets stored only in a dedicated Cloudflare environment after separate approval. No Google domain-wide delegation, personal OAuth refresh-token in Sheets, static credential in repository, or exposing Google credentials to ChatGPT. Evaluate least-permissive `drive.file` vs `spreadsheets` scope with real account permissions before deployment; scope alone is not a spreadsheet-tab ACL. A service-account key, if used, must have rotation/revocation runbook. Prefer no long-lived key if a genuinely supported federation mechanism can be verified later.
4. **One fixed document, explicit tool permissions.** The Sync Worker is configured with an allowlisted spreadsheet ID obtained via a separately approved setup (not from a command cell). Document sharing is private to the owner, the ChatGPT-connected account, and the service account only; no public link. Google Sheets scopes are per spreadsheet file, never per worksheet. Sheet protected ranges and browser UI restrictions do not provide isolation from every Editor; the Worker validates each request and publishes only sanitized results.
5. **Scheduled-only execution.** Proposed separate Worker with `scheduled()` and no HTTP entrypoint/anonymous read path, a dedicated binding to the approved existing D1 and static owner resolution in server code/binding (never row-supplied owner_id). No call to protected browser endpoints with forged `Origin`, `Sec-Fetch-Site`, cookie or Cloudflare Access identity. Share *domain logic* only after it is extracted and independently tested. A D1 binding has DB-level privilege, not SQL row-level grants: server-side owner predicates, fixed queries and operation allowlist are essential.
6. **No destructive or arbitrary mutation.** Phase C initially allows new **manual** weight and steps only; drinks/meals only after their API and source semantics are independently matched. Phase D may correct specific manual rows with `expected_revision`/CAS after separate owner-risk review. No delete, arbitrary SQL, automatic overwrite of ECLEAR/Fit records, photo transfer, business tables outside life-log, or query-defined owner.
7. **Proof of completion.** Writing `Commands` means only `submitted`. Google Sheets `Results` is the acknowledgement *of a verified D1 ledger outcome*, not the authority itself. "Saved" requires a corresponding committed ledger outcome and readback; a lost response is **unknown**, not success. The AI should state pending/uncertain and re-read results; never infer success from a Sheet edit.
8. **Minimal disclosure.** Export bounded authorized periods, needed numeric fields, source/value quality, immutable record key and export freshness. Omit unneeded diary free text, raw CSV/hash, credential/owner ID, precise location, and all secrets. Separate `unknown`, `missing`, `null`, `0`, `reported`, `measured` and `estimated` according to existing semantics. Stale snapshots are visibly flagged; no speculative data filling. Escape formula-like and control-character values on outbound cells and reject formula cells in inbound commands.
9. **No automatic billing commitment.** Cloudflare and Google quotas, service-account eligibility and pricing may change; a per-run budget and alarm/stop threshold are required before configuring Cron. Existing quota billing must be rechecked immediately before rollout; do not silently enable paid usage.

## Scheduled sync sequence / crash safety

- **Read path:** authenticated service credential retrieves bounded owner-scoped D1 records through an internal function, renders complete next generation (`generation_id` shared across all `Read_*` rows), and verifies row counts/checksum. Write a new `Meta.active_generation` *only after* staged rows/manifest validate. Consumers must reject partial, mismatched or stale generations. Google Sheets may not atomically publish multiple independent API calls; generation marking is a consistency protocol, not a transaction across products. The exact staging/swap mechanics need synthetic tests before deployment.
- **Write path:** bounded `Commands` append-only requests are parsed by strict versioned schema. The Worker independently validates target type, required measured timestamp/day, ranges, source precedence, request digest and intended operation. It commits **domain write + unique ledger result atomically in D1** (new schema proposal and migration are **Phase C**, not Phase A). Same command UUID + canonical digest replays identical persisted outcome with no second mutation; same UUID with different digest is rejected; concurrent scheduled executions must respect the unique ledger record and database transaction.
- **Result path:** the Worker writes `Results` keyed by immutable command_id, never by row number, and checks status from the D1 ledger. If the Google API fails after commit, the next sync reconstructs the response from D1; no blind replay. Use `queued | applied | duplicate | conflict | rejected | retryable_failure | unknown` with stable machine-readable error codes. A successful Sheets write alone does not establish D1 success.
- **Correction path:** `target_key` + expected observed revision/digest (not date alone), checked under the same atomic transaction as modification. Old revision/another source/missing item -> conflict with zero writes. Owners must decide how confirmation is evidenced before corrections are enabled.
- **Error path:** Google API 401/403 disables syncing and alerts without changing D1; 429/5xx uses bounded exponential backoff with jitter and a retry ceiling; stale/unparseable/missing metadata => fail closed. Concurrent schedules, crash windows, clock differences, stale sheet rows, sheet sorting, resubmitted commands and partial export require synthetic negative tests.
- **Audit:** D1 dedicated command ledger is distinct from `import_jobs` and `import_row_audit`; store operation, actor category, canonical hash, target key, timestamp, outcome and non-sensitive reason code, not whole health record payload or OAuth secrets. Command identity/tombstones cannot be pruned while replay remains possible; decide bounded retention and replay prevention before any cleanup.
- **Stop / revoke:** disable Cron / independent environment, revoke Google service-account credential, remove file sharing and rotate affected key, preserve D1 and ledger, verify outstanding requests never silently resume. Removal of the Google copy requires a documented privacy procedure.

## Explicit limits and unresolved gates

- **TBD-AI-001:** Google service-account credential type and final scope: test `drive.file` against shared-file flow before choosing; documented alternative `spreadsheets` with file ACL is broader. Actual Google permissions/Cloudflare secret mechanism not configured here.
- **TBD-AI-002:** Exact list of read attributes, periods (proposal: 90 days default; 366 maximum), row and query limits, generation publication algorithm and retention.
- **TBD-AI-003:** Meaning of "owner approved" for inbound create and especially correction when Sheet rows are editable; independent owner confirmation may be required for high-impact corrections.
- **TBD-AI-004:** D1 command ledger schema, atomic compare-and-set and migrations, retry window and command retention. No remote SQL/migration authorized.
- **TBD-AI-005:** Cron cadence (15 minutes only a starting estimate), quota/billing eligibility and sustained costs; no activation without explicit approval.
- **TBD-AI-006:** Connector read/write acceptance and read-after-write behavior with a real private Sheet; **not demonstrated by Phase A docs or existing CI**.

## Synthetic verification specification (not yet executable for unimplemented sync)

| Scenario | Input / fault | Expected |
| --- | --- | --- |
| S01 | Same valid create command id + body twice | One D1 row, same ledger result |
| S02 | Same id, different body | Rejected, no second write |
| S03 | Two concurrent Cron events | One atomic effect, reproducible result |
| S04 | D1 commit then Sheets `Results` 503 | Readback from ledger on retry, no reinsert, report pending until confirmed |
| S05 | Expected revision stale during correction | Conflict; old/new D1 values unchanged by this command |
| S06 | ECLEAR/Fit authoritative same-day source exists | No automatic modification or replacement |
| S07 | Inbound formula / unknown operation / foreign owner / oversized payload | Reject before DB write |
| S08 | `0` steps / `NULL` / alcohol unknown / estimate | Preserve distinct observed states |
| S09 | JST midnight/date-only weight without measured timestamp | Correct day mapping; invalid weight timestamp request rejected |
| S10 | Incomplete generation or expired export | No claim of fresh/complete analysis |
| S11 | Google token revoked / 429 / 5xx | Fail closed, bounded retries, existing life-log unaffected |
| S12 | Command row sorted or moved / duplicate result row | Command_id + digest identity, no row-index trust |
| S13 | Unrecognized shared spreadsheet ID or permissions | No data access, no mutation |
| S14 | Sheets result says "applied" but D1 ledger missing | Not a successful D1 record |

These are **planned synthetic test vectors**, not evidence that a sync integration test passed. The Phase A design PR should run existing repository validation and app CI automatically; integration tests belong to #300–#303.

## Rollout gates and reference evidence

- #299: docs-only design review (ADR stays **Proposed** until explicit human design acceptance); no merge under this request.
- #300: D1 → Sheet read-only, local synthetic D1 + fake Sheets, independent acceptance.
- #301: create-only service gate + command ledger + additive migration design, fresh approval before any Remote D1 write.
- #302: correction + verified CAS + owner consent design, no deletion.
- #303: end-to-end failure/recovery/privacy/monitoring and real owner acceptance; do not auto-close #31.

Primary documentation checked 2026-11-21:
- Google Workspace service account / document sharing: https://developers.google.com/workspace/guides/create-credentials
- Sheets API OAuth scopes and tab-level limitations: https://developers.google.com/workspace/sheets/api/scopes
- Sheets API quotas and changing billing conditions: https://developers.google.com/workspace/sheets/api/limits
- Cloudflare Cron Triggers / UTC schedule: https://developers.cloudflare.com/workers/configuration/cron-triggers/

**No production authorization results from this ADR.**