#!/usr/bin/env bash
set -euo pipefail
# CI/local Workerd acceptance test. All credentials synthetic; never remote D1.
tmp="$(mktemp -d)"
worker_pid=""
cleanup() {
  if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; wait "$worker_pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
npx --no-install wrangler d1 migrations apply DB --env uat --local
node --input-type=module - "$tmp/fixture.sql" <<'NODE'
import { scryptSync } from "node:crypto";
import { writeFileSync } from "node:fs";
const salt = "11223344556677889900aabbccddeeff";
const password = "synthetic-owner-credential-2026";
const hash = scryptSync(password, Buffer.from(salt, "hex"), 32, { N:32768, r:8, p:3, maxmem:64*1024*1024 }).toString("hex");
const encoded = ["scrypt",32768,8,3,hash].join("$");
writeFileSync(process.argv[2], [
  "INSERT OR IGNORE INTO owners(id,created_at) VALUES('owner','2026-01-01T00:00:00Z');",
  "INSERT OR REPLACE INTO owner_credentials(owner_id,password_salt,password_hash,iterations,created_at)",
  "VALUES('owner','" + salt + "','" + encoded + "',100000,'2026-01-01T00:00:00Z');",
].join("\n"));
NODE
npx --no-install wrangler d1 execute DB --env uat --local --file "$tmp/fixture.sql"
npx --no-install wrangler dev --local --env uat --ip 127.0.0.1 --port 8787 \
  --local-protocol=https --infer-origin-from-routes=false \
  --var PASSWORD_ONLY_UAT:true \
  --var MANUAL_REMOTE_WRITE_ENABLED:false >"$tmp/worker.log" 2>&1 &
worker_pid=$!
url="https://127.0.0.1:8787"
ready=0
for i in $(seq 1 25); do
  status=$(curl --insecure --silent --max-time 2 --output /dev/null --write-out '%{http_code}' "$url/login" || true)
  if [[ "$status" == "200" ]]; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  cat "$tmp/worker.log" >&2
  echo "Local Workerd did not serve login page" >&2
  exit 1
fi
auth() {
  local password="$1" cookie_out="$2"
  curl --insecure --silent --show-error --max-time 30 \
    --output "$tmp/response.json" --write-out '%{http_code}' \
    --cookie-jar "$cookie_out" \
    --request POST "$url/api/auth/login" \
    --header "Origin: $url" \
    --header "Sec-Fetch-Site: same-origin" \
    --header "CF-Connecting-IP: 203.0.113.45" \
    --header "Content-Type: application/json" \
    --header "X-Life-Log-Intent: register-v1" \
    --data "{\"username\":\"owner\",\"password\":\"$password\"}"
}
wrong=$(auth "invalid-synthetic-password" "$tmp/wrong-cookies")
if [[ "$wrong" != "401" ]]; then
  echo "Invalid password expected 401; actual HTTP $wrong" >&2
  cat "$tmp/response.json" >&2
  exit 1
fi
valid=$(auth "synthetic-owner-credential-2026" "$tmp/cookies")
if [[ "$valid" != "200" ]]; then
  echo "Valid WORKHUB scrypt password expected 200; actual HTTP $valid" >&2
  cat "$tmp/response.json" >&2
  exit 1
fi
summary=$(curl --insecure --silent --show-error --max-time 20 \
  --cookie "$tmp/cookies" --output "$tmp/summary.json" \
  --write-out '%{http_code}' "$url/api/summary")
if [[ "$summary" != "200" ]]; then
  echo "Authenticated summary expected 200; actual HTTP $summary" >&2
  cat "$tmp/summary.json" >&2
  exit 1
fi
anon=$(curl --insecure --silent --max-time 15 --output /dev/null --write-out '%{http_code}' "$url/")
if [[ "$anon" != "403" ]]; then
  echo "Anonymous root expected 403; actual HTTP $anon" >&2
  exit 1
fi
echo "PASS: local Workerd WORKHUB scrypt N32768 r8 p3, 401 wrong / 200 correct / cookie summary 200 / anonymous 403"
