import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {getPlatformProxy} from "wrangler";
import initial from "../migrations/0001_initial.sql?raw";
import sessions from "../migrations/0002_owner_auth.sql?raw";
import passkey from "../migrations/0003_owner_passkey.sql?raw";
import enrichment from "../migrations/0005_eclear_enrichment_audit.sql?raw";
import {createHandler,type Env} from "../src/worker/index";
import {isSafeRemoteEclear} from "../src/worker/eclear-enrichment-route";
import type {ImportDb,Statement} from "../src/worker/import";

interface LocalStmt extends Statement{
  bind(...values:unknown[]):LocalStmt;
  run():Promise<unknown>;
}
interface LocalDb extends ImportDb{prepare(sql:string):LocalStmt;}
const ORIGIN="https://life-log-uat.ha-rookie.workers.dev";
const KEY="synthetic-uat-only-review-hmac-not-a-secret-00000001";
const COOKIE="e".repeat(64);
const CSV="年月日,時刻,体重,体脂肪率,骨格筋率,BMI,内蔵脂肪レベル,骨量,基礎代謝量,メモ\n"+
  "2026/01/02,07:40,75,25,36,23.5,7,3,1700,synthetic-confidential-memo\n";
const HEADER="X-Life-Log-Intent";
type Mode="preview"|"confirm";
function req(mode:Mode,csv=CSV,token?:string,overrides:Record<string,string|null>={},urlOrigin=ORIGIN){
  const headers:Record<string,string>={
    Origin:ORIGIN,"Sec-Fetch-Site":"same-origin", "Content-Type":"application/json",
    [HEADER]:"eclear-enrichment-v2",
    Cookie:"__Host-life_log_session="+COOKIE
  };
  for(const [name,value] of Object.entries(overrides)){
    if(value===null)delete headers[name];else headers[name]=value;
  }
  return new Request(urlOrigin+"/api/eclear/enrichment/"+mode,{
    method:"POST",headers,body:JSON.stringify(token===undefined?{csv}:{csv,token})
  });
}
function env(db:LocalDb,changes:Partial<Env>={}):Env{
  return {
    DB:db as unknown as Env["DB"],
    ASSETS:{fetch:async()=>new Response("private")},
    PASSWORD_ONLY_UAT:"true",
    ECLEAR_ENRICHMENT_REMOTE_ENABLED:"true",
    ECLEAR_ENRICHMENT_REMOTE_TARGET:"uat",
    ECLEAR_ENRICHMENT_REMOTE_ORIGIN:ORIGIN,
    ECLEAR_ENRICHMENT_REVIEW_KEY:KEY,
    ...changes
  };
}
async function migrate(db:LocalDb,sql:string){
  const text=sql.split("\n").filter(l=>!l.trimStart().startsWith("--")).join("\n");
  for(const s of text.split(";").map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();
}
const handler=createHandler(async()=>"owner");
const digest=async(value:string)=>{
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,"0")).join("");
};
describe("ECLEAR remote UAT Owner WebAuthn defense-in-depth (synthetic local D1 only)",()=>{
  let proxy:Awaited<ReturnType<typeof getPlatformProxy<{DB:LocalDb}>>>;
  let db:LocalDb;
  beforeAll(async()=>{
    proxy=await getPlatformProxy<{DB:LocalDb}>({
      configPath:"wrangler.jsonc",remoteBindings:false,persist:false
    });
    db=proxy.env.DB;
    for(const sql of [initial,sessions,passkey,enrichment])await migrate(db,sql);
  },100_000);
  afterAll(async()=>{await proxy?.dispose();},60_000);
  beforeEach(async()=>{
    for(const name of [
      "eclear_enrichment_cell_audit","eclear_enrichment_row_audit",
      "eclear_enrichment_jobs","eclear_enrichment_asserts",
      "owner_passkey_sessions","owner_sessions","owner_passkey_challenges",
      "body_measurements","import_row_audit","import_jobs","owners"
    ])await db.prepare("DELETE FROM "+name).run();
    await db.prepare("INSERT INTO owners(id,created_at) VALUES('owner','2026-01-01')").run();
    await db.prepare("INSERT INTO body_measurements(id,owner_id,measured_at,source_timezone,weight_kg,body_fat_pct,source_id,source_row_key,source_kind) VALUES('prior','owner','2026-01-02T07:40:00+09:00','Asia/Tokyo',75,25,'csv:eclear','old:2','measured')").run();
    const now=Math.floor(Date.now()/1000);
    await db.prepare("INSERT INTO owner_sessions(token_hash,owner_id,expires_at,created_at) VALUES(?,?,?,?)")
      .bind(await digest(COOKIE),"owner",now+600,now).run();
    await db.prepare("INSERT INTO owner_passkey_sessions(token_hash) VALUES(?)")
      .bind(await digest(COOKIE)).run();
  });
  const count=async(table:string)=>(await db.prepare(
    "SELECT COUNT(*) AS n FROM "+table).first<{n:number}>())?.n;
  const send=(request:Request,environment=env(db))=>handler.fetch(request,environment);
  const preview=async()=>{
    const res=await send(req("preview"));
    expect(res.status).toBe(200);
    return res.json() as Promise<{reviewToken:string;enrichCells:number;conflictMeasurements:number}>;
  };

  it("requires real passkey session, returns only counts, then atomically audits 5 NULL fills",async()=>{
    const first=await preview();
    expect(first.enrichCells).toBe(5);
    expect(JSON.stringify(first)).not.toContain("synthetic-confidential-memo");
    expect(JSON.stringify(first)).not.toContain("1700");
    expect(await count("eclear_enrichment_jobs")).toBe(0);
    const saved=await send(req("confirm",CSV,first.reviewToken));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({status:"applied",inserted:0,enriched:1,cells:5});
    const row=await db.prepare("SELECT weight_kg AS weight,body_fat_pct AS fat,skeletal_muscle_pct AS muscle,bmi,visceral_fat_level AS visceral,bone_mass_kg AS bone,basal_metabolism_kcal AS metabolic,source_id AS source FROM body_measurements WHERE id='prior'").first<Record<string,unknown>>();
    expect(row).toMatchObject({weight:75,fat:25,muscle:36,bmi:23.5,visceral:7,bone:3,metabolic:1700,source:"csv:eclear"});
    expect(await count("body_measurements")).toBe(1);
    expect(await count("eclear_enrichment_jobs")).toBe(1);
    expect(await count("eclear_enrichment_row_audit")).toBe(1);
    expect(await count("eclear_enrichment_cell_audit")).toBe(5);
    expect(await count("eclear_enrichment_asserts")).toBe(0);
    const again=await preview();
    expect(again.enrichCells).toBe(0);
    expect((await send(req("confirm",CSV,again.reviewToken))).status).toBe(200);
    expect(await count("eclear_enrichment_jobs")).toBe(1);
    expect(await count("body_measurements")).toBe(1);
  },100_000);

  it("rejects legacy Owner-only sessions and fake Access headers even with opt-in",async()=>{
    await db.prepare("DELETE FROM owner_passkey_sessions").run();
    const extras:Record<string,string|null>[]=[{}, {"Cf-Access-Authenticated-User-Email":"owner@example.test"}];
    for(const extra of extras){
      const res=await send(req("preview",CSV,undefined,extra));
      expect(res.status).toBe(403);
    }
    expect(await count("eclear_enrichment_jobs")).toBe(0);
  });

  it("requires independent UAT flag, target, trusted fixed Origin and HMAC secret",async()=>{
    const config=env(db);
    for(const change of [
      {ECLEAR_ENRICHMENT_REMOTE_ENABLED:undefined},
      {ECLEAR_ENRICHMENT_REMOTE_ENABLED:"false"},
      {ECLEAR_ENRICHMENT_REMOTE_TARGET:"production"},
      {ECLEAR_ENRICHMENT_REMOTE_ORIGIN:"https://evil.example"},
      {ECLEAR_ENRICHMENT_REMOTE_ORIGIN:ORIGIN+"/"},
      {ECLEAR_ENRICHMENT_REVIEW_KEY:undefined},
      {ECLEAR_ENRICHMENT_REVIEW_KEY:"weak"},
      {PASSWORD_ONLY_UAT:"false"},
    ]){
      expect((await send(req("preview"),{...config,...change})).status).toBe(403);
    }
    expect(await count("eclear_enrichment_jobs")).toBe(0);
  });

  it("rejects CSRF and request-Origin/Host spoofing including different port and HTTP",async()=>{
    const bad=[
      [req("preview",CSV,undefined,{Origin:"https://evil.example"}),403],
      [req("preview",CSV,undefined,{"Sec-Fetch-Site":"cross-site"}),403],
      [req("preview",CSV,undefined,{"Sec-Fetch-Site":null}),403],
      [req("preview",CSV,undefined,{[HEADER]:"manual-write-v1"}),403],
      [req("preview",CSV,undefined,{"Content-Type":"text/plain"}),403],
      [req("preview",CSV,undefined,{},ORIGIN+":8788"),403],
      [req("preview",CSV,undefined,{},"http://life-log-uat.ha-rookie.workers.dev"),403],
    ] as const;
    for(const [request,expected] of bad){
      expect((await send(request)).status).toBe(expected);
    }
    const query=req("preview");
    const withQuery=new Request(query.url+"?debug=1",{method:"POST",headers:query.headers,body:JSON.stringify({csv:CSV})});
    expect((await send(withQuery)).status).toBe(403);
    expect(await count("eclear_enrichment_jobs")).toBe(0);
  });

  it("rejects malformed/expired/tampered token and never persists an unapproved write",async()=>{
    const first=await preview();
    const corrupt=first.reviewToken.slice(0,-1)+(first.reviewToken.endsWith("0")?"1":"0");
    expect((await send(req("confirm",CSV,corrupt))).status).toBe(409);
    const parts=first.reviewToken.split(".");
    const expired=["1000000000000",parts[1],parts[2]].join(".");
    expect((await send(req("confirm",CSV,expired))).status).toBe(409);
    expect(await count("eclear_enrichment_jobs")).toBe(0);
  });

  it("rejects non-NULL conflicting values; never partially fills or writes audit",async()=>{
    await db.prepare("UPDATE body_measurements SET body_fat_pct=29 WHERE id='prior'").run();
    const p=await preview();
    expect(p.conflictMeasurements).toBe(1);
    expect((await send(req("confirm",CSV,p.reviewToken))).status).toBe(409);
    expect(await count("eclear_enrichment_jobs")).toBe(0);
    expect(await count("eclear_enrichment_cell_audit")).toBe(0);
    const row=await db.prepare("SELECT skeletal_muscle_pct AS muscle,body_fat_pct AS fat FROM body_measurements WHERE id='prior'").first<{muscle:number|null;fat:number}>();
    expect(row).toEqual({muscle:null,fat:29});
  });

  it("fails closed with HTTP 503 when passkey-session verification itself fails",async()=>{
    const unavailable={
      ...db,
      prepare(sql:string){
        if(sql.includes("JOIN owner_passkey_sessions"))throw Error("synthetic local D1 read error");
        return db.prepare(sql);
      }
    } as LocalDb;
    const res=await send(req("preview"),env(unavailable));
    expect(res.status).toBe(503);
    expect(await count("eclear_enrichment_jobs")).toBe(0);
  });

  it("policy does not trust a forged flag from the request body",async()=>{
    await db.prepare("DELETE FROM owner_passkey_sessions").run();
    const forged=new Request(ORIGIN+"/api/eclear/enrichment/preview",{
      method:"POST",
      headers:{Origin:ORIGIN,"Sec-Fetch-Site":"same-origin",
        "Content-Type":"application/json",[HEADER]:"eclear-enrichment-v2",
        Cookie:"__Host-life_log_session="+COOKIE},
      body:JSON.stringify({csv:CSV,ECLEAR_ENRICHMENT_REMOTE_ENABLED:"true",
        passkeySession:true})
    });
    expect((await send(forged)).status).toBe(403);
  });

  it("pure gate requires an explicit verified passkey boolean before DB access",()=>{
    const request=req("preview");
    const base={
      reviewKey:KEY,remote:{enabled:"true",target:"uat",origin:ORIGIN,passkeySession:false}
    };
    expect(isSafeRemoteEclear(request,base)).toBe(false);
    expect(isSafeRemoteEclear(request,{...base,remote:{...base.remote,passkeySession:true}})).toBe(true);
    expect(isSafeRemoteEclear(req("preview",CSV,undefined,{Origin:"https://evil.example"}),
      {...base,remote:{...base.remote,passkeySession:true}})).toBe(false);
  });
});
