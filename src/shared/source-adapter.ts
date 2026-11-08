import type { CsvSource } from "./csv-import";

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

const PART_ROWS=40;
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
    :["local_day","drinking_presence","drink_cups","steps"];
  return header.join("\x1f")===expected.join("\x1f");
};

/** Header detection chooses a parser; full validation still gates registration. */
export function detectOfficialCsvSource(raw:string):CsvSource|null{
  const text=raw.startsWith("\uFEFF")?raw.slice(1):raw;
  const header=(text.split(/\r?\n/,1)[0]??"").replace(/\r$/,"").split(",").map(x=>x.trim());
  if((header.length===10&&header[0]==="年月日"&&header[1]==="時刻"&&
    header[2]==="体重"&&header[3]==="体脂肪率")||
    isAlreadyNormalized("eclear",header))return "eclear";
  if((header.length===28&&header[0]==="日付"&&header[16]==="歩数")||
    isAlreadyNormalized("fit",header))return "fit";
  if(isAlreadyNormalized("lifestyle",header))return "lifestyle";
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
  if(!officialEclear&&!officialFit&&!normalized)throw Error("CSV_HEADER_MISMATCH");
  if(source==="lifestyle"&&!normalized)throw Error("LIFESTYLE_NOT_NORMALIZED");

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
    source==="fit"?"local_day,steps":"local_day,drinking_presence,drink_cups,steps";
  for(let i=0;i<output.length;i+=PART_ROWS)
    chunks.push(h+"\n"+output.slice(i,i+PART_ROWS)
      .map(r=>r.map(quote).join(",")).join("\n")+"\n");
  return {parts:chunks,total:output.length,missingSteps};
}
