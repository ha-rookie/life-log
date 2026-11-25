/**
 * Phase B3: unregistered scheduled-only READ snapshot pipeline.
 * Explicitly injected D1, OAuth and Sheet transport: there is no fetch handler,
 * Worker entrypoint, Cron registration, real Google call or D1 write here.
 * HTTP status and a same-Sheet digest never establish trusted D1 provenance.
 */
import {projectAiReadSnapshot,type AiReadDb,type AiReadOptions} from "./ai-read-model";
import {
  buildAtomicBatch,prepareSheetSnapshot,verifyReadSnapshot,
  type AtomicBatch,type Layout,type SheetReader
} from "./ai-sheet-snapshot";
import {
  requestSyntheticGoogleToken,type ServiceIdentity,type TokenTransport
} from "./ai-google-auth";

export const SHEETS_BATCH_ENDPOINT="https://sheets.googleapis.com/v4/spreadsheets/" as const;
export type SheetSubmit = {
  endpoint:string;authorization:string;body:AtomicBatch;timeoutMs:number;
};
export interface InjectedSheetGateway {
  /** Trusted adapter must positively distinguish a provisioned empty workbook. */
  probe():Promise<"empty"|"occupied"|"unknown">;
  reader:SheetReader;
  /** No default HTTP transport exists; tests inject this explicitly. */
  submit(request:SheetSubmit):Promise<{status:number}>;
}
export type SyncLimits={
  maxCpuMs?:number;maxSubrequests?:number;maxBytes?:number;
  maxAttempts?:number;requestTimeoutMs?:number;
};
export type ScheduledReadContext={
  db:AiReadDb;trustedOwner:string;options:AiReadOptions;
  /** This must come from a future trusted binding, NEVER a Sheet cell. */
  spreadsheetId:string;layout:Layout;identity:ServiceIdentity;
  tokenTransport:TokenTransport;sheet:InjectedSheetGateway;
  /** In B3 this is an *injected synthetic* CPU counter, not Workers Free proof. */
  cpuMeter:{usedMs():number};
  /** Synthetic caller supplies a no-network/non-timer backoff sink. */
  pause:(milliseconds:number)=>Promise<void>;
  trustedNowMs:number;limits?:SyncLimits;
};
export type SyncStatus="sheet_copy_verified"|"already"|"rejected"|"unknown";
export type SyncReport={
  status:SyncStatus;reason:string;
  generationId:string|null;digest:string|null;
  payloadBytes:number;subrequests:number;cpuSampleMs:number;
  authority:"sheet-copy-only";cpuEvidence:"injected-synthetic-only";
};
type Effective={
  cpu:number;requests:number;bytes:number;attempts:number;timeout:number;
};
function caps(partial:SyncLimits={}):Effective{
  const cpu=partial.maxCpuMs??10,requests=partial.maxSubrequests??50;
  const bytes=partial.maxBytes??2_000_000,attempts=partial.maxAttempts??3;
  const timeout=partial.requestTimeoutMs??10_000;
  if(!Number.isFinite(cpu)||cpu<=0||cpu>10||
    !Number.isSafeInteger(requests)||requests<15||requests>50||
    !Number.isSafeInteger(bytes)||bytes<1024||bytes>2_000_000||
    !Number.isSafeInteger(attempts)||attempts<1||attempts>3||
    !Number.isSafeInteger(timeout)||timeout<100||timeout>180_000)
    throw Error("INVALID_RESOURCE_CAPS");
  return {cpu,requests,bytes,attempts,timeout};
}
const maxCellChars=50_000; // Conservative B3 preflight; native API acceptance is unverified.
function checkCells(body:AtomicBatch):void{
  if(body.requests.length!==7)throw Error("INVALID_BATCH_REQUESTS");
  for(const request of body.requests){
    if(request.updateCells.fields!=="userEnteredValue")throw Error("UNSAFE_FIELDS");
    for(const row of request.updateCells.rows){
      for(const cell of row.values){
        const string=cell.userEnteredValue?.stringValue;
        if(string!==undefined&&string.length>maxCellChars)
          throw Error("CELL_LENGTH_BUDGET");
      }
    }
  }
}
const empty=(reason:string):SyncReport=>({
  status:"rejected",reason,generationId:null,digest:null,payloadBytes:0,
  subrequests:0,cpuSampleMs:0,authority:"sheet-copy-only",
  cpuEvidence:"injected-synthetic-only"
});
/**
 * Returns a synthetic-only confidence marker, never "D1 successfully synced".
 * All provider calls below are to mandatory caller-supplied fakes.
 */
export async function scheduled(context:ScheduledReadContext):Promise<SyncReport>{
  let n=0,bytes=0,used=0,generation:string|null=null,digest:string|null=null;
  // Anchor a verified starting state; after a 429 never overwrite a third-party generation.
  let baseline:{generation:string;digest:string}|null=null;
  let limits:Effective;
  try{
    limits=caps(context.limits);
    if(!context||!context.db||!context.sheet||!context.tokenTransport||
      typeof context.pause!=="function"||!context.cpuMeter||
      typeof context.cpuMeter.usedMs!=="function"||
      !Number.isSafeInteger(context.trustedNowMs)||
      context.trustedNowMs<Date.UTC(2020,0,1)||
      context.trustedNowMs>=Date.UTC(2100,0,1)||
      !/^[A-Za-z0-9_-]{20,128}$/u.test(context.spreadsheetId)||
      !context.trustedOwner||context.trustedOwner.length>256||
      /\s/u.test(context.trustedOwner)||
      !context.options||typeof context.options.generatedAtUtc!=="string")
      return empty("INVALID_SCHEDULED_CONTEXT");
  }catch{return empty("INVALID_SCHEDULED_CONTEXT");}
  const result=(status:SyncStatus,reason:string):SyncReport=>({
    status,reason,generationId:generation,digest:status==="sheet_copy_verified"||
      status==="already"?digest:null,payloadBytes:bytes,subrequests:n,
    cpuSampleMs:used,authority:"sheet-copy-only",cpuEvidence:"injected-synthetic-only"
  });
  const charge=(count:number)=>{
    if(n+count>limits.requests)throw Error("SUBREQUEST_BUDGET");
    n+=count;
  };
  const reserve=(count:number)=>{
    if(n+count>limits.requests)throw Error("SUBREQUEST_BUDGET");
  };
  const checkCpu=()=>{
    const measured=context.cpuMeter.usedMs();
    if(!Number.isFinite(measured)||measured<0||measured<used)
      throw Error("INVALID_CPU_METER");
    used=measured;
    if(used>limits.cpu)throw Error("CPU_BUDGET");
  };
  try{
    checkCpu();
    // Conservative accounting: 4 owner-scoped D1 queries in a single batch.
    charge(4);
    const source=await projectAiReadSnapshot(context.db,context.trustedOwner,context.options);
    generation=source.generation_id;digest=source.generation_digest;
    checkCpu();
    const prepared=await prepareSheetSnapshot(source);
    const request=buildAtomicBatch(prepared,context.layout,limits.bytes);
    bytes=request.bytes;
    checkCells(request.body);
    checkCpu();
    const nowUtc=new Date(context.trustedNowMs).toISOString();
    if(Date.parse(source.generated_at_utc)>context.trustedNowMs+60_000)
      return result("rejected","FUTURE_SOURCE_TIME");
    charge(1);
    const current=await context.sheet.probe();
    if(current==="unknown")return result("rejected","UNKNOWN_WORKBOOK_STATE");
    if(current==="occupied"){
      charge(8); // B2 verifies Meta twice + five Read_* + Sync_Status.
      const before=await verifyReadSnapshot(context.sheet.reader,nowUtc);
      if(before.consistency!=="consistent")return result("rejected","UNVERIFIED_PREVIOUS_COPY");
      if(before.generation_id===generation){
        return result(before.generation_digest===digest?"already":"rejected",
          before.generation_digest===digest?"SAME_GENERATION_DIGEST":"GENERATION_COLLISION");
      }
      baseline={generation:before.generation_id!,digest:before.generation_digest!};
    }else if(current!=="empty")return result("rejected","INVALID_WORKBOOK_STATE");
    checkCpu();
    charge(1); // OAuth endpoint (in B3 replaced by injected fake).
    let token:string;
    try{
      const ephemeral=await requestSyntheticGoogleToken(
        context.identity,context.tokenTransport,context.trustedNowMs);
      token=ephemeral.accessToken;
      if(ephemeral.expiresAtMs<=context.trustedNowMs+60_000)
        return result("rejected","SHORT_LIVED_TOKEN");
    }catch(e){
      const reason=e instanceof Error?e.message:"TOKEN_EXCHANGE_UNKNOWN";
      return result("rejected",[
        "INVALID_SERVICE_IDENTITY","INVALID_SIGNING_KEY","INVALID_AUTH_TIME",
        "SERVICE_SIGNING_FAILED","TOKEN_TRANSPORT_REQUIRED","TOKEN_DENIED",
        "TOKEN_RATE_LIMITED","TOKEN_EXCHANGE_UNKNOWN","INVALID_TOKEN_RESPONSE"
      ].includes(reason)?reason:"TOKEN_EXCHANGE_UNKNOWN");
    }
    checkCpu();
    const endpoint=SHEETS_BATCH_ENDPOINT+context.spreadsheetId+":batchUpdate";
    for(let attempt=1;attempt<=limits.attempts;attempt++){
      // Reserve the largest branch BEFORE any possible write:
      // one POST + one 429 state probe + eight verification reads.
      try{
        reserve(10);
        checkCpu();
      }catch(e){
        // A previous POST may have applied even when the response was 429.
        // Never describe an unverified retry-budget stop as a clean rejection.
        if(attempt>1)return result("unknown","RETRY_PREFLIGHT_UNKNOWN");
        throw e;
      }
      charge(1);
      let response:{status:number};
      try{
        response=await context.sheet.submit({
          endpoint,authorization:"Bearer "+token,body:request.body,timeoutMs:limits.timeout
        });
      }catch{
        // The HTTP acknowledgement may have been lost after application.
        return result("unknown","SHEETS_RESPONSE_UNKNOWN");
      }
      // A CPU overrun *after* a possible write cannot be reported as "rejected".
      try{checkCpu();}catch{return result("unknown","CPU_AFTER_SUBMIT_UNKNOWN");}
      if(response?.status===200){
        charge(8);
        const seen=await verifyReadSnapshot(context.sheet.reader,nowUtc);
        try{checkCpu();}catch{return result("unknown","CPU_AFTER_SUBMIT_UNKNOWN");}
        if(seen.consistency==="consistent"&&seen.generation_id===generation&&
          seen.generation_digest===digest)
          return result("sheet_copy_verified","SHEET_INTERNAL_CONSISTENCY_ONLY");
        return result("unknown","UNVERIFIED_POST_WRITE");
      }
      if(response?.status===401||response?.status===403)
        return result("rejected","SHEETS_ACCESS_DENIED");
      if(response?.status===429){
        // A 429 may race with publication. Re-read before any second attempt.
        charge(1);
        const state=await context.sheet.probe();
        if(state==="unknown")return result("unknown","RATE_LIMIT_UNKNOWN_STATE");
        if(state==="occupied"){
          charge(8);
          const seen=await verifyReadSnapshot(context.sheet.reader,nowUtc);
          if(seen.consistency!=="consistent")
            return result("unknown","RATE_LIMIT_UNVERIFIED_COPY");
          if(seen.generation_id===generation)
            return result(seen.generation_digest===digest?"sheet_copy_verified":"rejected",
              seen.generation_digest===digest?
                "SHEET_INTERNAL_CONSISTENCY_ONLY":"GENERATION_COLLISION");
          // A new or altered third-party snapshot between probe and retry is not ours.
          if(!baseline||seen.generation_id!==baseline.generation||
             seen.generation_digest!==baseline.digest)
            return result("unknown","CONCURRENT_GENERATION_CHANGE");
        }else if(state!=="empty")return result("unknown","RATE_LIMIT_UNKNOWN_STATE");
        else if(baseline)return result("unknown","CONCURRENT_GENERATION_CHANGE");
        try{checkCpu();}catch{return result("unknown","CPU_AFTER_SUBMIT_UNKNOWN");}
        if(attempt===limits.attempts)return result("rejected","RATE_LIMIT_EXHAUSTED");
        const jitter=(generation.charCodeAt(0)*attempt)%50;
        try{await context.pause(200*2**(attempt-1)+jitter);}
        catch{return result("unknown","BACKOFF_INTERRUPTED");}
        // S18: the first post-429 readback occurred BEFORE the asynchronous
        // backoff. Re-probe now, while still able to stop before another POST.
        // This is NOT an atomic provider-side compare-and-set or a lock.
        try{
          charge(1);
          const afterPause=await context.sheet.probe();
          if(afterPause==="unknown")return result("unknown","RATE_LIMIT_UNKNOWN_STATE");
          if(afterPause==="occupied"){
            charge(8);
            const seen=await verifyReadSnapshot(context.sheet.reader,nowUtc);
            if(seen.consistency!=="consistent")
              return result("unknown","RATE_LIMIT_UNVERIFIED_COPY");
            if(seen.generation_id===generation)
              return result(seen.generation_digest===digest?"sheet_copy_verified":"rejected",
                seen.generation_digest===digest?
                  "SHEET_INTERNAL_CONSISTENCY_ONLY":"GENERATION_COLLISION");
            if(!baseline||seen.generation_id!==baseline.generation||
               seen.generation_digest!==baseline.digest)
              return result("unknown","CONCURRENT_GENERATION_CHANGE");
          }else if(afterPause==="empty"){
            if(baseline)return result("unknown","CONCURRENT_GENERATION_CHANGE");
          }else return result("unknown","RATE_LIMIT_UNKNOWN_STATE");
          checkCpu();
        }catch{
          // After a possible publication, a failed re-check is never a rollback.
          return result("unknown","RETRY_PREFLIGHT_UNKNOWN");
        }
        continue;
      }
      // 5xx, timeout, malformed response or response loss: no unsafe retry.
      return result("unknown","SHEETS_RESPONSE_UNKNOWN");
    }
    return result("rejected","ATTEMPT_LIMIT_EXHAUSTED");
  }catch(e){
    const reason=e instanceof Error?e.message:"SYNTHETIC_PIPELINE_ERROR";
    const allowed=[
      "SUBREQUEST_BUDGET","INVALID_CPU_METER","CPU_BUDGET",
      "INVALID_RESOURCE_CAPS","CELL_LENGTH_BUDGET","INVALID_BATCH_REQUESTS",
      "UNSAFE_FIELDS","RECOMMENDED_PAYLOAD_LIMIT","INVALID_SHEET_LAYOUT",
      "SOURCE_DIGEST_MISMATCH","INVALID_SNAPSHOT_RANGE","INVALID_OWNER",
      "INCOMPLETE_D1_READ_BATCH","TOO_MANY_SOURCE_ROWS",
      "INVALID_SOURCE_COUNTS","INCOMPLETE_DAY_COVERAGE:Read_Steps",
      "INCOMPLETE_DAY_COVERAGE:Read_Meals",
      "INCOMPLETE_DAY_COVERAGE:Read_DrinkDays"
    ];
    return result("rejected",allowed.includes(reason)?reason:"SYNTHETIC_PIPELINE_ERROR");
  }
}
