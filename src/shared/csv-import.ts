export type CsvSource = "eclear" | "lifestyle" | "fit";
export type CsvRow = { line:number; key:string; timestamp?:string; weight?:number; fat?:number|null; day?:string; presence?:0|1|null; cups?:number|null; steps?:number|null; fingerprint?:string };
export type Preview = { source:CsvSource; hash:string; rows:CsvRow[]; errors:{line:number;code:string}[]; total:number };
export const MAX_BYTES=65536,MAX_ROWS=100;
const HEADERS={eclear:["measured_at","weight_kg","body_fat_pct"],lifestyle:["local_day","drinking_presence","drink_cups","steps"],fit:["local_day","steps"]};
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
      }else if(source==="fit"){
        const day=c[0].trim(),steps=num(c[1].trim(),1000000,true);
        if(!validDay(day))throw Error("DAY");
        rows.push({line,key:day,day,steps});
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
