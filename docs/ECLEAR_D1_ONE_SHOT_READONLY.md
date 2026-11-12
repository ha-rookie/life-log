# ECLEAR Remote D1 metadata-only one-shot CI trigger

This Draft PR prepares a **separately approved** one-time read-only D1 metadata inspection. **It does not authorize merging this PR**. Once approved and merged, the one-shot GitHub Actions job may run exactly once for the exact squash commit and only after the normal main CI succeeds.

- Existing D1: `life-log-dev`, UUID `421d0116-5c33-4782-a2b6-28f9684d3956`; root and UAT Wrangler bindings must match.
- The job must accept only a main **push** `workflow_run` of `Life-log local app and D1 CI` with `conclusion=success`, exact approved squash commit title, and exact changed-file allowlist. It must compare the checked-out SHA and current main SHA.
- SQL stays restricted to the existing fixed allowlist of `sqlite_schema`, `d1_migrations` filename/timestamp and `PRAGMA table_info/index_list/foreign_key_list`. No user-provided SQL, no measurement rows, no session/credential/audit row values.
- The workflow must check DB identity by UUID/name before any query, and use the existing Cloudflare credentials only in the final read step. Do not change Secrets.
- The new trigger is **not** included in PR CI, does not run on PR creation or updates, and does not invoke Wrangler deploy, remote migrations or writes.
- Existing manual-only workflow remains intact. This new workflow is an alternative one-time trigger.
- A fresh approval is required before Ready-for-review or squash merge. A successful merge of this exact PR is the user's separate conditional authorization for **only this single metadata read**.
- `#142` and `#124` remain open until real acceptance. Migration `0005` is **not** authorized by a successful read.
