import { useEffect, useRef, useState } from "react";
import { WeightTrendPanel } from "./WeightTrend";
import type { Summary } from "../shared/legacy";
import { previewCsv, type CsvSource, type Preview } from "../shared/csv-import";
import { normalizeOfficialCsv } from "../shared/source-adapter";
import { ManualEntry } from "./ManualEntry";
import { PasskeySetup } from "./PasskeySetup";
import { MvpFeatures } from "./MvpFeatures";

type LoadState =
  | { kind: "loading" }
  | { kind: "blocked"; message: string }
  | { kind: "ok"; summary: Summary };
type Conflict = { day: string; fields: string[] };
type Review = { token: string; conflicts: Conflict[] };
type ImportResult = {
  status?: string; error?: string; inserted?: number; skipped?: number;
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
  const [csvSource, setCsvSource] = useState<CsvSource>("lifestyle");
  const [csvText, setCsvText] = useState("");
  const [canonicalParts,setCanonicalParts] = useState<string[]>([]);
  const [canonicalTotal,setCanonicalTotal] = useState(0);
  const [missingFitSteps,setMissingFitSteps] = useState(0);
  const [csvPreview, setCsvPreview] = useState<Preview | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [importStatus, setImportStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const selectionEpoch = useRef(0);
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

  async function selectCsv(file: File, source: CsvSource) {
    const epoch = ++selectionEpoch.current;
    setCsvText(""); setCanonicalParts([]);setCanonicalTotal(0);setMissingFitSteps(0);
    setCsvPreview(null); setReview(null); setImportStatus("");
    if (file.size > (source === "lifestyle" ? 65536 : 2_000_000)) {
      setImportStatus(source === "lifestyle" ? "CSVは64KiB以下にしてください。" : "CSVは2MB以下にしてください。");
      return;
    }
    try {
      const raw = await file.text();
      if(source==="lifestyle"){
        const parsed=await previewCsv(source,raw);
        if(epoch!==selectionEpoch.current)return;
        setCsvText(raw);setCsvPreview(parsed);
      }else{
        const normalized=normalizeOfficialCsv(source,raw);
        // Validate ALL chunks before exposing registration; never partially import a malformed file.
        const checked=await Promise.all(normalized.parts.map(part=>previewCsv(source,part)));
        if(checked.some(x=>x.errors.length>0||x.rows.length===0))
          throw Error("INVALID_ROWS");
        if(epoch!==selectionEpoch.current)return;
        setCsvText(normalized.parts[0]);setCanonicalParts(normalized.parts);
        setCanonicalTotal(normalized.total);setMissingFitSteps(normalized.missingSteps);
        setCsvPreview(checked[0]);
      }
    } catch {
      if (epoch === selectionEpoch.current)
        setImportStatus("元ファイルの列・日時・数値・重複に問題があります。データはまだ登録していません。");
    }
  }

  async function submit(keepExisting = false) {
    if (!csvPreview || csvPreview.errors.length || !csvPreview.rows.length || busy) return;
    if (keepExisting && (!review || review.conflicts.length === 0)) return;
    const epoch = selectionEpoch.current;
    setBusy(true);
    setImportStatus("");
    try {
      if(csvSource!=="lifestyle"){
        if(!canonicalParts.length||keepExisting)throw Error("SOURCE_NOT_READY");
        let inserted=0,skipped=0;
        for(let n=0;n<canonicalParts.length;n++){
          // Each chunk is an independently hash-confirmed, auditable, idempotent job.
          const part=canonicalParts[n],p=await previewCsv(csvSource,part);
          const response=await fetch("/api/import/confirm",{
            method:"POST",credentials:"same-origin",cache:"no-store",
            headers:{"Content-Type":"application/json","X-Life-Log-Intent":"manual-write-v1"},
            body:JSON.stringify({source:csvSource,csv:part,hash:p.hash,confirmed:true})
          });
          const data=await response.json() as ImportResult;
          if(!response.ok)throw Error("HTTP "+response.status+" / "+(data.error??"UNKNOWN")+
            "（"+(n+1)+"/"+canonicalParts.length+"）");
          inserted+=data.inserted??0;skipped+=data.skipped??0;
          if(epoch===selectionEpoch.current)
            setImportStatus("登録中 "+(n+1)+"/"+canonicalParts.length+" 分割");
        }
        if(epoch===selectionEpoch.current){
          setImportStatus("登録完了：追加 "+inserted+"件・スキップ "+skipped+
            "件。元データ "+canonicalTotal+"件、Fit歩数欠測 "+missingFitSteps+"日。");
          setRefreshEpoch(n=>n+1);
        }
        return;
      }
      const res = await fetch("/api/import/confirm", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Life-Log-Intent":"manual-write-v1" },
        body: JSON.stringify({
          source: csvSource, csv: csvText, hash: csvPreview.hash, confirmed: true,
          ...(keepExisting && review
            ? { resolution: { mode: "keep_existing", token: review.token } }
            : {}),
        }),
      });
      const data = await res.json() as ImportResult;
      if (epoch !== selectionEpoch.current) return;
      if (res.status === 409 &&
          (data.error === "LIFESTYLE_CONFLICT" || data.error === "REVIEW_STALE") &&
          data.reviewToken && data.conflicts) {
        setReview({ token: data.reviewToken, conflicts: data.conflicts });
        setImportStatus(data.error === "REVIEW_STALE"
          ? "既存記録が変更されています。競合内容を再確認してください。登録は行われていません。"
          : "既存の生活記録と矛盾があります。登録は行われていません。");
      } else if (res.ok) {
        setReview(null);
        setImportStatus(data.status === "already_imported"
          ? data.auditStatus === "legacy_unavailable"
            ? "このCSVは旧形式で取込済みです。二重登録はしていません。過去の行単位監査は存在せず、推測による補完もしていません。"
            : "このCSVはすでに取込済みです。二重登録はしていません。"
          : "登録完了：追加 " + (data.inserted ?? 0) + "件 / 同値スキップ "
            + (data.skipped ?? 0) + "件 / 競合を維持 "
            + (data.conflicted ?? 0) + "件。行単位の監査証跡を保存しました。");
      } else {
        setReview(null);
        setImportStatus("登録を中止しました：" + (data.error ?? res.status));
      }
    } catch {
      if (epoch === selectionEpoch.current) {
        setReview(null);
        setImportStatus("取込中断。完了済みの分割は保持されています。同じ原本で再試行すると重複を避けて継続できます。");
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetch("/api/summary", {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!res.ok) {
          if (!controller.signal.aborted) setState({
            kind: "blocked", message: "認証またはデータ取得ができません。公開環境は未設定です。",
          });
          return;
        }
        const summary: Summary = await res.json();
        if (!controller.signal.aborted) setState({ kind: "ok", summary });
      } catch {
        if (!controller.signal.aborted) setState({
          kind: "blocked", message: "APIに接続できません。開発中の画面です。",
        });
      }
    }
    void load();
    return () => controller.abort();
  }, [refreshEpoch]);

  return (
    <main className="container">
      <div className="eyebrow">PERSONAL LIFE LOG</div>
      <h1>今日と次の一手</h1>
      <p className="intro">体重と日々の行動を、推測ではなく記録に基づいて振り返る。</p>
      <section className="panel" aria-labelledby="weight-title">
        <h2 id="weight-title">直近の体重</h2>
        {state.kind === "loading" && <p role="status">認証済みのデータを確認中…</p>}
        {state.kind === "blocked" && <p role="alert">{state.message}</p>}
        {state.kind === "ok" && <p className="metric">
          {state.summary.latestWeightKg === null
            ? "記録なし" : state.summary.latestWeightKg.toFixed(1) + " kg"}
        </p>}
        {state.kind === "ok" && <p className="hint">
          {state.summary.measuredAt ?? "測定日時は不明"} · 記録のない日は0kgとして扱いません
        </p>}
      </section>
      <PasskeySetup />
      <ManualEntry onSaved={() => setRefreshEpoch(n => n + 1)} />
      <WeightTrendPanel key={refreshEpoch} />
      <MvpFeatures onSaved={() => setRefreshEpoch(n => n + 1)} />
      <section className="panel" aria-labelledby="csv-title">
        <h2 id="csv-title">CSV取込（本人専用）</h2>
        <p>歩数はGoogle Fit、体重はECLEARを正とします。各元ファイルを端末で選択すると、アプリ内で形式検証して分割登録します。原本はGitHubへ送信しません。</p>
        <label>種類{" "}
          <select value={csvSource} disabled={busy} onChange={e => {
            ++selectionEpoch.current;
            setCsvSource(e.target.value as CsvSource);
            setCsvText("");setCanonicalParts([]);setCanonicalTotal(0);setMissingFitSteps(0); setCsvPreview(null); setReview(null); setImportStatus("");
          }}>
            <option value="lifestyle">生活記録</option>
            <option value="eclear">ECLEAR（体重の正本）</option>
            <option value="fit">Google Fit（歩数の正本）</option>
          </select>
        </label>
        <p><input type="file" accept=".csv,text/csv" disabled={busy} onChange={e => {
          const file = e.target.files?.[0];
          if (file) void selectCsv(file, csvSource);
        }} /></p>
        {csvPreview && <div aria-live="polite">
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
        {review && review.conflicts.length > 0 && <div role="group"
          aria-label="生活記録の競合解決">
          <h3>既存の記録と競合しています</h3>
          <p>既存データは変更しません。以下の競合行を除いて、
            CSV内の残りの行だけ登録できます。</p>
          <ul>{review.conflicts.map(c =>
            <li key={c.day}>{c.day}：{c.fields.join(" / ")}</li>)}</ul>
          <button type="button" disabled={busy} onClick={() => void submit(true)}>
            競合行は既存を優先し、その他を登録する
          </button>
          <button type="button" disabled={busy} onClick={() => {
            setReview(null);
            setImportStatus("取込を中止しました。書き込みは行っていません。");
          }}>取込を中止する</button>
        </div>}
        {importStatus && <p role="alert">{importStatus}</p>}
      </section>
      <section className="panel" aria-labelledby="history-title">
        <h2 id="history-title">CSV取込監査履歴（本人専用）</h2>
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
      <footer>本人限定・パスキー認証が必要 · 未認証アクセスは拒否</footer>
    </main>
  );
}
