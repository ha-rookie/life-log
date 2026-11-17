import {useEffect,useState} from "react";
import { redirectOnExpiredOwnerSession } from "./auth-recovery";

/** Data-only preview. Neither the local D1 record IDs nor measured values cross to UI. */
export type CompositionPreview={
  status:"preview";reviewToken:string;
  total:number;newMeasurements:number;enrichMeasurements:number;
  enrichCells:number;sameCells:number;conflictMeasurements:number;
  missingCells:number;unchangedMeasurements:number;
  classifications:{
    line:number;status:"new"|"enrich"|"unchanged"|"conflict";
    enrichFields:string[];conflictFields:string[];
    reason?:"ambiguous_eclear"|"non_eclear_source"|"date_only_source"|"existing_value_conflict";
  }[];
};
type ApiResult={status?:"applied"|"unchanged";inserted?:number;enriched?:number;cells?:number;error?:string};
type ApiError=Error&{status?:number;code?:string};
export type PreviewTotals={
  newMeasurements:number;enrichMeasurements:number;enrichCells:number;
  sameCells:number;conflictMeasurements:number;missingCells:number;unchangedMeasurements:number;
};
export function summarizeEclearPreviews(items:readonly CompositionPreview[]):PreviewTotals{
  return items.reduce<PreviewTotals>((acc,p)=>({
    newMeasurements:acc.newMeasurements+p.newMeasurements,
    enrichMeasurements:acc.enrichMeasurements+p.enrichMeasurements,
    enrichCells:acc.enrichCells+p.enrichCells,
    sameCells:acc.sameCells+p.sameCells,
    conflictMeasurements:acc.conflictMeasurements+p.conflictMeasurements,
    missingCells:acc.missingCells+p.missingCells,
    unchangedMeasurements:acc.unchangedMeasurements+p.unchangedMeasurements
  }),{newMeasurements:0,enrichMeasurements:0,enrichCells:0,sameCells:0,
      conflictMeasurements:0,missingCells:0,unchangedMeasurements:0});
}
const reasons:Record<NonNullable<CompositionPreview["classifications"][number]["reason"]>,string>={
  ambiguous_eclear:"同時刻にECLEARの記録が複数あります",
  non_eclear_source:"別の出典による記録があります",
  date_only_source:"時刻のない体重記録と重なるため判断できません",
  existing_value_conflict:"既存の数値とCSVの数値が異なります"
};
export function eclearErrorMessage(status?:number,code?:string,confirm=false):string{
  if(status===403&&code==="ECLEAR_LOCAL_DISABLED")
    return "この環境では体組成の補完機能は無効です。既存の記録は変更していません。";
  if(status===401||status===403)
    return "ログインまたは利用権限を確認してください。登録は確認できません。";
  if(status===409&&code==="REVIEW_STALE")
    return "確認した記録が変更されたか、確認期限が切れました。もう一度プレビューしてください。";
  if(status===409&&code==="ECLEAR_CONFLICT")
    return "既存値と競合する行があります。上書きせずに停止しました。再確認してください。";
  if(status===409)return "記録の状態が変わった可能性があります。再プレビューが必要です。";
  if(confirm)return "通信または検証に失敗しました。登録結果は未確定です。自動再送はしていません。";
  return "プレビューを取得できません。認証と通信状態を確認してください。登録は行っていません。";
}
async function requestV2(
  kind:"preview"|"confirm",csv:string,reviewToken?:string
):Promise<CompositionPreview|ApiResult>{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20_000);
  try{
    const response=await fetch("/api/eclear/enrichment/"+kind,{
      method:"POST",credentials:"same-origin",cache:"no-store",signal:controller.signal,
      headers:{"Content-Type":"application/json","X-Life-Log-Intent":"eclear-enrichment-v2"},
      body:JSON.stringify(reviewToken===undefined?{csv}:{csv,token:reviewToken})
    });
    if(!controller.signal.aborted && await redirectOnExpiredOwnerSession(response))
      throw new Error("LOGIN_REQUIRED");
    const data=await response.json().catch(()=>({})) as Record<string,unknown>;
    if(!response.ok){
      const e=new Error("ECLEAR_API_FAILURE") as ApiError;
      e.status=response.status;e.code=typeof data.error==="string"?data.error:undefined;
      throw e;
    }
    return data as CompositionPreview|ApiResult;
  }finally{clearTimeout(timer);}
}
function isPreview(value:CompositionPreview|ApiResult):value is CompositionPreview{
  return value.status==="preview"&&typeof (value as CompositionPreview).reviewToken==="string";
}
export function EclearEnrichment({parts,filename,encoding,onSaved,onBusyChange}:{
  parts:readonly string[];filename:string;encoding:string|null;onSaved:()=>void;
  onBusyChange:(busy:boolean)=>void;
}){
  const [busy,setBusy]=useState(false);
  function updateBusy(next:boolean){setBusy(next);onBusyChange(next);}
  const [previews,setPreviews]=useState<CompositionPreview[]>([]);
  const [acknowledged,setAcknowledged]=useState(false);
  const [message,setMessage]=useState("");
  const [outcome,setOutcome]=useState<"none"|"success"|"uncertain">("none");
  const [completed,setCompleted]=useState(0);
  // A new file selection must never reuse a token from the previously selected file.
  useEffect(()=>{setPreviews([]);setAcknowledged(false);setMessage("");
    setOutcome("none");setCompleted(0);},[parts]);
  const totals=summarizeEclearPreviews(previews);
  const canApply=!busy&&previews.length===parts.length&&parts.length>0&&
    totals.conflictMeasurements===0&&acknowledged&&outcome!=="success"&&completed===0;
  async function previewAll(){
    if(busy||!parts.length)return;
    updateBusy(true);setPreviews([]);setAcknowledged(false);setMessage("");
    setCompleted(0);setOutcome("none");
    try{
      const next:CompositionPreview[]=[];
      for(const part of parts){
        const response=await requestV2("preview",part);
        if(!isPreview(response))throw Error("INVALID_PREVIEW");
        next.push(response);
      }
      setPreviews(next);
      const summary=summarizeEclearPreviews(next);
      setMessage(summary.conflictMeasurements
        ?"競合する行があります。自動上書きは行いません。対象を確認してください。"
        :"プレビューが完了しました。値はまだ保存していません。");
    }catch(e){
      const x=e as ApiError;
      setMessage(eclearErrorMessage(x.status,x.code));
    }finally{updateBusy(false);}
  }
  async function apply(){
    if(!canApply)return;
    // A confirmed user action is required, and the exact preview tokens are
    // passed unchanged. Never auto-retry a failed/timed-out mutation.
    updateBusy(true);setMessage("保存・再照合中…");setOutcome("none");
    let changed=0,done=0;
    try{
      for(let index=0;index<parts.length;index++){
        const response=await requestV2("confirm",parts[index],previews[index].reviewToken);
        if(response.status!=="applied"&&response.status!=="unchanged")throw Error("UNVERIFIED_COMMIT");
        const follow=await requestV2("preview",parts[index]);
        if(!isPreview(follow)||follow.newMeasurements!==0||
          follow.enrichCells!==0||follow.conflictMeasurements!==0)throw Error("UNVERIFIED_RECHECK");
        changed+=(response.inserted??0)+(response.enriched??0);
        done++;setCompleted(done);
      }
      setOutcome("success");setAcknowledged(false);
      setMessage("補完が完了し、保存結果を再照合しました。更新した測定 "+changed+" 件。");
      onSaved();
    }catch(e){
      const x=e as ApiError;
      setOutcome("uncertain");setAcknowledged(false);setPreviews([]);
      setMessage(eclearErrorMessage(x.status,x.code,true)+
        (done>0?" 確認済み "+done+"/"+parts.length+" 分割。":"")+
        " 状態を確認するには「再プレビュー」を押してください。");
    }finally{updateBusy(false);}
  }
  return <section className="eclear-enrichment" aria-labelledby="eclear-v2-heading">
    <h3 id="eclear-v2-heading">体組成の不足項目を補完</h3>
    <p className="hint">体重・体脂肪率を含む既存の数値は上書きしません。
      骨格筋率・BMI・内臓脂肪レベル・骨量・基礎代謝量の未登録項目を補います。</p>
    <p className="hint">元のECLEAR 10列を確認し、7項目と測定日時だけを送信します。
      メモは保存・送信しません。時刻の異なる測定は別に扱います。</p>
    <div className="eclear-file-summary">
      <span>選択ファイル：<strong>{filename}</strong></span>
      <span>文字コード：{encoding??"不明"}</span>
      <span>{parts.length} 分割（最大40件／分割）</span>
    </div>
    <button type="button" disabled={busy||parts.length===0} onClick={()=>void previewAll()}>
      {previews.length?"再プレビュー":"不足項目を確認する"}
    </button>
    {previews.length>0&&<div className="eclear-preview" aria-live="polite">
      <h4>事前プレビュー（まだ保存していません）</h4>
      <dl className="eclear-summary-grid">
        <div><dt>新規測定</dt><dd>{totals.newMeasurements}件</dd></div>
        <div><dt>補完対象</dt><dd>{totals.enrichMeasurements}件</dd></div>
        <div><dt>補完する項目</dt><dd>{totals.enrichCells}項目</dd></div>
        <div><dt>同じ値</dt><dd>{totals.sameCells}項目</dd></div>
        <div><dt>競合</dt><dd>{totals.conflictMeasurements}件</dd></div>
        <div><dt>CSVの欠測</dt><dd>{totals.missingCells}項目</dd></div>
      </dl>
      {totals.conflictMeasurements>0&&<div role="alert" className="eclear-conflicts">
        <strong>競合する測定は保留します</strong>
        <ul>{previews.flatMap((p,i)=>p.classifications
          .filter(c=>c.status==="conflict")
          .map(c=><li key={i+"-"+c.line}>分割{i+1}・{c.line}行：
            {c.reason?reasons[c.reason]:"値を照合できません"}</li>))}</ul>
      </div>}
      {totals.conflictMeasurements===0&&outcome!=="success"&&completed===0&&
        <label className="eclear-ack">
          <input type="checkbox" checked={acknowledged} disabled={busy}
            onChange={e=>setAcknowledged(e.currentTarget.checked)} />
          件数と処理内容を確認しました。既存の値を保持して補完します。
        </label>}
      {totals.conflictMeasurements===0&&outcome!=="success"&&completed===0&&
        <div className="eclear-actions">
          <button type="button" className="cta" disabled={!canApply} onClick={()=>void apply()}>
            確認して不足項目を保存する
          </button>
          <button type="button" disabled={busy} onClick={()=>{
            setPreviews([]);setAcknowledged(false);setMessage("保存を中止しました。");
          }}>キャンセル</button>
        </div>}
    </div>}
    {message&&<p role="status" className={outcome==="uncertain"?"notice-error":"hint"}>{message}</p>}
  </section>;
}
