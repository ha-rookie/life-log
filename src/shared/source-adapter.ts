import { MAX_BYTES, type CsvSource } from "./csv-import";

/** Browser-only normalization. Original files never enter GitHub or CI. */
export type NormalizedSource = { parts:string[]; total:number; missingSteps:number; };
const MAX_ORIGINAL_BYTES=2_000_000;
/**
 * Browser File.text() always assumes UTF-8. ECLEAR exports Japanese CSV in
 * Shift_JIS/CP932, so decode the original bytes instead of lossy replacement.
 * Strict decoding rejects corrupted bytes; values are never logged.
 */
export function decodeOfficialCsv(bytes: Uint8Array):{text:string;encoding:"UTF-8"|"Shift_JIS"}{
  if(bytes.byteLength===0||bytes.byteLength>2_000_000)throw Error("CSV_SIZE");
  try{
    return {text:new TextDecoder("utf-8",{fatal:true}).decode(bytes),encoding:"UTF-8"};
  }catch{
    try{
      return {text:new TextDecoder("shift_jis",{fatal:true}).decode(bytes),encoding:"Shift_JIS"};
    }catch{
      throw Error("CSV_ENCODING_UNSUPPORTED");
    }
  }
}

/**
 * Attach the exact original bytes ONLY for a bounded, single-chunk UTF-8 CSV.
 * The browser keeps the bytes transient; the Worker must revalidate them.
 */
export async function originalUtf8Proof(bytes:Uint8Array):Promise<{
  originalBase64:string;originalSha256:string
}>{
  if(bytes.byteLength<1||bytes.byteLength>MAX_BYTES)throw Error("RAW_CSV_SIZE");
  // Fatal UTF-8 validation rejects Shift_JIS and malformed sequences.
  new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  const parts:string[]=[];
  for(let i=0;i<bytes.length;i+=8192)
    parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
  const sha=await crypto.subtle.digest("SHA-256",Uint8Array.from(bytes));
  return {
    originalBase64:btoa(parts.join("")),
    originalSha256:[...new Uint8Array(sha)].map(n=>n.toString(16).padStart(2,"0")).join("")
  };
}

const PART_ROWS=40;
// Lifestyle D1 conflict guards bind multiple parameters per day.
// Keep each job small, preserving the backend's existing strict 100-row limit
// and the statement parameter budget even with overlapping manual entries.
const LIFESTYLE_PART_ROWS=8;
function cells(text:string):string[][] {
  if(new TextEncoder().encode(text).length>MAX_ORIGINAL_BYTES||text.includes("\0"))
    throw Error("FILE_SIZE_OR_ENCODING");
  const rows:string[][]=[];
  let row:string[]=[],value="",quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){
      if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}
      else value+=c;
    }else if(c==='"'){
      if(value!==""||closed)throw Error("BAD_CSV_QUOTE");
      quoted=true;
    }else if(c===","){row.push(value);value="";closed=false;}
    else if(c==="\r"||c==="\n"){
      if(c==="\r"&&text[i+1]==="\n")i++;
      row.push(value);rows.push(row);row=[];value="";closed=false;
      if(rows.length>3200)throw Error("TOO_MANY_ROWS");
    }else{if(closed)throw Error("BAD_CSV_QUOTE");value+=c;}
  }
  if(quoted)throw Error("UNCLOSED_CSV_QUOTE");
  if(row.length||value)rows.push([...row,value]);
  return rows.filter(r=>r.some(v=>v!==""));
}
function isoDay(raw:string):string {
  const s=raw.trim().replaceAll("/","-");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s))throw Error("BAD_DAY");
  const d=new Date(s+"T00:00:00Z");
  if(Number.isNaN(d.valueOf())||d.toISOString().slice(0,10)!==s)throw Error("BAD_DAY");
  return s;
}
const quote=(value:string)=>'"'+value.replace(/"/g,'""')+'"';
const numeric=(x:string,kind:"weight"|"fat"|"steps"):string=>{
  const v=x.trim().replaceAll(",","");
  if(kind==="steps"&&v==="")return "";
  if(kind==="fat"&&v==="")return "";
  if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v))throw Error("BAD_"+kind.toUpperCase());
  const n=Number(v);
  if(!Number.isFinite(n)||(
    kind==="steps" ? (!Number.isSafeInteger(n)||n>1_000_000) :
    kind==="fat" ? n>100 : n<=0||n>=500
  ))throw Error("BAD_"+kind.toUpperCase());
  return v;
};
const isAlreadyNormalized=(source:CsvSource,header:string[])=>{
  const expected=source==="eclear"
    ?["measured_at","weight_kg","body_fat_pct"]
    :source==="fit"?["local_day","steps"]
    :source==="weight_day"?["local_day","weight_kg"]
    :["local_day","drinking_presence","drink_cups","steps"];
  return header.join("\x1f")===expected.join("\x1f");
};

// Only a strict, single-target Japanese lifestyle header is supported.
// Do not accept a partial/unknown header or silently drop weight/time columns.
const japaneseLifestyleFields=new Set(["日付","飲酒","歩数","体重_kg","測定時刻"]);
const isJapaneseLifestyleHeader=(header:string[]):boolean=>
  header.length>=2&&new Set(header).size===header.length&&
  header.includes("日付")&&header.includes("飲酒")&&
  header.every(name=>japaneseLifestyleFields.has(name));

/** Header detection chooses a parser; full validation still gates registration. */
export function detectOfficialCsvSource(raw:string):CsvSource|null{
  const text=raw.startsWith("\uFEFF")?raw.slice(1):raw;
  const header=(text.split(/\r?\n/,1)[0]??"").replace(/\r$/,"").split(",").map(x=>x.trim());
  if((header.length===10&&header[0]==="年月日"&&header[1]==="時刻"&&
    header[2]==="体重"&&header[3]==="体脂肪率")||
    isAlreadyNormalized("eclear",header))return "eclear";
  if((header.length===28&&header[0]==="日付"&&header[16]==="歩数")||
    isAlreadyNormalized("fit",header))return "fit";
  if(isAlreadyNormalized("weight_day",header))return "weight_day";
  if(isAlreadyNormalized("lifestyle",header)||isJapaneseLifestyleHeader(header))return "lifestyle";
  return null;
}

export function normalizeOfficialCsv(source:CsvSource,raw:string):NormalizedSource{
  const text=raw.startsWith("\uFEFF")?raw.slice(1):raw;
  const data=cells(text);
  if(data.length<2)throw Error("CSV_EMPTY");
  const header=data.shift()!;
  const officialEclear=source==="eclear"&&header[0]==="年月日"&&header[1]==="時刻"&&
    header[2]==="体重"&&header[3]==="体脂肪率"&&header.length===10;
  const officialFit=source==="fit"&&header[0]==="日付"&&header[16]==="歩数"&&
    header.length===28;
  const normalized=isAlreadyNormalized(source,header);
  const japaneseLifestyle=source==="lifestyle"&&isJapaneseLifestyleHeader(header);
  if(!officialEclear&&!officialFit&&!normalized&&!japaneseLifestyle)throw Error("CSV_HEADER_MISMATCH");

  const output:string[][]=[],seen=new Set<string>();
  let missingSteps=0;
  for(const [index,row] of data.entries()){
    if(row.length!==header.length)throw Error("CSV_COLUMNS_AT_LINE_"+(index+2));
    let values:string[];
    if(officialEclear){
      const day=isoDay(row[0]),t=row[1].trim();
      if(!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(t))throw Error("BAD_ECLEAR_TIME_AT_LINE_"+(index+2));
      const [hh,mm,ss="00"]=t.split(":");
      if(Number(hh)>23||Number(mm)>59||Number(ss)>59)throw Error("BAD_ECLEAR_TIME");
      values=[day+"T"+hh.padStart(2,"0")+":"+mm+":"+ss+"+09:00",
        numeric(row[2],"weight"),numeric(row[3],"fat")];
    }else if(officialFit){
      values=[isoDay(row[0]),numeric(row[16],"steps")];
    }else if(japaneseLifestyle){
      const column=(name:string):string=>{
        const at=header.indexOf(name);
        return at<0?"":row[at].trim();
      };
      // No single source row may fan out into an unaudited second destination.
      if(column("体重_kg")!==""||column("測定時刻")!=="")
        throw Error("LIFESTYLE_MULTI_TARGET_NOT_SUPPORTED_AT_LINE_"+(index+2));
      const drink=column("飲酒");
      if(drink!==""&&drink!=="0"&&drink!=="1")
        throw Error("BAD_DRINKING_PRESENCE_AT_LINE_"+(index+2));
      const step=column("歩数");
      values=[isoDay(column("日付")),drink,drink==="0"?"0":"",step===""?"":numeric(step,"steps")];
    }else {
      values=row.map(v=>v.trim());
    }
    const key=source==="eclear"?values[0]:values[0];
    if(seen.has(key))throw Error("DUPLICATE_DATE_OR_TIMESTAMP_IN_SOURCE");
    seen.add(key);
    if(source==="fit"&&values[1]==="")missingSteps++;
    output.push(values);
  }
  const chunks:string[]=[];
  const h=source==="eclear"?"measured_at,weight_kg,body_fat_pct":
    source==="fit"?"local_day,steps":source==="weight_day"?"local_day,weight_kg":
    "local_day,drinking_presence,drink_cups,steps";
  const partSize=source==="lifestyle"?LIFESTYLE_PART_ROWS:PART_ROWS;
  for(let i=0;i<output.length;i+=partSize)
    chunks.push(h+"\n"+output.slice(i,i+partSize)
      .map(r=>r.map(quote).join(",")).join("\n")+"\n");
  return {parts:chunks,total:output.length,missingSteps};
}

/**
 * Stage 1 of #124: inspect the original 10-column ECLEAR CSV without changing
 * the existing 3-column import contract or writing any personal data to D1.
 * Caller must first use decodeOfficialCsv(rawBytes) for CP932 support.
 *
 * The source's memo column is deliberately not returned: the DB has no
 * approved destination and this function must never claim it was saved.
 */
export type EclearCompositionMeasurement = Readonly<{
  measuredAt:string;
  weightKg:number;
  bodyFatPct:number|null;
  skeletalMusclePct:number|null;
  bmi:number|null;
  visceralFatLevel:number|null;
  boneMassKg:number|null;
  basalMetabolismKcal:number|null;
}>;

const ECLEAR_COMPOSITION_HEADER=[
  "年月日","時刻","体重","体脂肪率","骨格筋率","BMI",
  "内蔵脂肪レベル","骨量","基礎代謝量","メモ"
] as const;

const optionalEclearNumber=(raw:string,field:string,max?:number):number|null=>{
  const text=raw.trim();
  if(text==="")return null;
  if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text))throw Error("BAD_ECLEAR_"+field);
  const number=Number(text);
  if(!Number.isFinite(number) || (max!==undefined && number>max))
    throw Error("BAD_ECLEAR_"+field);
  return number;
};

export function inspectOfficialEclearComposition(raw:string):EclearCompositionMeasurement[]{
  const text=raw.startsWith("\uFEFF")?raw.slice(1):raw;
  const rows=cells(text);
  if(rows.length<2)throw Error("CSV_EMPTY");
  const headers=rows.shift()!;
  const expected=ECLEAR_COMPOSITION_HEADER;
  const valid=headers.length===expected.length&&headers.every((h,i)=>
    i===6?(h==="内蔵脂肪レベル"||h==="内臓脂肪レベル"):h===expected[i]);
  if(!valid)throw Error("CSV_HEADER_MISMATCH");
  const seen=new Set<string>();
  const measurements:EclearCompositionMeasurement[]=[];
  for(const [index,row] of rows.entries()){
    if(row.length!==expected.length)throw Error("CSV_COLUMNS_AT_LINE_"+(index+2));
    const day=isoDay(row[0]),time=row[1].trim();
    if(!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(time))
      throw Error("BAD_ECLEAR_TIME_AT_LINE_"+(index+2));
    const [hh,mm,ss="00"]=time.split(":");
    if(Number(hh)>23||Number(mm)>59||Number(ss)>59)throw Error("BAD_ECLEAR_TIME");
    const measuredAt=day+"T"+hh.padStart(2,"0")+":"+mm+":"+ss+"+09:00";
    if(seen.has(measuredAt))throw Error("DUPLICATE_DATE_OR_TIMESTAMP_IN_SOURCE");
    seen.add(measuredAt);
    const weightText=numeric(row[2],"weight"),fatText=numeric(row[3],"fat");
    measurements.push({
      measuredAt,weightKg:Number(weightText),
      bodyFatPct:fatText===""?null:Number(fatText),
      skeletalMusclePct:optionalEclearNumber(row[4],"SKELETAL_MUSCLE",100),
      bmi:optionalEclearNumber(row[5],"BMI"),
      visceralFatLevel:optionalEclearNumber(row[6],"VISCERAL_FAT"),
      boneMassKg:optionalEclearNumber(row[7],"BONE_MASS"),
      basalMetabolismKcal:optionalEclearNumber(row[8],"BASAL_METABOLISM")
    });
  }
  return measurements;
}


/**
 * Stage 2C: prepare the original ECLEAR ten-column source for the independent
 * v2 enrichment API. Only seven numeric fields plus the real measurement time
 * are serialized; the original memo NEVER leaves the browser.
 *
 * The v2 Worker validates the canonical ten-column format again. Partitioning
 * parsed observations (not raw text lines) also supports quoted multiline memos.
 */
export function partitionOfficialEclearComposition(raw:string):{
  parts:string[];total:number;missingCells:number
}{
  const records=inspectOfficialEclearComposition(raw);
  if(records.length<1)throw Error("CSV_EMPTY");
  const header=ECLEAR_COMPOSITION_HEADER.join(",");
  const parts:string[]=[];
  let missingCells=0;
  for(let i=0;i<records.length;i+=PART_ROWS){
    const lines=records.slice(i,i+PART_ROWS).map(r=>{
      const time=r.measuredAt;
      const values=[
        time.slice(0,10).replaceAll("-","/"),time.slice(11,19),
        r.weightKg,r.bodyFatPct,r.skeletalMusclePct,r.bmi,
        r.visceralFatLevel,r.boneMassKg,r.basalMetabolismKcal
      ];
      missingCells+=values.slice(2).filter(v=>v===null).length;
      return [...values.map(v=>v===null?"":String(v)),""].join(",");
    });
    parts.push(header+"\n"+lines.join("\n")+"\n");
  }
  return {parts,total:records.length,missingCells};
}
