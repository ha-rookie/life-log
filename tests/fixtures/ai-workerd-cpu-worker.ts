/**
 * Issue #313 local-only CPU profiler fixture: standalone Worker, never imported by
 * application index, deployed, configured with real bindings, or given credentials.
 * All data is fabricated and service-account keys are ephemeral WebCrypto test keys.
 */
import { projectAiReadSnapshot, type AiReadDb, type AiReadOptions } from "../../src/worker/ai-read-model";
import {
  FakeSheets, prepareSheetSnapshot, type Prepared, type Layout, type Tab
} from "../../src/worker/ai-sheet-snapshot";
import {
  GOOGLE_DRIVE_FILE_SCOPE, type ServiceIdentity, type TokenTransport
} from "../../src/worker/ai-google-auth";
import { scheduled, type ScheduledReadContext } from "../../src/worker/ai-sync-scheduled";

const OWNER = "synthetic_cpu_owner_313";
const NOW = Date.parse("2026-11-25T05:00:00Z");
const END = Date.parse("2026-11-24T00:00:00Z");
const TABS: Tab[] = [
  "Read_Weight", "Read_Steps", "Read_Meals", "Read_Drinks", "Read_DrinkDays",
  "Sync_Status", "Meta"
];
const LAYOUT: Layout = Object.fromEntries(TABS.map((tab, i) => [
  tab, { sheetId: 30 + i, rowCapacity: 1100, columnCapacity: 20 }
])) as Layout;

class FakeStatement {
  values: unknown[] = [];
  constructor(readonly sql: string) {}
  bind(...values: unknown[]): this { this.values = values; return this; }
  async all<T>(): Promise<{results: T[]}> { return { results: [] }; }
}
function dbFor(days: number, populated: boolean): AiReadDb {
  const rows: unknown[][] = [[], [], [], []];
  if (populated) for (let i = 0; i < days; i++) {
    const day = new Date(END - (days - 1 - i) * 86400000).toISOString().slice(0, 10);
    const measured_at = day + "T08:00:00+09:00";
    rows[0].push({id:"w"+i,measured_at,weight_kg:70+i%10/10,source_id:"manual:cpu",source_kind:"measured",anomaly_flag:0});
    rows[1].push({id:"s"+i,local_day:day,steps:i%5===0?0:7000+i,source_id:"manual:cpu"});
    rows[2].push({local_day:day,drinking_presence:i%3===0?1:0,drink_cups:i%3===0?1:0,lunch_kind:"home",dinner_kind:"home",late_meal:0,source_id:"manual:cpu"});
    if(i%3===0) rows[3].push({id:"d"+i,observed_at:day+"T20:00:00+09:00",drink_kind:"beer",drink_variant:null,source_id:"manual:cpu",alcohol:1,cups:1,volume_ml:350,abv_pct:5});
  }
  return {
  prepare: sql => new FakeStatement(sql),
  batch: async statements => {
    if (statements.length !== 4) throw Error("FAKE_D1_BATCH_ONLY");
    for (const statement of statements as FakeStatement[]) {
      if (!statement.sql.trimStart().startsWith("SELECT ") ||
          !statement.sql.includes("owner_id=?") ||
          statement.values[0] !== OWNER)
        throw Error("FAKE_D1_OWNER_SCOPING");
    }
    return rows.map(results => ({results}));
  }
  };
}
const options = (days: number): AiReadOptions => ({
  from: new Date(END - (days - 1) * 86400000).toISOString().slice(0, 10),
  to: new Date(END).toISOString().slice(0, 10),
  generatedAtUtc: "2026-11-25T04:00:00Z",
  generationId: "synthetic_workerd_cpu_" + days
});
let keyPair: CryptoKeyPair | null = null;
const baseline = new Map<string, Prepared>();
const keyFor = (days: number, populated: boolean) => `${days}:${populated}`;
async function warmup(days: number, populated: boolean): Promise<void> {
  if (!keyPair) {
    keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
        publicExponent: new Uint8Array([1,0,1]), hash: "SHA-256"
      }, false, ["sign", "verify"]
    ) as CryptoKeyPair;
  }
  const key = keyFor(days, populated);
  if (!baseline.has(key)) {
    const snap = await projectAiReadSnapshot(dbFor(days,populated), OWNER, options(days));
    if(populated && (snap.rows.Read_Weight.length!==days || snap.rows.Read_Drinks.length!==Math.ceil(days/3)))
      throw Error("POPULATED_FIXTURE_NOT_PROJECTED");
    baseline.set(key, await prepareSheetSnapshot(snap));
  }
}
async function exercise(days: number, populated: boolean) {
  const key = keyFor(days, populated);
  if (!keyPair || !baseline.has(key)) throw Error("WARMUP_REQUIRED");
  const fake = new FakeSheets();
  const prepared = baseline.get(key)!;
  const identity: ServiceIdentity = {
    clientEmail: "synthetic-cpu@test-project.iam.gserviceaccount.com",
    privateKey: keyPair.privateKey, scope: GOOGLE_DRIVE_FILE_SCOPE
  };
  const tokenTransport: TokenTransport = {
    exchange: async request => {
      if (request.endpoint !== "https://oauth2.googleapis.com/token")
        throw Error("UNEXPECTED_TOKEN_ENDPOINT");
      return {
        status: 200,
        json: {
          access_token: "synthetic_cpu_only_token", expires_in: 600,
          token_type: "Bearer", scope: GOOGLE_DRIVE_FILE_SCOPE
        }
      };
    }
  };
  const context: ScheduledReadContext = {
    db: dbFor(days,populated), trustedOwner: OWNER, options: options(days),
    spreadsheetId: "synthetic_cpu_spreadsheet_313",
    layout: LAYOUT, identity, tokenTransport,
    sheet: {
      probe: async () => fake.activeGeneration === null ? "empty" : "occupied",
      reader: fake,
      submit: async request => {
        if (request.endpoint !==
            "https://sheets.googleapis.com/v4/spreadsheets/synthetic_cpu_spreadsheet_313:batchUpdate" ||
            request.body.requests.length !== 7)
          throw Error("INVALID_FAKE_SHEETS_REQUEST");
        await fake.publishAtomic(prepared, LAYOUT);
        return { status: 200 };
      }
    },
    trustedNowMs: NOW,
    cpuMeter: { usedMs: () => 0 }, // Only the Inspector measures local CPU.
    pause: async () => { throw Error("UNEXPECTED_RETRY"); }
  };
  const report = await scheduled(context);
  if (report.status !== "sheet_copy_verified" ||
      report.authority !== "sheet-copy-only" ||
      report.subrequests !== 15)
    throw Error("SYNTHETIC_B3_PROFILE_FAILED");
  return {
    days, populated, payloadBytes: report.payloadBytes,
    subrequests: report.subrequests,
    outcome: report.status,
    cpuMeterEvidence: report.cpuEvidence
  };
}
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/warmup" && url.pathname !== "/profile")
      return new Response("Not Found", {status: 404});
    const days = Number(url.searchParams.get("days"));
    const populated = url.searchParams.get("populated") === "1";
    if (![30,90,366].includes(days))
      return new Response("Invalid synthetic window", {status: 400});
    try {
      if (url.pathname === "/warmup") {
        await warmup(days,populated);
        return Response.json({days, populated, ready: true});
      }
      return Response.json(await exercise(days,populated));
    } catch {
      // No JWT, key material, personal records, or provider error detail in logs.
      return Response.json({error: "SYNTHETIC_PROFILE_FAILED"}, {status: 500});
    }
  }
};
