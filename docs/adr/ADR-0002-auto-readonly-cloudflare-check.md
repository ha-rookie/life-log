# ADR-0002 — Automatically verify Cloudflare credentials and development D1 on trusted main

- Status: Proposed (pending Human review/merge of Issue #3 PR)
- Date: 2026-11-04
- Scope: Only the trigger/verification operation from ADR-0001 is superseded; its D1 isolation and infrastructure decisions remain unchanged.
- Related Issue: #3

## Context
The initial bootstrap ADR-0001 required a human to manually dispatch the Cloudflare credential / D1 metadata check. Other established app workflows such as mahjong-score run safe mechanical checks automatically. Manually starting a read-only verification after every approved main update creates unnecessary work and leaves credentials unverified.

## Decision
1. The existing `.github/workflows/cloudflare-d1-readonly-check.yml` runs automatically on `push` to `main` only, and has a defensive job guard requiring `github.repository == 'ha-rookie/life-log'`, `github.ref == 'refs/heads/main'`, and `github.event_name == 'push'`.
2. Do not activate this credential-bearing workflow for `pull_request`, `pull_request_target`, `workflow_dispatch`, schedule, tags, or feature branches. Existing separate `Repository validation` remains the PR check, and consumes no Cloudflare secrets.
3. The job reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from GitHub repository Secrets only at trusted main execution. It checks presence without printing values.
4. It performs only HTTPS GET requests to Cloudflare for API token status and `life-log-dev` D1 database metadata (UUID `421d0116-5c33-4782-a2b6-28f9684d3956`). Match name and UUID, emit only non-sensitive pass/fail summaries.
5. Do not perform Remote D1 SQL, rows/data access, migrations, writes, Worker/Pages deploy, Cloudflare Access mutation, Secrets mutation, or paid upgrades.
6. Human review/approval of the exact PR head SHA is required before main merge. No auto-merge or deployment.
7. API token active + D1 metadata GET success confirms those specific conditions, **not** the ability to run D1 SQL, apply migrations or attach Worker Bindings; these require separate approval and evidence.

## Alternatives
- Keep `workflow_dispatch` as the only trigger: rejected; it creates avoidable routine manual work.
- Run credential checks on PR: rejected; no secret should flow to unreviewed PR changes.
- Run on every feature branch push: rejected; not the trusted source of code.
- Add scheduling: not needed, additional billing/quota and alert overhead.
- Check on main push with branch path filters: omitted to prevent missed verification when unrelated approved changes affect permissions/workflow execution.

## Security / Operational Risks
- Trusted main must remain a human merge gate. Repository-level enforcement of branch protection may not exist on private personal repos; operational review remains mandatory.
- A failed check must be reported as a failing GitHub Actions run. Do not silently turn failure into success.
- A successful static PR CI does not validate the actual Cloudflare credentials; the main push run is the first live verification.
- Existing token might lack D1 read permission or be missing; do not ask the Human to post a secret value.
- No extra third-party Actions, PR checkout, or executable untrusted input in the credential-bearing job.

## Recovery
Use GitHub Actions logs/step conclusions to distinguish missing Secret, inactive token, wrong Account ID, D1 permission errors or wrong UUID/name. Rerun failed workflow after fixing external settings where appropriate. Workflow changes require an Issue-specific PR and human merge. No Cloudflare rollback is necessary because the workflow is read-only.

## Validation
- Static diff analysis: main-only push, no PR/dispatch trigger, job guard, no non-GET Cloudflare operations.
- Pull request: `Repository validation` SUCCESS, no Cloudflare credential-bearing job.
- Actual Cloudflare API/D1 results: **unverified until a future approved merge triggers main push**.
