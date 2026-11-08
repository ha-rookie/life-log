#!/usr/bin/env bash
set -euo pipefail
# Workerd passkey-session regression. Completely synthetic credentials, local D1 only.
tmp="$(mktemp -d)"
worker_pid=""
cleanup() {
  if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; wait "$worker_pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
chmod 700 "$tmp"

npx --no-install wrangler d1 migrations apply DB --env uat --local
node --input-type=module - "$tmp/fixture.sql" "$tmp/cookie" <<'NODE'
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
const token=randomBytes(32).toString("hex");
const hash=createHash("sha256").update(token).digest("hex");
const now=Math.floor(Date.now()/1000);
writeFileSync(process.argv[2],[
  "INSERT OR IGNORE INTO owners(id,created_at) VALUES('owner','2026-01-01T00:00:00Z');",
  "INSERT INTO owner_sessions(token_hash,owner_id,expires_at,created_at)",
  "VALUES('" + hash + "','owner'," + (now+3600) + "," + now + ");",
  "INSERT INTO owner_passkey_sessions(token_hash) VALUES('" + hash + "');",
].join("\n"),{mode:0o600});
writeFileSync(process.argv[3],"__Host-life_log_session="+token,{mode:0o600});
NODE
npx --no-install wrangler d1 execute DB --env uat --local --file "$tmp/fixture.sql"

npx --no-install wrangler dev --local --env uat --ip 127.0.0.1 --port 8787 \
  --local-protocol=https --infer-origin-from-routes=false \
  --var PASSWORD_ONLY_UAT:true \
  --var MANUAL_REMOTE_WRITE_ENABLED:false >"$tmp/worker.log" 2>&1 &
worker_pid=$!
url="https://127.0.0.1:8787"
ready=0
for i in $(seq 1 30); do
  status=$(curl --insecure --silent --max-time 2 -o "$tmp/login.html" -w '%{http_code}' "$url/login" || true)
  if [[ "$status" == "200" ]]; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  cat "$tmp/worker.log" >&2
  echo "Local Workerd did not serve login page" >&2
  exit 1
fi
grep -Fq 'パスキーでログイン' "$tmp/login.html"
if grep -Eq 'id="password"|id="username"|form id="login"' "$tmp/login.html"; then
  echo "Password or username input remains in UAT page" >&2
  exit 1
fi

for endpoint in login register; do
  result=$(curl --insecure -sS --max-time 20 -o "$tmp/$endpoint.json" -w '%{http_code}' \
    --request POST "$url/api/auth/$endpoint" \
    --header "Origin: $url" --header "Sec-Fetch-Site: same-origin" \
    --header "Content-Type: application/json" \
    --header "X-Life-Log-Intent: register-v1" \
    --data '{"username":"owner","password":"synthetic-retired-password"}')
  if [[ "$result" != 410 ]]; then
    echo "Retired $endpoint expected HTTP 410, got $result" >&2
    exit 1
  fi
done

anon=$(curl --insecure -sS -o /dev/null -w '%{http_code}' "$url/api/summary")
[[ "$anon" == 403 ]] || { echo "Anonymous API bypass: $anon" >&2; exit 1; }

authenticated=$(curl --insecure -sS --max-time 20 -o "$tmp/summary.json" -w '%{http_code}' \
  -b "$(cat "$tmp/cookie")" "$url/api/summary")
[[ "$authenticated" == 200 ]] || { echo "Passkey session API expected 200: $authenticated" >&2; exit 1; }
echo 'PASS: local Workerd Owner session -> authenticated summary 200, anonymous 403, retired password routes 410, passkey-only UI; WebAuthn origin boundary is separately tested.'
