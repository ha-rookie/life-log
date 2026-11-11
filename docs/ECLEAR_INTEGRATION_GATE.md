# ECLEAR / life-log CI integration and approval boundaries

Updated: 2026-11-11 JST. Scope: technical [#147](https://github.com/ha-rookie/life-log/issues/147), acceptance [#142](https://github.com/ha-rookie/life-log/issues/142), parent [#124](https://github.com/ha-rookie/life-log/issues/124).

## Inputs and branch identity

- Base/main: `5af8f67f6be2a4a36833bc4c5bb2a7faf042e7db`.
- [Draft #145](https://github.com/ha-rookie/life-log/pull/145): 390px actual Vite/React browser with **synthetic intercepted APIs**, error paths, no browser network egress.
- [Draft #146](https://github.com/ha-rookie/life-log/pull/146): 390px actual Chromium with **real local HTTPS Workerd + disposable synthetic Wrangler local D1 + virtual CTAP2 passkey**. Production authentication files remain byte-identical to main; local RP is patched temporarily inside a disposable CI checkout.
- Integration branch: `test/issue-147-eclear-integration-safe-gates`. This copies both suites without merging either source PR. **Neither source PR nor this Draft is authorized to merge.**
- `.github/workflows/life-log-ci.yml` must retain independent `validate`, `chromium-e2e`, and `worker-browser-e2e` jobs. All three must pass on the same final HEAD before the integration is considered technically validated.

## How #142 automatic closure is prevented

The repository's `template-validation.yml` Scope Guard currently **requires exactly one closing Issue**, and reads that Issue's `## Planned Files` to validate the PR file set. A Draft with only `Refs #142` fails this unchanged guard.

Therefore, the test-only Drafts #145, #146 and this integration Draft use **`Closes #147`**, the dedicated CI/integration Issue, and **`Refs #142`**. Issue #147 covers all the planned test/workflow files; it may be completed once technical CI integration is authorized. Closing #147 **does not imply #142 or #124 are complete**. The offline CI test verifies that the integration PR contains exactly one closing issue and that it is #147; the existing Scope Guard independently verifies Planned Files against #147.

If any of these PRs is later merged, the GitHub closing-keyword behavior applies **only to #147**. Issue #142 and parent #124 remain open until physical Android, permitted UAT, and real-data acceptance. Do not change the shared Scope Guard solely to bypass its policy.

## Remote D1 metadata read on main push

**Current main is still unsafe to merge under a blanket Remote D1 read prohibition**: its `cloudflare-d1-readonly-check.yml` has a `push main` trigger and uses Cloudflare credentials to GET D1 metadata.

This integration Draft proposes switching that workflow to **manual `workflow_dispatch` only** and removing `push` entirely. The manual job requires:

1. Repository exactly `ha-rookie/life-log`, GitHub ref exactly `refs/heads/main`, and event `workflow_dispatch`.
2. A manually supplied exact 40-hex-digit SHA equal to both `GITHUB_SHA` and GitHub's live main ref; otherwise it fails **before Secrets or Cloudflare calls**.
3. Confirmation text `READ LIFELOG D1 METADATA` explicitly supplied by the authorized operator. The job-level condition also checks the text.
4. Only then may the pre-existing read-only Cloudflare token and D1 metadata GET steps execute; this is **not** approval to run them. No job is dispatched in this task.

The offline `scripts/verify-integration-gates.mjs` checks removal of all automatic events, exact-SHA and confirmation gates, ordering before both GET steps, presence of both browser jobs, no remote Wrangler commands, and the non-closure of #142. Its synthetic negative self-tests reject an automatic `push` trigger and any closing reference to #142.

Other one-shot `workflow_run` releases remain separately guarded by specific main-push commit prefixes and were not changed. The protected UAT deploy job does not automatically deploy from this test-only file set. **Reinspect all workflow triggers and the actual squash-commit title immediately before any separately approved merge.**

## What was and was not verified

- CI and local browser/Workerd/D1 check results apply only to synthetic data and local execution. The manual Cloudflare workflow cannot be safely invoked under the current prohibition, so testing it consists of offline static/negative validation, **not an observed production push or manual Cloudflare invocation**.
- Feature integration does not enable the v2 ECLEAR endpoint on remote UAT. Current remote Worker still lacks an approved security/Origin/config pathway for that endpoint.
- No Remote D1 read/write/migration, Cloudflare API, Secrets change, Worker deploy, personal measurement alteration, or main/source PR merge is authorized by this plan.

## Future individual approvals — not implicit in this Draft

1. Review/approve a specific main update integrating both E2E CI jobs **and** manual-only Cloudflare metadata check, verify final HEAD, Scope Guard and merge title, then authorize the main merge in a later request.
2. Implement and review independent UAT-only v2 authenticated, owner-only endpoint + Origin/intent/CSRF safeguards. **Never deploy local-only switches or test RP substitutions.**
3. Separately approve exact existing remote D1 schema/metadata read (if needed). Do not conflate it with user measurement reads.
4. Separately approve additive remote Migration `0005_eclear_enrichment_audit.sql` after backup / validation plan.
5. Separately approve any UAT-specific secret provision/config and a protected UAT deploy tied to a verified SHA.
6. Separately approve synthetic remote UAT test writes and physical Android passkey/CSV acceptance.
7. Separately authorize reviewed real ECLEAR source import, record-diff approval, one-time writes, and subsequent readback. Parent #124 and #142 remain open until accepted.

No further approvals are implied by green CI or by closing technical Issue #147.
