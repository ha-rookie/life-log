# ADR-0008 — ChatGPT Plus / Google Sheets bridge with D1 as sole source of truth

- **Status:** Proposed — Phase A design merged, B1 offline read model merged; this separate Issue #310 amendment remains **proposed and unmerged**, and does not approve runtime activation
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
| Cloudflare scheduled Worker ↔ dedicated private Google Spreadsheet ↔ existing ChatGPT Drive connector | Could reuse connected Google Drive tools; exact private-Sheet append/readback and durable credential permissions require an owner-accepted integration test; no public mutation API | External copy of health data; API quotas/credentials; spreadsheet is mutable and not a queue | **Propose for staged rollout** |
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
7. **Proof of completion and integrity gap.** Writing `Commands` means only `submitted`. D1 ledger is authoritative, but **a `Results` row, a `Sync_Status` row, and a `Read_*` row are all editable through the same user-owned spreadsheet**: they are not independent/cryptographic evidence of D1 commit. The Worker must derive its responses from committed D1 ledger, and must not trust values read back from a Sheet for proof. The ChatGPT side must not assert "saved" based only on editable Sheet cells: until the independent receipt/verification mechanism and owner-accepted integration test in TBD-AI-007, it may report only **"sheet reports applied; D1 confirmation not independently verified"**. Unknown responses are never guessed as success. An owner-side authenticated life-log record view or independently verifiable signed receipt is a candidate future trusted confirmation channel; merely putting a signature into a writable cell without a real verifier is not sufficient.
8. **Minimal disclosure.** Export bounded authorized periods, needed numeric fields, source/value quality, immutable record key and export freshness. Omit unneeded diary free text, raw CSV/hash, credential/owner ID, precise location, and all secrets. Separate `unknown`, `missing`, `null`, `0`, `reported`, `measured` and `estimated` according to existing semantics. Stale snapshots are visibly flagged; no speculative data filling. Escape formula-like and control-character values on outbound cells and reject formula cells in inbound commands.
9. **No automatic billing commitment.** Cloudflare and Google quotas, service-account eligibility and pricing may change; a per-run budget and alarm/stop threshold are required before configuring Cron. Existing quota billing must be rechecked immediately before rollout; do not silently enable paid usage.

## Security final-review addendum (2026-11-21)

The main threat is **confused trust across one Google document**. Appending data to `Commands`, editing `Results` and rewriting `Read_*` are all possible with file Editor rights. A file ACL limits *who can do this*, but does **not** create per-tab roles, prove that the owner sent a particular chat message, or make results tamper-evident. The originally proposed single workbook can remain the v1 organizational format for **read-only discovery**, but **write activation is blocked** until TBD-AI-007 passes a trusted-owner verification decision. The final answer to the user should be truthful about which confirmation was actually observed.

| Threat | Residual severity | Mandatory design response |
| --- | --- | --- |
| AI connector / Google Editor mutates `Read_*`, `Meta`, `Results` | High | Treat sheet content as untrusted. Independent authenticated D1 readback or verifiable receipt; never rely solely on sheet status |
| AI prompt injection from sheet text (including formulas/links) | High | Strict typed schemas, fixed command allowlist, no free-text instructions executed, no remote URL following or arbitrary SQL |
| Editor forges a new command or alters it before first sync | High | Accept no user identity from row; separate owner approval for correction; explicit opt-in, low-risk create limits and monitor |
| Credential theft or too-broad Sheets scope | High | Dedicated account/file ACL, scoped token, vault-like secret store, rotation/revoke, no domain delegation, no cross-app D1 |
| Concurrent Cron, response loss or stale `expected_revision` | High | D1 atomic ledger + domain mutation, unique command ID, compare-and-swap, bounded retries and recovery |
| Missing/partial/synthetic-looking observation misread as real zero | High | Field-level states and day-level drinking presence; source priority; visible freshness |
| Google Sheets/Workers quota or unplanned API charges | Medium | Run budget, cap, backoff/stop, re-check current provider billing and Free CPU/time limits before activation |

**Least-authority decision:** Phase B may publish non-destructive read snapshots without allowing any Sheets-driven D1 mutation. Phase C's create-only capability requires separate approval with owner-accepted acceptable risk, hard rate/volume limits, fail-closed unknown command handling, and proof that D1 completion can be verified independently. Phase D correction is **disabled by default** and requires per-command approval bound to the exact hash and expiring at a defined time. No external publisher can safely infer that an owner-supplied passkey was used from a Sheet cell.

**Google API details verified:** `spreadsheets` OAuth scope covers all spreadsheets the service account can access, **not just a single spreadsheet by OAuth definition**. Actual file sharing permissions restrict the service account's reachable documents; `drive.file` limits to files created/opened with the app and must be tested with this concrete shared-file scenario. The Sheets documentation says a *single API request* is applied atomically, but there is no cross-request or D1+Sheets global transaction. For `spreadsheets.batchUpdate`, write strictly typed `updateCells.userEnteredValue.stringValue/numberValue` with `fields:userEnteredValue`; the separate values API defines `valueInputOption:RAW`. Neither method by itself blocks hostile instructions/prompt injection. The provider recommends payloads at most 2 MB and backoff on 429, and its docs currently say later-2026 quota excess charges are planned; billing status at deployment is a new verification gate. Cloudflare Cron executes in UTC and its configuration changes can take up to 15 minutes to propagate.

**Scheduling trade-off:** 15-minute cadence is **not a commitment**. Prefer different cadence for read snapshot (e.g. daily or on approved update) and command checks (e.g. 15 minutes if free-tier budget allows); 90-day full-sheet rewrite every 15 minutes is an unnecessary quota/privacy/cost risk. Explicit maximum commands/run, retries, duration, and fail-closed pause/resume required.

## Scheduled sync sequence / crash safety

- **Read path (proposed v1)**: an approved scheduled service would bind to existing D1, issue bounded owner-scoped SELECTs in one D1 batch transaction, and prepare a complete generation (shared `generation_id`) before any Google write. **Use one complete `spreadsheets.batchUpdate` with all seven sheets/Meta or fail closed**; 2 MB is a recommended payload bound, not an API hard limit. Google guarantees atomicity of that **one request**, not any D1↔Sheets transaction, multi-request staging, or immunity from collaborator edits. No physical two-slot Google worksheets have been designed or validated: the B2 FakeSheets `publishStaged` protocol is simulation only and **must not be activated in real v1**. If payload or provider behavior requires multiple calls, stop for a separately approved physical dual-slot/worksheet layout, migration and live connector read verification. A lost response must be checked as unknown until a verified readback, never guessed published. If connector cannot validate manifest/period/counts and timestamp, mark "partial/unverified Sheet copy". This remains a future activation gate, not a running integration.
- **Write path:** `Commands` is **append-only by convention, not by a Google Sheet-enforced guarantee**: an Editor can reorder, overwrite or delete rows. The Worker scans bounded rows by stable IDs/digest, uses a persisted D1 ledger to detect post-observation mutations and duplicates, and rejects malformed/replayed/expired requests; content edited *before first observation* is indistinguishable from an original request. Bounded `Commands` requests are parsed by strict versioned schema. The Worker independently validates target type, required measured timestamp/day, ranges, source precedence, request digest and intended operation. It commits **domain write + unique ledger result atomically in D1** (new schema proposal and migration are **Phase C**, not Phase A). Same command UUID + canonical digest replays identical persisted outcome with no second mutation; same UUID with different digest is rejected; concurrent scheduled executions must respect the unique ledger record and database transaction.
- **Result path:** the Worker writes `Results` keyed by immutable command_id, never by row number, and checks status from the D1 ledger. If the Google API fails after commit, the next sync reconstructs the response from D1; no blind replay. Use `queued | applied | duplicate | conflict | rejected | retryable_failure | unknown` with stable machine-readable error codes. A successful Sheets write alone does not establish D1 success.
- **Correction path:** `target_key` + expected observed revision/digest (not date alone), checked under the same atomic transaction as modification. Old revision/another source/missing item -> conflict with zero writes. **Default deny corrections from Google Sheets** until the user explicitly approves a method for owner-authenticated confirmation bound to the exact `command_id`, payload digest, target and expiry (for example, one-time owner/Passkey approval recorded server-side in D1). A Sheet checkbox, `requested_by` value, or user-editable approval column is not sufficient. Owner approval is distinct from general spreadsheet editing permission.
- **Error path:** Google API 401/403 disables syncing and alerts without changing D1; 429/5xx uses bounded exponential backoff with jitter and a retry ceiling; stale/unparseable/missing metadata => fail closed. Concurrent schedules, crash windows, clock differences, stale sheet rows, sheet sorting, resubmitted commands and partial export require synthetic negative tests.
- **Audit:** D1 dedicated command ledger is distinct from `import_jobs` and `import_row_audit`; store operation, actor category, canonical hash, target key, timestamp, outcome and non-sensitive reason code, not whole health record payload or OAuth secrets. Command identity/tombstones cannot be pruned while replay remains possible; decide bounded retention and replay prevention before any cleanup.
- **Stop / revoke:** disable Cron / independent environment, revoke Google service-account credential, remove file sharing and rotate affected key, preserve D1 and ledger, verify outstanding requests never silently resume. **Pause/revoke must be fail-closed on resume:** requests older than a server-enforced short TTL and any backlog accumulated during a pause require fresh owner authorization or rejection, not an automatic catch-up. The Worker must not trust Sheet timestamps for approval/age; compare ingestion time and admissible bounds. Removal of the Google copy requires a documented privacy procedure.

## Proposed Phase B2 manifest and trust alignment (Issue #310; NOT approved by this unmerged PR)

B1 PR #308 is merged and B2 Fake Sheets PR #309 is open with synthetic CI passing. The original `Meta(key,value,updated_at_utc)` table defines **8 keyed rows**, but the B1 canonical SHA-256 covers fields that cannot be recomputed with those 8 alone. **Proposed v1 addition**: preserve the three A1 columns and eight old keys, append four `coverage_to_jst`, `incomplete_day_jst`, `canonical_weight_keys_json`, `warnings_json` rows (exact total **12**). `retention_from_jst` represents `coverage_from_jst`. Each missing/unknown/duplicate key rejects the versioned publication; unknown `contract_version` must fail closed, and migrations for any already-provisioned workbook remain future Human review (no actual workbook has been created). `canonical_weight_keys_json` maps JST day to a row already present in `Read_Weight`; same-day eligible measurements are not summable or necessarily "last row wins." `record_key`/`revision` are noncryptographic freshness aids, **not** owner permission or secure CAS.

Daily projection: B1 emits **one row per covered JST day** in each of `Read_Steps`, `Read_Meals` and `Read_DrinkDays`. Within a row, null/missing = unobserved (not explicit 0), whereas absent whole-day row *inside the advertised coverage* means broken/incomplete export. Weight and drink-detail rows remain event-based and may legitimately be absent. `data_through_jst` means last elapsed JST day only, **not** proof every field was entered; freshness is separately assessed against a trusted clock, never just Sheet-supplied timestamps.

**Trust limitation persists after manifest validation.** An Editor of a single workbook may alter `Read_*`, `Sync_Status`, `Meta` and hashes; matching a same-file digest demonstrates only internal consistency. The double Meta read detects some concurrent mutations but cannot guarantee true atomic reads (e.g. reversion/ABA between checks). Never assert authenticated D1 provenance, successful D1 write or complete behavioral observation based solely on the Sheet copy. For real v1, require one atomic `spreadsheets.batchUpdate` across all 7 read-only tabs; never switch to live chunk/staging from FakeSheets without a newly reviewed physical storage layout and acceptance. Source of truth remains D1.

**External verification still pending (TBD-AI-001/002/006/008/009):** actual private workbook, service account scope/ACL, Google quota and timeouts, Cloudflare Free Cron 10ms CPU / 50 subrequests, 15min wall ceiling, connector multi-tab read consistency, and live privacy acceptance. Local 30/90/366-day estimates or mock success cannot authorize activation, billing or data transfer.

Official technical references checked 2026-11-23:
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#UpdateCellsRequest
- https://developers.google.com/workspace/sheets/api/limits
- https://developers.cloudflare.com/workers/platform/limits/

## Explicit limits and unresolved gates

- **TBD-AI-001:** Google service-account credential type and final scope: test `drive.file` against shared-file flow before choosing; documented alternative `spreadsheets` with file ACL is broader. Actual Google permissions/Cloudflare secret mechanism not configured here.
- **TBD-AI-002:** Exact list of read attributes, periods (proposal: 90 days default; 366 maximum), row and query limits, generation publication algorithm and retention.
- **TBD-AI-003:** Meaning of "owner approved" for inbound create and especially correction when Sheet rows are editable; independent owner confirmation may be required for high-impact corrections.
- **TBD-AI-004:** D1 command ledger schema, atomic compare-and-set and migrations, retry window and command retention. No remote SQL/migration authorized.
- **TBD-AI-005:** Cron cadence (15 minutes only a starting estimate), quota/billing eligibility and sustained costs; no activation without explicit approval.
- **TBD-AI-006:** Connector read/write/append acceptance and read-after-write behavior with a real private Sheet; **not demonstrated by Phase A docs or existing CI**.
- **TBD-AI-007 (blocking for write):** One workbook with owner/connector editing `Commands` also permits edits to `Results` and `Read_*`. Compare separate read-only publication and write-inbox workbooks under actually enforceable identities/permissions versus independently verifiable D1 receipts via a trusted channel. **Until the trust mechanism is proven end-to-end, do not treat Sheets status as independent D1 confirmation and do not enable automatic corrections.**
- **TBD-AI-008 (blocking for recovery):** command TTL, processing budgets, pause/revoke and resume controls, pending backlog quarantine, malformed/partially edited inbox rows, stale and duplicate result rows. Read-only v1 proposes **one complete atomic Sheets request**; any real multi-request/staged design is blocked until physical dual-slot layout, version/connector readback and recovery are independently approved. Stop on >2 MB internal budget or unknown response rather than silently splitting into unsafe writes.
- **TBD-AI-009 (blocking for free-tier feasibility):** Cloudflare Workers **Free** officially limits CPU time per Cron Trigger to **10 ms** (network wait excluded); account also has a per-invocation subrequest budget. Google OAuth2 service-account token signing, JSON parsing, D1 rows and Sheets serialization may exceed 10ms; there is no proof until a synthetic workload is profiled against an equivalent runtime, then authorized low-risk operation observed. Document peak/worst-case CPU, requests, retry budget and stoppage; if Free is not viable, **do not silently upgrade** and do not assert the 15-minute cron solution is feasible.

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
| S15 | Editor overwrites `Results` or `Meta` to claim success/freshness | ChatGPT cannot infer trusted success; verified channel required |
| S16 | Editor changes a `Commands` row before first Worker observation | No identity proof from Sheets; authorization limit/owner approval gate applies |
| S17 | Explicit non-drinking day vs absent drink rows vs drinking recorded with unknown cups | Three distinct states, never convert missing to 0g |
| S18 | Service paused, 2-day backlog and restored credential | Expired / unapproved commands quarantined, never auto catch-up |
| S19 | Partial snapshot across two Google API calls or tampered generation pointer | Reject complete/latest claim; last validated generation retained |
| S20 | Google API command submission works but connector readback cannot match ID | No "registered" claim; pending until independent D1 confirmation |
| S21 | 90-day snapshot + OAuth token creation exceed Free Cron 10ms CPU budget or subrequest limit | No silent paid upgrade; fail safely, reduce scope or select explicitly approved alternative |

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
- Cloudflare Worker Free CPU / Cron / subrequest limits: https://developers.cloudflare.com/workers/platform/limits/

**No production authorization results from this ADR.**