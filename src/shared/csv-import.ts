import { normalizeLegacyDrinking } from "./legacy";
export type CsvSource = "eclear" | "lifestyle";
export type CsvRow = { line:number; key:string; timestamp?:string; weight?:number; fat?:number|null; muscle?:number|null; day?:string; presence?:0|1|null; cups?:number|null; steps?:number|null; fingerprint?:string };
export type Preview = { source:CsvSource; hash:string; rows:CsvRow[]; errors:{line:number;code:string}[]; total:number };
export const MAX_BYTES=65536,MAX_ROWS=100;
const HEADERS={eclear:["measured_at","weight_kg","body_fat_pct"],lifestyle:["local_day","drinking_presence","drink_cups","steps"]};
function cells(text:string):string[][] {
  const rows:string[][]=[];let row:string[]=[],value="",quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else value+=c;}
    else if(c==='"'){if(value!==""||closed)throw Error("BAD_QUOTE");quoted=true;}
    else if(c===","){row.push(value);value="";closed=false;}
    else if(c==="\n"||c==="\r"){if(c==="\r"&&text[i+1]==="\n")i++;row.push(value);rows.push(row);row=[];value="";closed=false;if(rows.length>MAX_ROWS+1)throw Error("TOO_MANY_ROWS");}
    else{if(closed)throw Error("BAD_QUOTE");value+=c;}
  }
  if(quoted)throw Error("UNCLOSED_QUOTE");
  if(row.length||value)rows.push([...row,value]);
  return rows;
}
const num=(s:string,max:number,integer=false):number|null=>{
  if(s.trim()==="")return null;
  if(!/^(0|[1-9]\d*)(\.\d+)?$/.test(s)||(integer&&s.includes(".")))throw Error("BAD_NUMBER");
  const n=Number(s);if(!Number.isFinite(n)||n>max)throw Error("BAD_NUMBER");return n;
};
const validDay=(s:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(s+"T00:00:00Z");return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s;};
const validTime=(s:string)=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(s)&&validDay(s.slice(0,10))&&Number(s.slice(11,13))<24&&Number(s.slice(14,16))<60&&Number(s.slice(17,19))<60&&!Number.isNaN(Date.parse(s));
export async function hash(text:string):Promise<string>{const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));return [...new Uint8Array(b)].map(v=>v.toString(16).padStart(2,"0")).join("");}
export async function previewCsv(source:CsvSource,text:string):Promise<Preview>{
  if(!(source in HEADERS))throw Error("SOURCE");
  if(new TextEncoder().encode(text).length>MAX_BYTES)throw Error("SIZE");
  if(!text||text.includes("\0")||text.charCodeAt(0)===0xfeff)throw Error("ENCODING");
  const all=cells(text),header=all.shift();
  if(!header||header.length!==HEADERS[source].length||header.some((h,i)=>h!==HEADERS[source][i]))throw Error("HEADER");
  if(all.length===0)throw Error("EMPTY");
  const digest=await hash(text),rows:CsvRow[]=[],errors:Preview["errors"]=[];
  for(let i=0;i<all.length;i++){
    const c=all[i],line=i+2;
    if(c.length!==header.length||c.every(v=>v.trim()==="")){errors.push({line,code:"COLUMNS"});continue;}
    try{
      if(source==="eclear"){
        const timestamp=c[0].trim(),weight=num(c[1].trim(),499.99),fat=num(c[2].trim(),100);
        if(!validTime(timestamp)||weight===null||weight<=0)throw Error("MEASUREMENT");
        const fingerprint=await hash(JSON.stringify(["eclear-v1",timestamp,weight,fat]));
        rows.push({line,key:digest+":"+line,timestamp,weight,fat,fingerprint});
      }else{
        const day=c[0].trim(),raw=c[1].trim(),cups=num(c[2].trim(),1000,true),steps=num(c[3].trim(),1000000,true);
        if(!validDay(day)||!["","0","1"].includes(raw))throw Error("DAY");
        const presence=raw===""?null:Number(raw) as 0|1;
        if((presence===null&&cups!==null)||(presence===0&&cups!==0)||(presence===1&&cups!==null&&cups<=0))throw Error("DRINK");
        rows.push({line,key:digest+":"+line,day,presence,cups,steps});
      }
    }catch{errors.push({line,code:"VALUE"});}
  }
  return {source,hash:digest,rows,errors,total:all.length};
}


// Stage 1 of #20: byte-preserving transport. The bytes (including optional BOM)
// determine the file identity; UTF-8 decoding never silently substitutes U+FFFD.
export function encodeCsvBytes(bytes: Uint8Array): string {
  if (bytes.length > MAX_BYTES) throw Error("SIZE");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}
export function decodeCsvBase64(value: string): Uint8Array {
  if (value.length > Math.ceil(MAX_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw Error("ENCODING");
  }
  let binary: string;
  try { binary = atob(value); } catch { throw Error("ENCODING"); }
  if (btoa(binary) !== value) throw Error("ENCODING"); // reject noncanonical pad bits
  if (binary.length > MAX_BYTES) throw Error("SIZE");
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
export async function hashCsvBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("");
}
function decodeStrictCsvBytes(bytes: Uint8Array): string {
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw Error(bytes.length ? "SIZE" : "ENCODING");
  if ((bytes[0] === 0xff && bytes[1] === 0xfe)
    || (bytes[0] === 0xfe && bytes[1] === 0xff)) throw Error("ENCODING");
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch { throw Error("ENCODING"); }
  if (!text || text.includes("\0") || text.includes("\uFEFF")) throw Error("ENCODING");
  return text;
}
function japaneseDay(raw: string): string {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw.trim());
  if (!m) throw Error("DAY");
  const y = Number(m[1]);
  const canonical = m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  if (y < 1900 || y > 2100 || !validDay(canonical)) throw Error("DAY");
  return canonical;
}
function japaneseClock(raw: string): string {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m || Number(m[1]) >= 24 || Number(m[2]) >= 60 || Number(m[3] ?? "00") >= 60)
    throw Error("TIME");
  return m[1].padStart(2, "0") + ":" + m[2] + ":" + (m[3] ?? "00");
}
// The tokenizer validates quotes. This separate scan maps logical CSV records
// to actual physical line numbers even when quoted fields include newlines.
function physicalRowLines(text: string): number[] {
  const lines = [1]; let physical = 1, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      physical++;
      if (!quoted) lines.push(physical);
    }
  }
  return lines;
}
// Explicit source selection is authoritative. No heuristic can guess a vendor
// format or silently map unrecognized personal/health data columns.
export async function previewCsvFileBytes(source: CsvSource, bytes: Uint8Array): Promise<Preview> {
  if (source !== "lifestyle" && source !== "eclear") throw Error("SOURCE");
  const text = decodeStrictCsvBytes(bytes);
  const digest = await hashCsvBytes(bytes);
  const all = cells(text);
  const header = all.shift()?.map(x => x.trim());
  if (!header || new Set(header).size !== header.length || header.some(x => x === ""))
    throw Error("HEADER");
  if (header.length === HEADERS[source].length
    && header.every((h, i) => h === HEADERS[source][i])) {
    const canonical = await previewCsv(source, text);
    return { ...canonical, hash: digest,
      rows: canonical.rows.map(row => ({ ...row, key: digest + ":" + row.line })) };
  }
  const allowed = source === "lifestyle"
    ? ["日付", "飲酒", "歩数", "体重_kg", "測定時刻"]
    : ["年月日", "時刻", "体重", "体脂肪率", "骨格筋率"];
  const required = source === "lifestyle" ? ["日付", "飲酒"] : ["年月日", "時刻", "体重"];
  if (header.some(name => !allowed.includes(name))
    || required.some(name => !header.includes(name))) throw Error("HEADER");
  if (all.length === 0) throw Error("EMPTY");
  const starts = physicalRowLines(text);
  const rows: CsvRow[] = [], errors: Preview["errors"] = [];
  for (let i = 0; i < all.length; i++) {
    const record = all[i], line = starts[i + 1] ?? i + 2;
    if (record.length !== header.length || record.every(x => x.trim() === "")) {
      errors.push({ line, code: "COLUMNS" }); continue;
    }
    const value = (name: string) => {
      const column = header.indexOf(name);
      return column < 0 ? "" : record[column].trim();
    };
    try {
      if (source === "lifestyle") {
        const day = japaneseDay(value("日付"));
        const drinking = normalizeLegacyDrinking(value("飲酒"));
        const steps = num(value("歩数"), 1000000, true);
        // Do not silently drop a second destination measurement in Stage 1.
        if (value("体重_kg") && !value("測定時刻")) throw Error("MEASUREMENT_TIME_REQUIRED");
        if (value("体重_kg") || value("測定時刻")) throw Error("MULTI_TARGET_NOT_ENABLED");
        rows.push({ line, key: digest + ":" + line, day,
          presence: drinking.presence, cups: drinking.cups, steps });
      } else {
        const timestamp = japaneseDay(value("年月日")) + "T"
          + japaneseClock(value("時刻")) + "+09:00";
        const weight = num(value("体重"), 499.99);
        const fat = num(value("体脂肪率"), 100);
        const muscle = num(value("骨格筋率"), 100);
        if (!validTime(timestamp) || weight === null || weight <= 0) throw Error("MEASUREMENT");
        const fingerprint = await hash(JSON.stringify(muscle === null
          ? ["eclear-v1", timestamp, weight, fat]
          : ["eclear-v2", timestamp, weight, fat, muscle]));
        rows.push({ line, key: digest + ":" + line, timestamp,
          weight, fat, muscle, fingerprint });
      }
    } catch (e) {
      const code = e instanceof Error && ["MEASUREMENT_TIME_REQUIRED", "MULTI_TARGET_NOT_ENABLED"]
        .includes(e.message) ? e.message : "VALUE";
      errors.push({ line, code });
    }
  }
  return { source, hash: digest, rows, errors, total: all.length };
}
