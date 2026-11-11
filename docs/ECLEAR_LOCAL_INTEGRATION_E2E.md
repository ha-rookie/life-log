# ECLEAR Stage 2C — Browser → Worker → synthetic local D1

Date: 2026-11-11. Scope: Issue #142 / parent #124, separate from Draft PR #145.

## Test under this Draft PR

- Actual compiled private React application served by local Workerd via TLS at
  `https://localhost:8787`; headless Chromium at 390×844 with CDP virtual
  CTAP2 internal authenticator, resident key and user verification.
- Synthetic Owner session is seeded **only** into a disposable Wrangler local D1.
  The browser registers a real virtual WebAuthn credential via the Worker,
  logs out (anonymous dashboard must return 403), and logs in by signing a real
  WebAuthn challenge. The Worker verifies challenge, RP, origin, UV, and stores
  the credential + new passkey session in synthetic local D1.
- The browser selects a synthetic 10-column ECLEAR source. Real Worker/D1
  preview identifies five NULL measurements and two already-equal values;
  explicit confirmation atomically fills five NULL fields. A new preview
  verifies completion, repetition is a no-op and a conflicting CSV cannot
  overwrite a non-NULL value. A separate normal ECLEAR CSV import uses the
  legacy API. Final local-only D1 query checks two measurement rows and
  confirms all seven preserved/filled fields on the original row.
- Real Chromium 390px viewport with no horizontal scrolling. The earlier
  browser-E2E-with-synthetic-API in Draft PR #145 remains an independent
  test for HTTP failures; no Remote UAT is exercised.

## Safe test-only RP origin

**Production auth source is unchanged**: `src/worker/passkey-auth.ts`,
`src/worker/index.ts` and `tests/passkey-auth.test.ts` remain byte-identical
to main. No runtime local-RP bypass flag is shipped in the Worker bundle.
Only the disposable CI checkout of `src/worker/passkey-auth.ts` is temporarily
patched by `scripts/eclear-worker-browser-local.sh` just before launching
`wrangler dev --env uat --local`: it changes the RP to `localhost` and
Origin to exact `https://localhost:8787`, plus a loopback synthetic IP
fallback for the existing rate limiter. The script restores the original file
on cleanup. The patched source is **never committed** or deployed.
Ordinary UAT-origin/Host/CSRF, rate limiting, browser UV and credential checks
remain unchanged in the real production Worker. Existing passkey security unit
tests continue to enforce the fixed UAT Origin and missing-rate-limiter denial.
The real browser E2E checks 403 anonymous access and successful signed login.

## Security / release boundary

- Local D1 migrations and writes only via `--local --persist-to` to a
  temporary directory. No `--remote`, Cloudflare API, Secrets, UAT deploy,
  personal measurements, production hosts or new D1 resources.
- The workflow runs only on pull requests and main pushes under the repository's
  existing local CI trigger; **this PR must remain Draft and not be merged**
  under the present ban. A future main push would independently trigger the
  existing Cloudflare D1 metadata GET workflow.
- CI validation is not acceptance of a physical Android passkey, live remote
  D1 migration, live Worker UAT, or personal ECLEAR import. Parent #124 and
  Stage 2C #142 stay open.

## Evidence labels

- Browser API-mocked E2E: Draft PR #145, run 42945409900: passed.
- Worker + local D1 + virtual-authenticator browser E2E: the latest check
  `worker-browser-e2e` on this PR (mark complete only after real CI success).
- Actual Android device and authorized remote UAT acceptance: pending.
