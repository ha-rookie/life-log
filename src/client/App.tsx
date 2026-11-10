import { useEffect, useRef, useState } from "react";
import { WeightTrendPanel } from "./WeightTrend";
import { ProgressCharts } from "./ProgressCharts";

import { previewCsv, type CsvSource, type Preview } from "../shared/csv-import";
import { normalizeOfficialCsv, decodeOfficialCsv, detectOfficialCsvSource, partitionOfficialEclearComposition } from "../shared/source-adapter";
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
};

type HistoryJob = { id:string;source:string;status:string;startedAt:string;auditStatus:string;auditCount:number;insertedRecords:number };
type HistoryRow = {line:number;result:string;errorCode:string|null;values:null|Record<string,number|null>};
type JobPage = {jobs:HistoryJob[];nextCursor:string|null};
type RowPage = {job:{id:string;source:string;status:string;auditStatus:string;counts:null|Record<string,number>};rows:HistoryRow[];nextCursor:string|null};
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
  const [csvPreview, setCsvPreview] = useState<Preview | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewPartIndex,setReviewPartIndex] = useState<number|null>(null);
  const [importStatus, setImportStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const selectionEpoch = useRef(0);
  const fileInputRef = useRef<HTMLInputElement|null>(null);
  const completedParts = useRef(new Map<number,{inserted:number;updated:number;skipped:number;conflicted:number}>());
  const [history,setHistory]=useState<HistoryJob[]>([]);
  const [historyCursor,setHistoryCursor]=useState<string|null>(null);
  const [selectedJob,setSelectedJob]=useState<string|null>(null);
  const [auditRows,setAuditRows]=useState<HistoryRow[]>([]);
  const [rowCursor,setRowCursor]=useState<string|null>(null);
  const [auditState,setAuditState]=useState("");
  const [historyError,setHistoryError]=useState("");
  const [historyBusy,setHistoryBusy]=useState(false);
  const historyEpoch=useRef(0);
  async function loadHistory(next:string|null=null) {
    if(historyBusy)return;
    const epoch=++historyEpoch.current;
    setHistoryBusy(true);setHistoryError("");
    try{
      const res=await fetch("/api/import/history?limit=10"+(next?"&cursor="+encodeURIComponent(next):""),{credentials:"same-origin",cache:"no-store"});
      if(!res.ok)throw Error(String(res.status));
      const data=await res.json() as JobPage;
      if(epoch!==historyEpoch.current)return;
      setHistory(prev=>next?[...prev,...data.jobs]:data.jobs);
      setHistoryCursor(data.nextCursor);
    }catch{if(epoch===historyEpoch.current)setHistoryError("監査履歴を取得できません。認証と接続を確認してください。");}
    finally{setHistoryBusy(false);}
  }
  async function loadAudit(job:string,next:string|null=null) {
    if(historyBusy)return;
    const epoch=++historyEpoch.current;
    setHistoryBusy(true);setHistoryError("");
    try{
      const res=await fetch("/api/import/history/"+encodeURIComponent(job)+"?limit=10"+(next?"&cursor="+encodeURIComponent(next):""),{credentials:"same-origin",cache:"no-store"});
      if(!res.ok)throw Error(String(res.status));
      const data=await res.json() as RowPage;
      if(epoch!==historyEpoch.current)return;
      setSelectedJob(job);setAuditState(data.job.auditStatus);
      setAuditRows(prev=>next?[...prev,...data.rows]:data.rows);
      setRowCursor(data.nextCursor);
    }catch{if(epoch===historyEpoch.current)setHistoryError("監査行を取得できません。");}
    finally{setHistoryBusy(false);}
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
    setMissingFitSteps(0);setCsvEncoding(null);setCsvPreview(null);
    setImportStatus("ファイルを読み込み、形式を確認しています…");
    if(file.size>2_000_000){
      setImportStatus("ファイルが大きすぎます。CSVは2MB以下にしてください。登録は行っていません。");
      return;
    }
    try{
      const decoded=decodeOfficialCsv(new Uint8Array(await file.arrayBuffer()));
      const actualSource=detectOfficialCsvSource(decoded.text);
      if(!actualSource)throw Error("UNKNOWN_SOURCE");
      const normalized=normalizeOfficialCsv(actualSource,decoded.text);
      const composition=actualSource==="eclear"?partitionOfficialEclearComposition(decoded.text):null;
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
    if (keepExisting && (csvSource!=="lifestyle" || reviewPartIndex===null ||
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
        const applyReview=keepExisting && csvSource==="lifestyle" && n===pendingReviewPart;
        const response=await fetch("/api/import/confirm",{
          method:"POST",credentials:"same-origin",cache:"no-store",
          headers:{"Content-Type":"application/json","X-Life-Log-Intent":"manual-write-v1"},
          body:JSON.stringify({
            source:csvSource,csv:part,hash:p.hash,confirmed:true,
            ...(applyReview&&pendingReview?
              {resolution:{mode:"keep_existing",token:pendingReview.token}}:{})
          })
        });
        const data=await response.json() as ImportResult;
        if(epoch!==selectionEpoch.current)return;
        if(csvSource==="lifestyle"&&response.status===409&&
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
          skipped:data.skipped??0,conflicted:data.conflicted??0
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
        setImportStatus("登録完了：追加 "+total.inserted+"件・更新 "+total.updated+
          "件・スキップ "+total.skipped+"件"+
          (csvSource==="lifestyle"?"・既存優先 "+total.conflicted+"件":"")+
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
          csvSource==="weight_day"?"体重（日付のみ・既存日付はスキップ）":"生活記録"}</p>}
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
          <p>読み取り文字コード：{csvEncoding ?? "不明"}</p>
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
        <button type="button" disabled={historyBusy} onClick={()=>{setSelectedJob(null);setAuditRows([]);void loadHistory();}}>履歴を表示・更新</button>
        {historyError&&<p role="alert">{historyError}</p>}
        <ul>{history.map(j=><li key={j.id}>
          {j.startedAt} · {j.source} · {j.status} · 監査 {j.auditStatus==="legacy_unavailable"?"旧形式・記録なし":j.auditStatus==="incomplete"?"不完全":j.auditCount+"件"}
          <button type="button" disabled={historyBusy} onClick={()=>void loadAudit(j.id)}>行を表示</button>
        </li>)}</ul>
        {historyCursor&&<button type="button" disabled={historyBusy} onClick={()=>void loadHistory(historyCursor)}>さらに履歴を表示</button>}
        {selectedJob&&<div aria-live="polite">
          <h3>選択した取込の監査行</h3>
          {auditState==="legacy_unavailable"&&<p>旧形式のため行単位監査は存在しません。過去の結果は推定しません。</p>}
          {auditState==="incomplete"&&<p role="alert">監査記録が欠落しています。結果は確定できません。</p>}
          <ol>{auditRows.map(r=><li key={r.line}>CSV {r.line}行：{r.result}
            {r.errorCode?" ("+r.errorCode+")":""}
            {r.values&&<span> · {Object.entries(r.values).map(([k,v])=>k+"="+showValue(v)).join(" / ")}</span>}
            {!r.values&&" · 元の値は監査に保存されていません"}
          </li>)}</ol>
          {rowCursor&&<button type="button" disabled={historyBusy} onClick={()=>void loadAudit(selectedJob,rowCursor)}>さらに監査行を表示</button>}
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
