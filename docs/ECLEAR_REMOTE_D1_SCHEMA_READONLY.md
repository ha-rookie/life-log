# ECLEAR Migration 0005 — Remote D1 schema-only manual preflight

Date: 2026-11-12 (Thu, JST). Technical tracking: [#151](https://github.com/ha-rookie/life-log/issues/151). User acceptance [#142](https://github.com/ha-rookie/life-log/issues/142) and parent [#124](https://github.com/ha-rookie/life-log/issues/124) remain **OPEN**.

## Current authority / release boundary

This Draft PR prepares a separate GitHub Actions workflow, but **does not run it** and does not merge into main. No Remote D1 reads, writes, Migration or actual ECLEAR measurements are performed by code reviews, PR CI or local tests. GitHub requires a `workflow_dispatch` workflow to exist on the default branch before it can be triggered. Merging this workflow and dispatching it are **separate explicit approvals**.

The code is pinned to main commit `e6c9fc4c9d981f21872bf81f9d46f302dba600de` when the new branch was created. Any later approval must refer to the **then-current** exact main SHA.

## Fixed target and query scope

- Existing UAT binding: `DB`, Worker `life-log-uat`, database `life-log-dev`, UUID `421d0116-5c33-4782-a2b6-28f9684d3956`. The same exact D1 must appear as the single root and UAT D1 entry in `wrangler.jsonc`.
- The script first checks that the input SHA matches the GitHub event SHA and the **live main ref**; next it validates this repository, explicit confirmation and local D1 binding; then Cloudflare GET metadata must return that exact UUID and name. Only after identity verification can metadata SQL run.
- Cloudflare endpoint: `POST /client/v4/accounts/{account_id}/d1/database/{database_id}/query`. This HTTP endpoint accepts SQL that could mutate a database, so the inspector **never accepts caller-provided SQL** and requires each statement to equal one of the sealed application-defined read-only statements. It rejects semicolon batches. Existing Cloudflare credentials are scoped to the final remote step and are never printed. Prefer a token restricted to D1 Read at the future approval gate; **do not change any Secrets in this task**.
- Only selected `sqlite_schema` table/index DDL for the six pinned targets, names+timestamps from `d1_migrations`, and `PRAGMA table_info`, `index_list`, `foreign_key_list` on those six targets are permitted. Targets: `d1_migrations`, `body_measurements`, `eclear_enrichment_jobs`, `eclear_enrichment_row_audit`, `eclear_enrichment_cell_audit`, `eclear_enrichment_asserts`.
- No `SELECT`/COUNT of body measurements, activity, sessions, passkeys, credentials, import jobs, owners, or audit rows. **No actual data values** are read. Only **migration ledger metadata** is read as a table.
- The query layer enforces single-result shape, zero reported DB changes, exact expected output column names, bounded response sizes and valid metadata-only values. Raw API responses/errors and credentials are never logged. Workflow summary includes only DDL, migration filenames/timestamps, column/index/FK metadata and 0005 presence. Missing ledger means `0005` **unconfirmed**, not safe-to-migrate.

## Manual invocation gate (future separately approved operation)

New workflow: `.github/workflows/life-log-d1-schema-readonly-manual.yml`.

- Trigger: **only** `workflow_dispatch`, never `push`, `pull_request`, `workflow_run` or scheduled runs.
- Inputs: `target_sha` exact 40-hex current main SHA and `confirmation` exact text `READ LIFELOG D1 SCHEMA ONLY`.
- Requires repository `ha-rookie/life-log`, ref `refs/heads/main`, successful SHA match to `GITHUB_SHA`, checked-out HEAD and GitHub current main. The script checks live main again immediately before Cloudflare GET.
- Secret values are exposed **only in the last execution step**, after local/mocked security tests and SHA/binding preflight. No `set -x`, request body logging, or GitHub workflow artifacts.
- After a separately authorized future main merge and read approval, the workflow is callable using GitHub Actions → choose the workflow → **Run workflow**, or by an authorized GitHub Actions dispatch API/client. The currently connected GitHub tool supports reading workflow runs but **does not provide a workflow_dispatch action**; do not assume it will automatically execute from ChatGPT.

## Safety verification and evidence

`node --test scripts/d1-schema-readonly.check.mjs` performs *offline*, synthetic checks: exact allowed SQL, denial of measurement and session queries, forbidding schema and migration writes, wrong UUID, missing flags, wrong main SHA/ref/repository/confirmation, untrusted output columns, changed-DB response, and negative trigger tests. No external network is contacted in CI.

Repository validation / Scope Guard must pass for the planned five files. Normal local CI retains validation, synthetic local D1 migrations and two real 390px Chromium E2E jobs, unaffected by this inspector. The new inspector's remote mode is never called by PR CI.

## Decision rule after authorized metadata read

The audit is **informational only**, not migration authorization:

1. `d1_migrations` must exist, and ledger filenames/dates must be consistent with the expected local migrations. A missing ledger or truncated history blocks further action.
2. Compare the four enrichment tables and their columns/indexes/foreign keys against `migrations/0005_eclear_enrichment_audit.sql`; confirm `body_measurements` has seven composition columns.
3. If migration 0005 is present but table/constraints mismatch, halt; do not blindly rerun it. If it is absent and four tables are also absent, **only then** draft a separate additive migration review/approval plan.
4. Apply Migration 0005 only with a fresh explicit authorization and a reviewed backup/recovery plan. UAT HMAC Secret, UAT flags, deploy, synthetic acceptance and personally measured CSV data are **later separate approval gates**.

## Primary docs

Cloudflare D1 Query API: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/

Cloudflare D1 migrations table: https://developers.cloudflare.com/d1/reference/migrations/

GitHub manual workflows: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow

## One-shot automatic alternative (implementation only — Issue #153)

The manual workflow from PR #152 remains unchanged and manual-only. This independent Draft PR prepares a **single guarded workflow_run job** in `.github/workflows/life-log-d1-schema-once.yml` for cases where the connected GitHub app cannot call `workflow_dispatch`.

### Activation requires separate approval and a uniquely named Squash merge

- **Not activated by this Draft PR.** On the separately authorized merge, the exact **Squash commit subject** must be `audit(d1): one-shot ECLEAR schema metadata (#153)`. A different commit subject does **not** authorize a remote read. The Squash commit's only parent must be the pinned base `03eb6f1110b37d6cd9535f2102c23e0a229e96ba`. If main advances, STOP and re-review; do not loosen the pin.
- The Squash commit may change **exactly these five paths**: `.github/workflows/life-log-d1-schema-once.yml`, `.github/workflows/life-log-ci.yml`, `scripts/d1-schema-readonly.mjs`, `scripts/d1-schema-readonly.check.mjs`, `docs/ECLEAR_REMOTE_D1_SCHEMA_READONLY.md`. No `src/**`, `migrations/**`, `wrangler.jsonc`, package or protected UAT deploy workflow change.
- The `workflow_run` trigger is limited to the named **Life-log local app and D1 CI** workflow *completed* on the **main push** event; its conclusion must be `success`. No PR or manual/scheduled trigger. The preflight also checks the exact source CI run and verifies the latest `validate`, `chromium-e2e` and `worker-browser-e2e` jobs all completed SUCCESS.
- Before any Cloudflare credentials or requests: check `GITHUB_SHA`, checked-out HEAD, live main ref and source workflow head SHA all match; exact main parent and commit subject; exact five changed paths; pinned root+UAT D1 config and Owner-safe local constants. Concurrent runs for the same SHA are serialized.
- The first eligible one-shot run for that exact SHA is consumed. If a previous non-skipped one-shot run exists for the same SHA (including a failed or partially completed one), a later run fails before any Cloudflare access; retries require **new explicit user approval**. A manual rerun of the one-shot job is blocked by `GITHUB_RUN_ATTEMPT == 1`; a prior CI failure's skipped one-shot does not consume the gate.
- The only remote operations are Cloudflare GET for the fixed D1's UUID/name, followed by the existing fixed SQL allowlist's `sqlite_schema`, `d1_migrations` filename/time, and PRAGMA table/index/foreign-key metadata. These SQL queries use Cloudflare POST transport but cannot contain arbitrary user SQL or any personal rows/values. No Remote D1 mutations, migration application, Secrets changes or Worker deployment.
- Cloudflare secrets are only passed to the final, remote-read step. Preflight checks and 15 offline negative/positive Node test cases use only synthetic data. Output is restricted to schema metadata, migration filenames/time, 0005 status, and D1 identity; failures redact API response bodies.

### Execution sequence

1. Current task: create this technical Issue, independent branch, Draft PR and required CI, **no main merge and no Remote D1 read**.
2. Later: user separately approves final safety verification and exact-title Squash merge, including the consequent **one-time metadata read only**. If all checks pass, main CI runs and, only on main CI SUCCESS, the new one-shot read may run.
3. Read GitHub Actions job summary and logs (without raw personal values); compare Migration 0005 ledger record and target DDL/constraints. Any mismatch or missing ledger is a blocker; **never** infer that missing 0005 is permission to apply it.
4. Remote Migration 0005, UAT Secret/flags/deploy, real Android acceptance and ECLEAR personal CSV import remain **separate approvals**. Acceptance Issues #142 and #124 stay OPEN.
