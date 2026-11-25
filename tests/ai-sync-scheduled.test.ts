import {beforeAll,describe,expect,it} from "vitest";
import {projectAiReadSnapshot,type AiReadDb,type AiReadOptions} from "../src/worker/ai-read-model";
import {
  FakeSheets,buildAtomicBatch,prepareSheetSnapshot,verifyReadSnapshot,
  type Prepared,type Layout,type Tab
} from "../src/worker/ai-sheet-snapshot";
import {
  GOOGLE_DRIVE_FILE_SCOPE,type ServiceIdentity,type TokenTransport
} from "../src/worker/ai-google-auth";
import {
  scheduled,SHEETS_BATCH_ENDPOINT,
  type InjectedSheetGateway,type SheetSubmit,type ScheduledReadContext
} from "../src/worker/ai-sync-scheduled";

const NOW=Date.parse("2026-11-25T05:00:00Z");
const OWNER="trusted-synthetic-owner",OTHER="synthetic-other-owner";
const END="2026-11-24",GENERATED="2026-11-25T04:00:00Z";
const date=(offset:number)=>new Date(Date.parse(END+"T00:00:00Z")+
  offset*86400000).toISOString().slice(0,10);
const opts=(days=30,id="synthetic_b3_001"):AiReadOptions=>({
  from:date(-(days-1)),to:END,generatedAtUtc:GENERATED,generationId:id
});
const tabs:Tab[]=[
  "Read_Weight","Read_Steps","Read_Meals","Read_Drinks","Read_DrinkDays",
  "Sync_Status","Meta"
];
const layout=():Layout=>Object.fromEntries(tabs.map((name,i)=>[
  name,{sheetId:i+20,rowCapacity:1100,columnCapacity:20}
])) as Layout;
type DbRecord=Record<string,unknown>;
class SyntheticStatement{
  args:unknown[]=[];
  constructor(readonly sql:string){}
  bind(...args:unknown[]):this{this.args=args;return this;}
  async all<T>():Promise<{results:T[]}>{return {results:[]};}
}
class FakeOwnerD1{
  batches=0;writes=0;
  weights:DbRecord[]=[
    {id:"m1",owner_id:OWNER,measured_at:"2026-11-24T09:00:00+09:00",
      weight_kg:70,source_id:"manual:weight",source_kind:"measured",anomaly_flag:0},
    {id:"e1",owner_id:OWNER,measured_at:"2026-11-24T08:00:00+09:00",
      weight_kg:69.8,source_id:"eclear",source_kind:"measured",anomaly_flag:0},
    {id:"private",owner_id:OTHER,measured_at:"2026-11-24T08:00:00+09:00",
      weight_kg:99,source_id:"eclear",source_kind:"measured",anomaly_flag:0}
  ];
  steps:DbRecord[]=[
    {id:"fit24",owner_id:OWNER,local_day:END,steps:0,source_id:"fit"},
    {id:"manual23",owner_id:OWNER,local_day:date(-1),steps:7000,source_id:"manual:steps"},
    {id:"other-fit",owner_id:OTHER,local_day:END,steps:99000,source_id:"fit"}
  ];
  lifestyles:DbRecord[]=[
    {owner_id:OWNER,local_day:END,drinking_presence:0,drink_cups:0,
      lunch_kind:"home",dinner_kind:null,late_meal:0,source_id:"manual:meals"},
    {owner_id:OWNER,local_day:date(-1),drinking_presence:0,drink_cups:0,
      lunch_kind:null,dinner_kind:null,late_meal:null,source_id:"manual:meals"},
    {owner_id:OTHER,local_day:END,drinking_presence:1,drink_cups:8,
      lunch_kind:"other",dinner_kind:null,late_meal:0,source_id:"manual:meals"}
  ];
  drinks:DbRecord[]=[
    {id:"d1",owner_id:OWNER,observed_at:date(-1)+"T21:00:00+09:00",
      drink_kind:"highball",drink_variant:null,source_id:"manual:drink",
      alcohol:1,cups:1,volume_ml:200,abv_pct:5},
    {id:"other-drink",owner_id:OTHER,observed_at:END+"T22:00:00+09:00",
      drink_kind:"highball",drink_variant:null,source_id:"manual:drink",
      alcohol:1,cups:8,volume_ml:null,abv_pct:null}
  ];
  db:AiReadDb={
    prepare:(sql:string)=>new SyntheticStatement(sql),
    batch:async statements=>{
      this.batches++;
      if(statements.length!==4)throw Error("INVALID_READ_BATCH");
      const queries=statements as SyntheticStatement[];
      for(const statement of queries){
        if(!statement.sql.startsWith("SELECT ")||
          !statement.sql.includes("owner_id=?")||statement.args[0]!==OWNER)
          throw Error("OWNER_SCOPED_SELECT_ONLY");
      }
      return [this.weights,this.steps,this.lifestyles,this.drinks].map(items=>({
        results:items.filter(item=>item.owner_id===OWNER).map(({owner_id:__unused,...record})=>{
          void __unused;
          return record;
        })
      }));
    }
  };
}
let keypair:CryptoKeyPair;
const identity=():ServiceIdentity=>({
  clientEmail:"synthetic-sync@test-project.iam.gserviceaccount.com",
  privateKey:keypair.privateKey,scope:GOOGLE_DRIVE_FILE_SCOPE
});
const token=(
  status=200
):TokenTransport=>({exchange:async()=>({status,json:{
  access_token:"synthetic_access_token_only",expires_in:600,token_type:"Bearer"
}})});
const cpu={usedMs:()=>0};
type Scenario=200|401|403|429|503|"timeout"|"after-apply-timeout"|"no-apply"|"429-after-apply";
function gateway(fake:FakeSheets,prepared:Prepared,ly:Layout,script:Scenario[]=[200]):{
  gateway:InjectedSheetGateway;calls:SheetSubmit[]
}{
  const calls:SheetSubmit[]=[];
  return {
    calls,
    gateway:{
      probe:async()=>fake.activeGeneration===null?"empty":"occupied",
      reader:fake,
      submit:async request=>{
        calls.push(request);
        const action=script.shift()??200;
        if(action==="timeout")throw Error("SENSITIVE_KEY_DO_NOT_LOG");
        if(action==="no-apply")return {status:200};
        if(action==="after-apply-timeout"){
          await fake.publishAtomic(prepared,ly);
          throw Error("ACK_LOST_SENSITIVE_KEY");
        }
        if(action==="429-after-apply"){
          await fake.publishAtomic(prepared,ly);
          return {status:429};
        }
        if(action===200)await fake.publishAtomic(prepared,ly);
        return {status:action};
      }
    }
  };
}
async function setup(days=30,gen="synthetic_b3_001",script:Scenario[]=[200]){
  const source=new FakeOwnerD1(),options=opts(days,gen),ly=layout(),fake=new FakeSheets();
  const original=await projectAiReadSnapshot(source.db,OWNER,options);
  const prepared=await prepareSheetSnapshot(original);
  const api=gateway(fake,prepared,ly,[...script]);
  const delays:number[]=[];
  const context:ScheduledReadContext={
    db:source.db,trustedOwner:OWNER,options,spreadsheetId:"synthetic_sheet_1234567890",
    layout:ly,identity:identity(),tokenTransport:token(),
    sheet:api.gateway,cpuMeter:cpu, trustedNowMs:NOW,
    pause:async(ms)=>{delays.push(ms);}
  };
  return {source,original,prepared,ly,fake,api,delays,context};
}

describe("B3 scheduled-only pipeline, no actual network/D1/Google/Cron",()=>{
  beforeAll(async()=>{
    keypair=await crypto.subtle.generateKey({
      name:"RSASSA-PKCS1-v1_5",modulusLength:2048,
      publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"
    },true,["sign","verify"]) as CryptoKeyPair;
  },60000);

  it("S01: real B1 producer through B2 one-request manifest to Fake Sheets and readback",async()=>{
    const s=await setup();
    const report=await scheduled(s.context);
    expect(report).toMatchObject({
      status:"sheet_copy_verified",reason:"SHEET_INTERNAL_CONSISTENCY_ONLY",
      authority:"sheet-copy-only",cpuEvidence:"injected-synthetic-only",
      generationId:s.original.generation_id,digest:s.original.generation_digest
    });
    expect(s.original.canonical_weight_keys[END]).toBe(
      s.original.rows.Read_Weight.find(r=>r.source_type==="eclear")?.record_key
    );
    expect(s.original.rows.Read_Steps.at(-1)).toMatchObject({
      steps:0,value_state:"present",source_type:"fit"
    });
    expect(s.original.rows.Read_DrinkDays.at(-1)).toMatchObject({
      drinking_presence:0,drink_cups:0,drink_cups_value_state:"present"
    });
    expect(s.original.warnings).toContain("DRINK_DAY_CONFLICT:"+date(-1));
    expect(s.original.rows.Read_DrinkDays.at(-2)?.drinking_presence).toBeNull();
    expect(s.original.rows.Read_Meals.at(-1)?.late_meal).toBe(0);
    expect(JSON.stringify(s.prepared)).not.toContain("other-drink");
    expect(JSON.stringify(s.prepared)).not.toContain("owner_id");
    expect(s.source.writes).toBe(0);
    expect(s.api.calls).toHaveLength(1);
    const only=s.api.calls[0];
    expect(only.endpoint).toBe(SHEETS_BATCH_ENDPOINT+s.context.spreadsheetId+":batchUpdate");
    expect(only.authorization).toBe("Bearer synthetic_access_token_only");
    expect(only.body).toEqual(buildAtomicBatch(s.prepared,s.ly).body);
    expect(only.body.requests).toHaveLength(7);
    expect(report.subrequests).toBe(15); // 4 SQL + probe + OAuth + post + 8 readback.
    expect((await verifyReadSnapshot(s.fake,new Date(NOW).toISOString())).consistency)
      .toBe("consistent");
  });

  it("S02: bounded 30/90/366 day B1/B2 synthetic windows; wall time is not Free CPU",async()=>{
    for(const days of [30,90,366]){
      const s=await setup(days,"synthetic_"+days+"_0001");
      const start=performance.now();
      const report=await scheduled(s.context);
      const wallMs=performance.now()-start;
      expect(report.status).toBe("sheet_copy_verified");
      expect(s.original.counts.Read_Steps).toBe(days);
      expect(s.original.counts.Read_Meals).toBe(days);
      expect(s.original.counts.Read_DrinkDays).toBe(days);
      expect(report.payloadBytes).toBeLessThan(2_000_000);
      expect(report.subrequests).toBeLessThanOrEqual(50);
      expect(report.cpuSampleMs).toBe(0); // Injected synthetic counter, not measured Worker CPU.
      expect(wallMs).toBeGreaterThanOrEqual(0);
      console.info("B3 synthetic ONLY, NOT Workers Free CPU",
        JSON.stringify({days,payloadBytes:report.payloadBytes,
          reservedSubrequestCount:report.subrequests,localWallMs:+wallMs.toFixed(2)}));
    }
  });

  it("S03: identical generation yields already; changed content with same ID rejects",async()=>{
    const s=await setup();
    await s.fake.publishAtomic(s.prepared,s.ly);
    expect((await scheduled(s.context)).status).toBe("already");
    expect(s.api.calls).toHaveLength(0);
    s.source.steps[0]={...s.source.steps[0],steps:800};
    const result=await scheduled(s.context);
    expect(result).toMatchObject({status:"rejected",reason:"GENERATION_COLLISION"});
    expect(s.api.calls).toHaveLength(0);
  });

  it("S04: pre-existing tampered workbook blocks overwrite",async()=>{
    const s=await setup();
    await s.fake.publishAtomic(s.prepared,s.ly);
    s.fake.tamperActive("Read_Steps",1,3,1);
    expect(await scheduled(s.context)).toMatchObject({
      status:"rejected",reason:"UNVERIFIED_PREVIOUS_COPY"
    });
    expect(s.api.calls).toHaveLength(0);
  });

  it("S05: untrusted sheet ID, owner or unknown workbook rejects before outbound request",async()=>{
    const s=await setup();
    s.context.spreadsheetId="https://attacker.example/escape";
    expect((await scheduled(s.context)).reason).toBe("INVALID_SCHEDULED_CONTEXT");
    s.context.spreadsheetId="synthetic_sheet_1234567890";
    s.context.trustedOwner="owner id with whitespace";
    expect((await scheduled(s.context)).reason).toBe("INVALID_SCHEDULED_CONTEXT");
    s.context.trustedOwner=OWNER;
    s.context.sheet.probe=async()=>"unknown";
    expect((await scheduled(s.context)).reason).toBe("UNKNOWN_WORKBOOK_STATE");
    expect(s.api.calls).toHaveLength(0);
    expect(s.source.writes).toBe(0);
  });

  it("S06: 429 bounded backoff then success, max-attempt exhaustion stops",async()=>{
    const s=await setup(30,"synthetic_b3_429",[429,429,200]);
    expect((await scheduled(s.context)).status).toBe("sheet_copy_verified");
    expect(s.api.calls).toHaveLength(3);
    expect(s.delays).toHaveLength(2);
    expect(s.delays[0]).toBeGreaterThanOrEqual(200);
    expect(s.delays[1]).toBeGreaterThan(s.delays[0]);
    const limited=await setup(30,"synthetic_b3_429_limit",[429,429,200]);
    limited.context.limits={maxAttempts:2};
    expect(await scheduled(limited.context)).toMatchObject({
      status:"rejected",reason:"RATE_LIMIT_EXHAUSTED"
    });
    expect(limited.api.calls).toHaveLength(2);
  });

  it("S07: HTTP 401/403 fail closed; no automatic retry",async()=>{
    for(const code of [401,403] as const){
      const s=await setup(30,"synthetic_b3_denied_"+code,[code]);
      expect(await scheduled(s.context)).toMatchObject({
        status:"rejected",reason:"SHEETS_ACCESS_DENIED"
      });
      expect(s.fake.activeGeneration).toBeNull();
      expect(s.api.calls).toHaveLength(1);
    }
  });

  it("S08: 503/timeout with lost acknowledgement stay unknown, not false rollback",async()=>{
    for(const scenario of [503,"timeout","after-apply-timeout"] as const){
      const s=await setup(30,"synthetic_b3_uncertain", [scenario]);
      const report=await scheduled(s.context);
      expect(report).toMatchObject({status:"unknown",reason:"SHEETS_RESPONSE_UNKNOWN"});
      expect(s.api.calls).toHaveLength(1);
      if(scenario==="after-apply-timeout")
        expect(s.fake.activeGeneration).toBe(s.original.generation_id);
      else expect(s.fake.activeGeneration).toBeNull();
      expect(s.source.writes).toBe(0);
    }
  });

  it("S09: 200 without readback-consistent rows is unknown, never published",async()=>{
    const s=await setup(30,"synthetic_b3_noapply",["no-apply"]);
    expect(await scheduled(s.context)).toMatchObject({
      status:"unknown",reason:"UNVERIFIED_POST_WRITE"
    });
    expect(s.fake.activeGeneration).toBeNull();
  });

  it("S10: 429 possibly after application verifies before retry; no duplicate submission",async()=>{
    const s=await setup(30,"synthetic_b3_after429",["429-after-apply",200]);
    expect((await scheduled(s.context)).status).toBe("sheet_copy_verified");
    expect(s.api.calls).toHaveLength(1);
  });

  it("S11: fail closed for CPU / subrequest / payload hard caps, without Sheets write",async()=>{
    const s=await setup();
    s.context.cpuMeter={usedMs:()=>11};
    expect((await scheduled(s.context)).reason).toBe("CPU_BUDGET");
    expect(s.api.calls).toHaveLength(0);
    s.context.cpuMeter=cpu;
    s.context.limits={maxSubrequests:10};
    expect((await scheduled(s.context)).reason).toBe("INVALID_SCHEDULED_CONTEXT");
    s.context.limits={maxBytes:1024};
    expect((await scheduled(s.context)).reason).toBe("RECOMMENDED_PAYLOAD_LIMIT");
    expect(s.api.calls).toHaveLength(0);
  });

  it("S12: exhausted readback budget stops before any possible submit",async()=>{
    const s=await setup();
    await s.fake.publishAtomic(await prepareSheetSnapshot(
      await projectAiReadSnapshot(s.source.db,OWNER,opts(30,"synthetic_old0001"))
    ),s.ly);
    s.context.limits={maxSubrequests:15};
    expect((await scheduled(s.context)).reason).toBe("SUBREQUEST_BUDGET");
    expect(s.api.calls).toHaveLength(0);
  });

  it("S13: token revocation stops before Google write, no secret in report",async()=>{
    const s=await setup();
    s.context.tokenTransport=token(403);
    const report=await scheduled(s.context);
    expect(report).toMatchObject({status:"rejected",reason:"TOKEN_DENIED"});
    expect(JSON.stringify(report)).not.toContain("synthetic_access_token_only");
    expect(s.api.calls).toHaveLength(0);
  });

  it("S14: CPU budget exhausted after possible write is UNKNOWN, not rejected",async()=>{
    const s=await setup();
    let value=0;
    s.context.cpuMeter={usedMs:()=>value};
    const originalSubmit=s.context.sheet.submit;
    s.context.sheet.submit=async request=>{
      const response=await originalSubmit(request);
      value=11;
      return response;
    };
    expect(await scheduled(s.context)).toMatchObject({
      status:"unknown",reason:"CPU_AFTER_SUBMIT_UNKNOWN"
    });
    expect(s.fake.activeGeneration).toBe(s.original.generation_id);
    expect(s.source.writes).toBe(0);
  });

  it("S15: approved v1 never falls back to multi-call staged publishing",async()=>{
    const s=await setup();
    s.context.limits={maxBytes:1024};
    const report=await scheduled(s.context);
    expect(report.status).toBe("rejected");
    expect(s.fake.stagedCount).toBe(0);
    expect(s.api.calls).toHaveLength(0);
    expect(s.fake.activeGeneration).toBeNull();
  });

  it("S16: 429 after-apply readback budget is reserved before any submission",async()=>{
    const blocked=await setup(30,"synthetic_b3_budget429",["429-after-apply"]);
    blocked.context.limits={maxSubrequests:15};
    expect(await scheduled(blocked.context)).toMatchObject({
      status:"rejected",reason:"SUBREQUEST_BUDGET"
    });
    expect(blocked.api.calls).toHaveLength(0);
    expect(blocked.fake.activeGeneration).toBeNull();
    const allowed=await setup(30,"synthetic_b3_budget429",["429-after-apply"]);
    allowed.context.limits={maxSubrequests:16};
    expect(await scheduled(allowed.context)).toMatchObject({
      status:"sheet_copy_verified",subrequests:16
    });
    expect(allowed.api.calls).toHaveLength(1);
  });


  it("S17: 429 may not overwrite a new generation published by another actor",async()=>{
    for(const withBaseline of [false,true]){
      const s=await setup(30,"synthetic_b3_new_429",[429,200]);
      if(withBaseline){
        const previous=await prepareSheetSnapshot(await projectAiReadSnapshot(
          s.source.db,OWNER,opts(30,"synthetic_b3_old_429")));
        await s.fake.publishAtomic(previous,s.ly);
      }
      const concurrentlyPublished=await prepareSheetSnapshot(await projectAiReadSnapshot(
        s.source.db,OWNER,opts(30,"synthetic_b3_other429")));
      const submit=s.context.sheet.submit;
      s.context.sheet.submit=async request=>{
        const response=await submit(request);
        await s.fake.publishAtomic(concurrentlyPublished,s.ly);
        return response;
      };
      expect(await scheduled(s.context)).toMatchObject({
        status:"unknown",reason:"CONCURRENT_GENERATION_CHANGE"
      });
      expect(s.api.calls).toHaveLength(1);
      expect(s.fake.activeGeneration).toBe(concurrentlyPublished.generation_id);
      expect(s.source.writes).toBe(0);
    }
  });


  it("S18: a generation changed DURING 429 backoff is not overwritten by retry",async()=>{
    for(const withBaseline of [false,true]){
      const s=await setup(30,"synthetic_b3_pause429",[429,200]);
      if(withBaseline){
        const previous=await prepareSheetSnapshot(await projectAiReadSnapshot(
          s.source.db,OWNER,opts(30,"synthetic_old_pause429")));
        await s.fake.publishAtomic(previous,s.ly);
      }
      const concurrent=await prepareSheetSnapshot(await projectAiReadSnapshot(
        s.source.db,OWNER,opts(30,"synthetic_other_pause429")));
      s.context.pause=async ms=>{
        s.delays.push(ms);
        await s.fake.publishAtomic(concurrent,s.ly);
      };
      const report=await scheduled(s.context);
      expect(report).toMatchObject({
        status:"unknown",reason:"CONCURRENT_GENERATION_CHANGE"
      });
      expect(s.delays).toHaveLength(1);
      expect(s.api.calls).toHaveLength(1); // NO second POST after the backoff
      expect(s.fake.activeGeneration).toBe(concurrent.generation_id);
      expect(s.source.writes).toBe(0);
    }
  });
});
