#!/usr/bin/env bash
set -euo pipefail
# Synthetic-only integration. No --remote, credentials, deploys or personal data.
tmp="$(mktemp -d)"
worker_pid=""
cleanup(){
  if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; wait "$worker_pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
chmod 700 "$tmp"
state="$tmp/local-wrangler-state"
mkdir -p "$state"

npx --no-install wrangler d1 migrations apply DB --env uat --local --persist-to "$state"
node --input-type=module - "$tmp/seed.sql" "$tmp/boot-cookie" "$tmp/eclear.csv" "$tmp/eclear-conflict.csv" "$tmp/eclear-normal.csv" <<'NODE'
import {randomBytes,createHash} from "node:crypto";
import {writeFileSync} from "node:fs";
const [sqlFile,cookieFile,eclearFile,conflictFile,normalFile]=process.argv.slice(2);
const cookie=randomBytes(32).toString("hex");
const digest=createHash("sha256").update(cookie).digest("hex");
const now=Math.floor(Date.now()/1000);
const statements=[
  "INSERT INTO owners(id,created_at) VALUES('owner','2026-01-01T00:00:00Z');",
  "INSERT INTO owner_sessions(token_hash,owner_id,expires_at,created_at) VALUES('"+
    digest+"','owner',"+(now+1800)+","+now+");",
  "INSERT INTO body_measurements(id,owner_id,measured_at,source_timezone,weight_kg,body_fat_pct,source_id,source_row_key,source_kind) VALUES('synthetic-existing','owner','2026-01-02T07:40:00+09:00','Asia/Tokyo',75,25,'csv:eclear','synthetic-v1','measured');"
];
writeFileSync(sqlFile,statements.join("\n"),{mode:0o600});
writeFileSync(cookieFile,cookie,{mode:0o600});
const header="年月日,時刻,体重,体脂肪率,骨格筋率,BMI,内蔵脂肪レベル,骨量,基礎代謝量,メモ\n";
const marker="SYNTHETIC-NO-TRANSMIT-MEMO";
writeFileSync(eclearFile,header+'2026/01/02,07:40,75,25,36,23.5,7,3,1700,"'+marker+'"\n');
writeFileSync(conflictFile,header+'2026/01/02,07:40,75,29,36,23.5,7,3,1700,"'+marker+'"\n');
writeFileSync(normalFile,header+'2026/01/03,08:10,76,24,37,23.6,7,3.1,1710,"'+marker+'"\n');
NODE
npx --no-install wrangler d1 execute DB --env uat --local --persist-to "$state" --file "$tmp/seed.sql"
npx --no-install wrangler dev --env uat --local --ip 127.0.0.1 --port 8787 \
  --local-protocol https --persist-to "$state" \
  --var PASSWORD_ONLY_UAT:true \
  --var PASSKEY_LOCAL_E2E_ONLY:true \
  --var ECLEAR_ENRICHMENT_LOCAL_ONLY:true \
  --var ECLEAR_ENRICHMENT_REVIEW_KEY:synthetic-local-hmac-never-deploy-0000000000000001 \
  --var IMPORT_LOCAL_ONLY:true \
  --var MANUAL_REMOTE_WRITE_ENABLED:false >"$tmp/worker.log" 2>&1 &
worker_pid=$!
ready=0
for i in $(seq 1 50); do
  code=$(curl --insecure --silent --connect-timeout 2 --max-time 2 -o "$tmp/login.html" \
    -w '%{http_code}' https://localhost:8787/login || true)
  if [[ "$code" == "200" ]]; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "Local Workerd HTTPS startup failed" >&2
  tail -n 90 "$tmp/worker.log" >&2
  exit 1
fi
grep -Fq 'パスキーでログイン' "$tmp/login.html"
anon=$(curl --insecure --silent --max-time 4 -o /dev/null -w '%{http_code}' https://localhost:8787/api/dashboard)
[[ "$anon" == "403" ]] || { echo "Anonymous dashboard bypass: $anon" >&2; exit 1; }

node scripts/eclear-worker-browser-e2e.mjs \
  "$tmp/boot-cookie" "$tmp/eclear.csv" "$tmp/eclear-conflict.csv" "$tmp/eclear-normal.csv"
npx --no-install wrangler d1 execute DB --env uat --local --persist-to "$state" --json \
  --command "SELECT COUNT(*) AS n,SUM(CASE WHEN measured_at='2026-01-02T07:40:00+09:00' AND weight_kg=75 AND body_fat_pct=25 AND skeletal_muscle_pct=36 AND bmi=23.5 AND visceral_fat_level=7 AND bone_mass_kg=3 AND basal_metabolism_kcal=1700 THEN 1 ELSE 0 END) AS filled FROM body_measurements WHERE owner_id='owner'" \
  >"$tmp/results.json"
node --input-type=module - "$tmp/results.json" <<'NODE'
import {readFileSync} from "node:fs";
const payload=JSON.parse(readFileSync(process.argv[2],"utf8"));
const x=payload[0]?.results?.[0];
if(x?.n!==2||x?.filled!==1)throw Error("Local D1 readback does not match 1 enriched + 1 normal row");
console.log("PASS local D1: 1 enriched 7-field measurement preserved; 1 normal measurement; no duplicates");
NODE
echo "PASS: real browser -> real Worker -> synthetic local D1, virtual WebAuthn; remote accesses: 0"
