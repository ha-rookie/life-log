import { useEffect, useRef, useState } from "react";
import { WeightTrendPanel } from "./WeightTrend";
import { ProgressCharts } from "./ProgressCharts";

import { previewCsv, MAX_BYTES, type CsvSource, type Preview } from "../shared/csv-import";
import { normalizeOfficialCsv, decodeOfficialCsv, detectOfficialCsvSource, partitionOfficialEclearComposition, originalUtf8Proof } from "../shared/source-adapter";
import { EclearEnrichment } from "./EclearEnrichment";
import { ManualEntry } from "./ManualEntry";
import { PasskeySetup } from "./PasskeySetup";
import { MvpFeatures } from "./MvpFeatures";

type Page = "home" | "record" | "insights" | "data";
type Overview = {
  latestWeightKg:number|null; measuredAt:string|null; weightSource:string|null;
  latestSteps:number|null; stepsDay:string|null; stepsSource:string|null;
};
const PAGES:readonly {id:Page;name:string}[]=[
  {id:"home",name:"ホーム"},{id:"record",name:"記録"},
  {id:"insights",name:"分析"},{id:"data",name:"設定"}
];
function pageFromHash():Page {
  const v=window.location.hash.slice(1);
  return PAGES.some(x=>x.id===v)?v as Page:"home";
}
type LoadState =
  | { kind: "loading" }
  | { kind: "blocked"; message: string }
  | { kind: "ok"; summary: Overview };
type Conflict = { day: string; fields: string[] };
type Review = { token: string; conflicts: Conflict[] };
type ImportResult = {
  status?: string; error?: string; inserted?: number; updated?: number; skipped?: number;
  conflicted?: number; reviewToken?: string | null; conflicts?: Conflict[];
  auditStatus?: "legacy_unavailable" | "complete";
  targetCounts?:{inserted:number;skipped:number;conflicted:number;updated?:number};expectedTargets?:number;
};

type HistoryJob = { id:string;source:string;status:string;startedAt:string;auditStatus:string;auditCount:number;insertedRecords:number;originalSha256?:string|null;targetAuditCount?:number;expectedTargets?:number };
type HistoryRow = {line:number;result:string;errorCode:string|null;values:null|Record<string,number|null>;
  targets?:{target:string;result:string;errorCode:string|null}[]};
type JobPage = {jobs:HistoryJob[];nextCursor:string|null};
type RowPage = {job:{id:string;source:string;status:string;auditStatus:string;counts:null|Record<string,number>;originalSha256?:string|null;targetCounts?:Record<string,number>|null;expectedTargets?:number};rows:HistoryRow[];nextCursor:string|null};
const showValue=(n:number|null)=>n===null?"欠測（NULL）":String(n);
export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [page,setPage]=useState<Page>(pageFromHash);
  useEffect(()=>{
    const changed=()=>setPage(pageFromHash());
    window.addEventListener("hashchange",changed);
    return ()=>window.removeEventListener("hashchange",changed);
  },[]);
  function navigate(to:Page){
    setPage(to);if(window.location.hash!=="#"+to)window.location.hash=to;
    window.scrollTo({top:0,behavior:"instant"});
  }
  const todayLabel=new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",month:"long",day:"numeric",weekday:"long"}).format(new Date());
  const [csvSource, setCsvSource] = useState<CsvSource>("lifestyle");
  const [selectedCsvName,setSelectedCsvName] = useState<string|null>(null);
  const [canonicalParts,setCanonicalParts] = useState<string[]>([]);
  const [canonicalTotal,setCanonicalTotal] = useState(0);
  const [compositionParts,setCompositionParts] = useState<string[]>([]);
  const [eclearMode,setEclearMode] = useState<"usual"|"enrich">("usual");
  const [compositionBusy,setCompositionBusy] = useState(false);
  const [missingFitSteps,setMissingFitSteps] = useState(0);
  const [csvEncoding,setCsvEncoding] = useState<"UTF-8"|"Shift_JIS"|null>(null);
  const [originalProof,setOriginalProof]=useState<{originalBase64:string;originalSha256:string}|null>(null);
  const [csvPreview, setCsvPreview] = useState<Preview | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewPartIndex,setReviewPartIndex] = useState<number|null>(null);
  const [importStatus, setImportStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const selectionEpoch = useRef(0);
  const fileInputRef = useRef<HTMLInputElement|null>(null);
  const completedParts = useRef(new Map<number,{inserted:number;updated:number;skipped:number;conflicted:number;
    targetCounts?:{inserted:number;skipped:number;conflicted:number;updated?:number}}>());
  const [history,setHistory]=useState<HistoryJob[]>([]);
  const [historyCursor,setHistoryCursor]=useState<string|null>(null);
  const [historyPage,setHistoryPage]=useState(0);
  const [historyStarts,setHistoryStarts]=useState<(string|null)[]>([null]);
  const [selectedJob,setSelectedJob]=useState<string|null>(null);
  const [auditRows,setAuditRows]=useState<HistoryRow[]>([]);
  const [rowCursor,setRowCursor]=useState<string|null>(null);
  const [auditPage,setAuditPage]=useState(0);
  const [auditStarts,setAuditStarts]=useState<(string|null)[]>([null]);
  const [auditState,setAuditState]=useState("");
  const [auditOriginalHash,setAuditOriginalHash]=useState<string|null>(null);
  const [historyError,setHistoryError]=useState("");
  const [historyBusy,setHistoryBusy]=useState(false);
  const historyEpoch=useRef(0);
  async function loadHistory(cursor:string|null=null,pageIndex=0) {
    if(historyBusy)return;
    const epoch=++historyEpoch.current;
    setHistoryBusy(true);setHistoryError("");
    try{
      const res=await fetch("/api/import/history?limit=10"+(cursor?"&cursor="+encodeURIComponent(cursor):""),{credentials:"same-origin",cache:"no-store"});
      if(!res.ok)throw Error(String(res.status));
      const data=await res.json() as JobPage;
      if(epoch!==historyEpoch.current)return;
      // Display a bounded page, not all previously fetched rows.
      setHistory(data.jobs);setHistoryCursor(data.nextCursor);
      setHistoryPage(pageIndex);
      setHistoryStarts(prev=>pageIndex===0?[null]:[...prev.slice(0,pageIndex),cursor]);
      setSelectedJob(null);setAuditRows([]);setRowCursor(null);
      setAuditPage(0);setAuditStarts([null]);setAuditState("");setAuditOriginalHash(null);
    }catch{if(epoch===historyEpoch.current)setHistoryError("監査履歴を取得できません。認証と接続を確認してください。");}
    finally{if(epoch===historyEpoch.current)setHistoryBusy(false);}
  }
  async function loadAudit(job:string,cursor:string|null=null,pageIndex=0) {
    if(historyBusy)return;
    const epoch=++historyEpoch.current;
    setHistoryBusy(true);setHistoryError("");
    try{
      const res=await fetch("/api/import/history/"+encodeURIComponent(job)+"?limit=10"+(cursor?"&cursor="+encodeURIComponent(cursor):""),{credentials:"same-origin",cache:"no-store"});
      if(!res.ok)throw Error(String(res.status));
      const data=await res.json() as RowPage;
      if(epoch!==historyEpoch.current)return;
      setSelectedJob(job);setAuditState(data.job.auditStatus);
      setAuditOriginalHash(data.job.originalSha256??null);
      setAuditRows(data.rows);setRowCursor(data.nextCursor);
      setAuditPage(pageIndex);
      setAuditStarts(prev=>pageIndex===0?[null]:[...prev.slice(0,pageIndex),cursor]);
    }catch{if(epoch===historyEpoch.current)setHistoryError("監査行を取得できません。認証と接続を確認してください。");}
    finally{if(epoch===historyEpoch.current)setHistoryBusy(false);}
  }

  async function selectCsv(file: File) {
    const epoch=++selectionEpoch.current;
    // Android download providers sometimes return a percent-encoded name.
    // Decode only the label; never alter bytes, contents or source hashes.
    let displayName=file.name;
    if(/%[0-9A-Fa-f]{2}/.test(displayName)){
      try{displayName=decodeURIComponent(displayName);}catch{/* Keep original display name. */}
    }
    setSelectedCsvName(displayName);
    completedParts.current.clear();
    setReviewPartIndex(null);setReview(null);
    setCanonicalParts([]);setCanonicalTotal(0);
    setCompositionParts([]);setEclearMode("usual");
    setMissingFitSteps(0);setCsvEncoding(null);setCsvPreview(null);setOriginalProof(null);
    setImportStatus("ファイルを読み込み、形式を確認しています…");
    if(file.size>2_000_000){
      setImportStatus("ファイルが大きすぎます。CSVは2MB以下にしてください。登録は行っていません。");
      return;
    }
    try{
      const bytes=new Uint8Array(await file.arrayBuffer());
      const decoded=decodeOfficialCsv(bytes);
      const actualSource=detectOfficialCsvSource(decoded.text);
      if(!actualSource)throw Error("UNKNOWN_SOURCE");
      const normalized=normalizeOfficialCsv(actualSource,decoded.text);
      const composition=actualSource==="eclear"?partitionOfficialEclearComposition(decoded.text):null;
      // Bounded single-chunk strict UTF-8 only. Multipart and CP932 remain
      // canonical imports; never claim unverified source-byte provenance.
      const raw=decoded.encoding==="UTF-8"&&bytes.byteLength<=MAX_BYTES&&
        normalized.parts.length===1?await originalUtf8Proof(bytes):null;
      // Validate every chunk BEFORE exposing the confirm button. Lifestyle
      // remains bounded by the server limit and D1 conflict guard parameters.
      const checked=await Promise.all(normalized.parts.map(part=>previewCsv(actualSource,part)));
      if(checked.length===0||checked.some(item=>item.errors.length>0||item.rows.length===0))
        throw Error("INVALID_ROWS");
      if(epoch!==selectionEpoch.current)return;
      setCsvSource(actualSource);
      setCanonicalParts(normalized.parts);
      setCompositionParts(composition?.parts??[]);
      setCanonicalTotal(normalized.total);
      setMissingFitSteps(normalized.missingSteps);
      setCsvEncoding(decoded.encoding);
      setOriginalProof(raw);
      setCsvPreview(checked[0]);
      setImportStatus(actualSource==="eclear"
        ?"ECLEARの読み込みが完了しました。取込方法を選択してください。まだ登録していません。"
        :"読み取り完了。まだ登録していません。件数を確認し、「確認して登録する」を押してください。");
    }catch{
      if(epoch===selectionEpoch.current)setImportStatus(
        "CSVの形式・日時・数値・重複を確認できませんでした。データは登録していません。"
      );
    }
  }

  async function submit(keepExisting = false) {
    if (!csvPreview || csvPreview.errors.length || !csvPreview.rows.length || busy ||
        !canonicalParts.length) return;
    if (keepExisting && ((csvSource!=="lifestyle"&&csvSource!=="lifestyle_weight") || reviewPartIndex===null ||
        !review || review.conflicts.length===0)) return;
    const epoch = selectionEpoch.current;
    const pendingReviewPart=reviewPartIndex;
    const pendingReview=review;
    setBusy(true);
    setImportStatus("");
    try {
      for(let n=0;n<canonicalParts.length;n++){
        // Completed chunks are immutable audit jobs. Skipping them here also
        // prevents duplicate counting when a later chunk needs conflict review.
        if(completedParts.current.has(n))continue;
        const part=canonicalParts[n],p=await previewCsv(csvSource,part);
        const applyReview=keepExisting && (csvSource==="lifestyle"||csvSource==="lifestyle_weight") && n===pendingReviewPart;
        const response=await fetch("/api/import/confirm",{
          method:"POST",credentials:"same-origin",cache:"no-store",
          headers:{"Content-Type":"application/json","X-Life-Log-Intent":"manual-write-v1"},
          body:JSON.stringify({
            source:csvSource,csv:part,hash:p.hash,confirmed:true,
            ...(applyReview&&pendingReview?
              {resolution:{mode:"keep_existing",token:pendingReview.token}}:{}),
            ...(originalProof&&canonicalParts.length===1?originalProof:{})
          })
        });
        const data=await response.json() as ImportResult;
        if(epoch!==selectionEpoch.current)return;
        if((csvSource==="lifestyle"||csvSource==="lifestyle_weight")&&response.status===409&&
          (data.error==="LIFESTYLE_CONFLICT"||data.error==="REVIEW_STALE")&&
          data.reviewToken&&data.conflicts){
          setReview({token:data.reviewToken,conflicts:data.conflicts});
          setReviewPartIndex(n);
          setImportStatus(data.error==="REVIEW_STALE"
            ? "既存記録が変わっています。競合を再確認してください。"+
              (n+1)+"/"+canonicalParts.length+" 分割目で停止中。"
            : "既存の生活記録と矛盾があります。"+
              (n+1)+"/"+canonicalParts.length+" 分割目で停止中。未処理分は登録していません。");
          return;
        }
        if(!response.ok)throw Error("HTTP "+response.status+" / "+(data.error??"UNKNOWN")+
          "（"+(n+1)+"/"+canonicalParts.length+"）");
        completedParts.current.set(n,{
          inserted:data.inserted??0,updated:data.updated??0,
          skipped:data.skipped??0,conflicted:data.conflicted??0,
          targetCounts:data.targetCounts
        });
        setReview(null);setReviewPartIndex(null);
        setImportStatus("登録中 "+(n+1)+"/"+canonicalParts.length+" 分割");
      }
      const total=[...completedParts.current.values()].reduce((acc,c)=>({
        inserted:acc.inserted+c.inserted,updated:acc.updated+c.updated,
        skipped:acc.skipped+c.skipped,conflicted:acc.conflicted+c.conflicted
      }),{inserted:0,updated:0,skipped:0,conflicted:0});
      if(epoch===selectionEpoch.current){
        setReview(null);setReviewPartIndex(null);
        const targetTotal=[...completedParts.current.values()].reduce((acc,c)=>({
          inserted:acc.inserted+(c.targetCounts?.inserted??0),
          skipped:acc.skipped+(c.targetCounts?.skipped??0),
          conflicted:acc.conflicted+(c.targetCounts?.conflicted??0)
        }),{inserted:0,skipped:0,conflicted:0});
        setImportStatus("登録完了：追加 "+total.inserted+"件・更新 "+total.updated+
          "件・スキップ "+total.skipped+"件"+
          ((csvSource==="lifestyle"||csvSource==="lifestyle_weight")?"・既存優先 "+total.conflicted+"件":"")+
          (csvSource==="lifestyle_weight"?"。保存先別：追加 "+targetTotal.inserted+
             "件・スキップ "+targetTotal.skipped+"件・競合 "+targetTotal.conflicted+"件":"")+
          "。元データ "+canonicalTotal+"件"+
          (csvSource==="fit"?"、Fit歩数欠測 "+missingFitSteps+"日":"")+"。");
        setRefreshEpoch(n=>n+1);
      }
    } catch {
      if(epoch===selectionEpoch.current){
        setReview(null);setReviewPartIndex(null);
        setImportStatus("取込中断。完了済み "+completedParts.current.size+
          "/"+canonicalParts.length+" 分割は保持されています。"+
          "同じファイルで「確認して登録する」を押すと残りから再試行できます。");
      }
    } finally{
      setBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetch("/api/dashboard", {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!res.ok) {
          if (!controller.signal.aborted) setState({
            kind: "blocked", message: "記録を表示できません。ログイン状態を確認してください。",
          });
          return;
        }
        const summary: Overview = await res.json();
        if (!controller.signal.aborted) setState({ kind: "ok", summary });
      } catch {
        if (!controller.signal.aborted) setState({
          kind: "blocked", message: "データに接続できません。再読み込みしてください。",
        });
      }
    }
    void load();
    return () => controller.abort();
  }, [refreshEpoch]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">L</span>
          <span className="brand-name">ライフログ</span>
        </div>
        <span className="today-label">{todayLabel}</span>
      </header>
      <nav className="app-nav app-nav-desktop" aria-label="メインメニュー">
        {PAGES.map(item=><button key={item.id} type="button" aria-current={page===item.id?"page":undefined}
          className={page===item.id?"active":""} onClick={()=>navigate(item.id)}>
          <span className={"nav-icon nav-icon-"+item.id} aria-hidden="true"></span>
          <span>{item.name}</span>
        </button>)}
      </nav>
      <main className="container" id="content">
        <div className="page-heading">
          <span className="eyebrow">{page==="home"?"OVERVIEW":page==="record"?"DAILY LOG":page==="insights"?"INSIGHTS":"YOUR DATA"}</span>
          <h1>{page==="home"?"今日の状況":page==="record"?"記録する":page==="insights"?"変化を分析する":"設定とデータ"}</h1>
          <p className="intro">{page==="home"?"いまの記録をひと目で確認。":page==="record"?"必要な項目だけ記録できます。":page==="insights"?"体重と歩数を同じ期間で比べられます。":"CSVの取込・書き出し、認証設定はこちら。"}</p>
        </div>
        {page==="home"&&<>
          <div className="overview-grid">
            <section className="metric-card" aria-labelledby="overview-weight">
              <p className="card-kicker" id="overview-weight">最新の体重</p>
              <p className="hero-number">{state.kind==="ok"&&state.summary.latestWeightKg!==null
                 ? <>{state.summary.latestWeightKg.toFixed(1)}<span>kg</span></>
                 : state.kind==="loading"?"…":"—"}</p>
              <p className="metric-meta">{state.kind==="ok"&&state.summary.measuredAt
                ? state.summary.measuredAt.slice(0,10).replaceAll("-","/")+
                  (state.summary.weightSource?.startsWith("manual:")?" · 手入力":
                    state.summary.weightSource==="csv:weight_day"?" · 過去記録（日付のみ）":" · ECLEAR")
                : "測定記録なし"}</p>
            </section>
            <section className="metric-card" aria-labelledby="overview-steps">
              <p className="card-kicker" id="overview-steps">最新の歩数</p>
              <p className="hero-number">{state.kind==="ok"&&state.summary.latestSteps!==null
                ? <>{state.summary.latestSteps.toLocaleString("ja-JP")}<span>歩</span></>
                : state.kind==="loading"?"…":"—"}</p>
              <p className="metric-meta">{state.kind==="ok"&&state.summary.stepsDay
                ? state.summary.stepsDay.replaceAll("-","/")+
                  (state.summary.stepsSource?.startsWith("manual:")?" · 手入力":" · Google Fit")
                : "歩数記録なし"}</p>
            </section>
          </div>
          {state.kind==="blocked"&&<p role="alert" className="notice-error">{state.message}</p>}
          <button className="cta-link home-record-action" type="button" onClick={()=>navigate("record")}>
            <span>＋ 今日の記録を追加</span><span aria-hidden="true">→</span>
          </button>
          <ProgressCharts view="home" refreshEpoch={refreshEpoch}/>
          <MvpFeatures mode="quick" onSaved={()=>setRefreshEpoch(n=>n+1)}/>
        </>}
        {page==="record"&&<>
          <ManualEntry onSaved={()=>setRefreshEpoch(n=>n+1)}/>
          <MvpFeatures mode="record" onSaved={()=>setRefreshEpoch(n=>n+1)}/>
        </>}
        {page==="insights"&&<>
          <ProgressCharts view="analysis" refreshEpoch={refreshEpoch}/>
          <MvpFeatures mode="analysis" onSaved={()=>setRefreshEpoch(n=>n+1)}/>
          <details className="advanced-group">
            <summary>体重グラフの詳細・目標設定</summary>
            <WeightTrendPanel key={refreshEpoch}/>
          </details>
        </>}
        {page==="data"&&<>
                <section className="panel" aria-labelledby="csv-title">
        <h2 id="csv-title">CSVを取り込む</h2>
        <p className="hint">Google Fitの歩数・ECLEARの体重を優先します。通常取込は同じ値をスキップし、異なる体重・体脂肪率を訂正します。体組成の不足項目補完とは別の操作です。</p>
        <p className="hint">ファイルを選ぶとECLEAR・Google Fit・生活記録を自動判別します。</p>
        <p>
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" hidden
            disabled={busy||compositionBusy} aria-label="CSVファイルを選ぶ" onChange={e=>{
              const file=e.target.files?.[0];
              e.currentTarget.value="";
              if(file)void selectCsv(file);
            }} />
          <button type="button" disabled={busy||compositionBusy} onClick={()=>fileInputRef.current?.click()}>
            ファイルを選択
          </button>
        </p>
        {selectedCsvName&&<p role="status" className="hint">選択したファイル：<strong>{selectedCsvName}</strong></p>}
        {csvPreview&&<p className="hint">判別した種類：{csvSource==="eclear"?"ECLEAR（体重）":
          csvSource==="fit"?"Google Fit（歩数）":
          csvSource==="weight_day"?"体重（日付のみ・既存日付はスキップ）":
          csvSource==="lifestyle_weight"?"生活記録＋体重（日付のみ）":"生活記録"}</p>}
        {csvPreview&&csvSource==="eclear"&&<div className="eclear-mode" role="group" aria-label="ECLEARの取込方法">
          <button type="button" aria-pressed={eclearMode==="usual"} disabled={busy||compositionBusy}
            onClick={()=>{setEclearMode("usual");setReview(null);setImportStatus("");}}>
            体重・体脂肪率を通常取込
          </button>
          <button type="button" aria-pressed={eclearMode==="enrich"} disabled={busy||compositionBusy}
            onClick={()=>{setEclearMode("enrich");setReview(null);setImportStatus("");}}>
            体組成の不足項目だけ補完
          </button>
        </div>}
        {csvPreview&&(csvSource!=="eclear"||eclearMode==="usual") && <div aria-live="polite">
          {csvSource==="lifestyle_weight"&&<p className="hint">
            体重欄のある行は体重も別保存します。測定時刻は作らず、既存の日付の体重は上書きしません。
            生活記録と体重は保存先ごとに監査します。
          </p>}
          <p>読み取り文字コード：{csvEncoding ?? "不明"}</p>
          <p className="hint">{originalProof
            ?"元ファイルのSHA-256を照合します（1分割のUTF-8 CSV）。"
            :"元ファイルのバイト証跡は対象外です（分割取込またはUTF-8以外）。正規化したCSVのみ検証します。"}</p>
          <p>対象 {canonicalParts.length?canonicalTotal:csvPreview.total} 行 /
            有効 {canonicalParts.length?canonicalTotal:csvPreview.rows.length} 行 /
            異常 {csvPreview.errors.length} 行
            {canonicalParts.length>0?"（"+canonicalParts.length+"分割、Fit欠測 "+missingFitSteps+"日）":""}
          </p>
          {csvPreview.errors.map(e => <p key={e.line}>行 {e.line}: {e.code}</p>)}
          <button type="button" disabled={busy || !!csvPreview.errors.length ||
            !csvPreview.rows.length} onClick={() => void submit(false)}>
            確認して登録する
          </button>
        </div>}
        {csvPreview&&csvSource==="eclear"&&eclearMode==="enrich"&&compositionParts.length>0&&
          <EclearEnrichment parts={compositionParts} filename={selectedCsvName??""}
            encoding={csvEncoding} onBusyChange={setCompositionBusy}
            onSaved={()=>setRefreshEpoch(n=>n+1)}/>}
        {review && (csvSource!=="eclear"||eclearMode==="usual") && review.conflicts.length > 0 && <div role="group"
          aria-label="生活記録の競合解決">
          <h3>既存の記録と競合しています</h3>
          <p>既存データは変更しません。以下の競合行を除いて、
            残りの行を自動的に登録します。完了済みの分割は保持されています。</p>
          <ul>{review.conflicts.map(c =>
            <li key={c.day}>{c.day}：{c.fields.join(" / ")}</li>)}</ul>
          <button type="button" disabled={busy} onClick={() => void submit(true)}>
            競合行は既存を優先し、その他を登録する
          </button>
          <button type="button" disabled={busy} onClick={() => {
            setReview(null);setReviewPartIndex(null);
            setImportStatus("残りの取込を中止しました。完了済みの "+
              completedParts.current.size+" 分割は保持されています。");
          }}>取込を中止する</button>
        </div>}
        {importStatus && <p role="status">{importStatus}</p>}
      </section>

          <details className="advanced-group">
            <summary>CSVを書き出す</summary>
            <MvpFeatures mode="data" onSaved={()=>setRefreshEpoch(n=>n+1)}/>
          </details>
          <details className="advanced-group">
            <summary>取込履歴・監査の詳細</summary>
                  <section className="panel" aria-labelledby="history-title">
        <h2 id="history-title">取込履歴の詳細</h2>
        <p>監査は読み取り専用。過去の取込結果が存在しない場合、推測して補完しません。</p>
        <button type="button" disabled={historyBusy} onClick={()=>void loadHistory()}>履歴を表示・更新</button>
        {historyError&&<p role="alert">{historyError}</p>}
        {historyBusy&&<p role="status">監査履歴を読み込み中…</p>}
        {!historyBusy&&!historyError&&history.length===0&&<p className="hint">この期間に表示できる取込履歴はありません。</p>}
        {history.length>0&&<p className="hint">取込履歴 {historyPage+1}ページ目（各ページ最大10件）</p>}
        <ul>{history.map(j=><li key={j.id}>
          {j.startedAt} · {j.source} · {j.status} · 監査 {j.auditStatus==="legacy_unavailable"?"旧形式・記録なし":j.auditStatus==="incomplete"?"不完全":j.auditCount+"件"}
          {j.originalSha256&&" · 元CSVハッシュ記録あり"}
          {j.source==="lifestyle_weight"&&" · 保存先監査 "+(j.targetAuditCount??0)+"/"+(j.expectedTargets??"?")}
          <button type="button" disabled={historyBusy} onClick={()=>void loadAudit(j.id)}>行を表示</button>
        </li>)}</ul>
        {historyPage>0&&<button type="button" disabled={historyBusy} onClick={()=>void loadHistory(historyStarts[historyPage-1],historyPage-1)}>前の取込10件</button>}
        {historyCursor&&<button type="button" disabled={historyBusy} onClick={()=>void loadHistory(historyCursor,historyPage+1)}>次の取込10件</button>}
        {selectedJob&&<div aria-live="polite">
          <h3>選択した取込の監査行</h3>
          <p className="hint">{auditOriginalHash
            ?<>元CSV SHA-256（最初に取込んだUTF-8ファイル）：
              <code style={{overflowWrap:"anywhere"}}>{auditOriginalHash}</code></>
            :"元CSVのバイト証跡は保存されていません。"}</p>
          <p className="hint">表示する保存済み数値は現在のDBの値です。当時の元CSVの数値ではありません。</p>
          {auditState==="legacy_unavailable"&&<p>旧形式のため行単位監査は存在しません。過去の結果は推定しません。</p>}
          {auditState==="incomplete"&&<p role="alert">監査記録が欠落しています。結果は確定できません。</p>}
          {auditRows.length===0&&auditState==="available"&&<p className="hint">この取込に監査行はありません。</p>}
          {auditRows.length>0&&<p className="hint">監査行 {auditPage+1}ページ目（各ページ最大10件）</p>}
          <ol>{auditRows.map(r=><li key={r.line}>CSV {r.line}行：{r.result}
            {r.errorCode?" ("+r.errorCode+")":""}
            {r.targets&&<span> · 保存先：
              {r.targets.map(t=>t.target==="weight_day"?"体重="+t.result:"生活記録="+t.result).join(" / ")}
            </span>}
            {r.values&&<span> · {Object.entries(r.values).map(([k,v])=>k+"="+showValue(v)).join(" / ")}</span>}
            {!r.values&&" · 元の値は監査に保存されていません"}
          </li>)}</ol>
          {auditPage>0&&<button type="button" disabled={historyBusy} onClick={()=>void loadAudit(selectedJob,auditStarts[auditPage-1],auditPage-1)}>前の監査行10件</button>}
          {rowCursor&&<button type="button" disabled={historyBusy} onClick={()=>void loadAudit(selectedJob,rowCursor,auditPage+1)}>次の監査行10件</button>}
        </div>}
      </section>

          </details>
          <details className="advanced-group">
            <summary>ログイン・パスキー設定</summary>
            <PasskeySetup/>
          </details>
        </>}
        <footer>ライフログは本人専用です。記録のない日は0として扱いません。</footer>
      </main>
      <nav className="app-nav app-nav-mobile" aria-label="画面の切り替え">
        {PAGES.map(item=><button key={item.id} type="button" aria-current={page===item.id?"page":undefined}
          className={page===item.id?"active":""} onClick={()=>navigate(item.id)}>
          <span className={"nav-icon nav-icon-"+item.id} aria-hidden="true"></span>
          <span>{item.name}</span>
        </button>)}
      </nav>
    </div>
  );
}
