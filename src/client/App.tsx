import { useEffect, useState } from "react";
import type { Summary } from "../shared/legacy";
import type { CsvSource, Preview } from "../shared/csv-import";
import { previewCsv } from "../shared/csv-import";

type LoadState = { kind: "loading" } | { kind: "blocked"; message: string } | { kind: "ok"; summary: Summary };

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [csvSource,setCsvSource]=useState<CsvSource>("lifestyle");
  const [csvText,setCsvText]=useState("");
  const [csvPreview,setCsvPreview]=useState<Preview|null>(null);
  const [importStatus,setImportStatus]=useState("");
  const [busy,setBusy]=useState(false);
  async function previewFile(file:File){setCsvPreview(null);setImportStatus("");if(file.size>65536){setImportStatus("ファイルが大きすぎます");return;}const text=await file.text();setCsvText(text);try{setCsvPreview(await previewCsv(csvSource,text));}catch{setImportStatus("CSV形式または列名が不正です");}}
  async function confirmImport(){if(!csvPreview||csvPreview.errors.length||busy)return;setBusy(true);try{const res=await fetch("/api/import/confirm",{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({source:csvSource,csv:csvText,hash:csvPreview.hash,confirmed:true})});const result=await res.json() as {status?:string;error?:string;inserted?:number;skipped?:number};setImportStatus(res.ok?`取込結果: ${result.status} / 追加 ${result.inserted} 件 / 重複 ${result.skipped} 件`:`取込拒否: ${result.error??res.status}`);}catch{setImportStatus("通信に失敗しました。再確認してください");}finally{setBusy(false);}}

  useEffect(() => {
    const controller = new AbortController();
    async function load(): Promise<void> {
      try {
        const res = await fetch("/api/summary", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!res.ok) {
          setState({ kind: "blocked", message: "認証またはデータ取得ができません。公開環境は未設定です。" });
          return;
        }
        const result: Summary = await res.json();
        if (!controller.signal.aborted) setState({ kind: "ok", summary: result });
      } catch {
        if (!controller.signal.aborted) setState({ kind: "blocked", message: "APIに接続できません。開発中の画面です。" });
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  return (
    <main className="container">
      <div className="eyebrow">PERSONAL LIFE LOG · DEVELOPMENT</div>
      <h1>今日と次の一手</h1>
      <p className="intro">体重と日々の行動を、推測ではなく記録に基づいて振り返る。</p>
      <section aria-labelledby="weight-title" className="panel">
        <h2 id="weight-title">直近の体重</h2>
        {state.kind === "loading" && <p role="status">認証済みのデータを確認中…</p>}
        {state.kind === "blocked" && <p role="alert">{state.message}</p>}
        {state.kind === "ok" && <p className="metric">{state.summary.latestWeightKg === null ? "記録なし" : `${state.summary.latestWeightKg.toFixed(1)} kg`}</p>}
        {state.kind === "ok" && <p className="hint">{state.summary.measuredAt ?? "測定日時は不明"} · 記録のない日は0kgとして扱いません</p>}
      </section>
      <section className="panel" aria-labelledby="next-title">
        <h2 id="next-title">次の一手</h2>
        <p>行動実験・飲酒+1・CSV取込は後続Issueで実装予定。現在は閲覧専用です。</p>
      </section>
      <section className="panel" aria-labelledby="csv-title"><h2 id="csv-title">合成CSV取込（開発用）</h2><p>実ECLEARの列仕様は未確定。ここでは合成サンプル形式のみ対応します。</p><label>種類 <select value={csvSource} onChange={e=>{setCsvSource(e.target.value as CsvSource);setCsvPreview(null);setCsvText("");setImportStatus("");}}><option value="lifestyle">生活記録</option><option value="eclear">ECLEAR</option></select></label><p><input type="file" accept=".csv,text/csv" onChange={e=>{const f=e.target.files?.[0];if(f)void previewFile(f);}} /></p>{csvPreview&&<div role="status"><p>対象 {csvPreview.total} 行 / 有効 {csvPreview.rows.length} 行 / 異常 {csvPreview.errors.length} 行</p>{csvPreview.errors.map(e=><p key={e.line}>行 {e.line}: {e.code}</p>)}<button type="button" disabled={busy||csvPreview.errors.length>0||csvPreview.rows.length===0} onClick={()=>void confirmImport()}>内容を確認して登録する</button></div>}{importStatus&&<p role="alert">{importStatus}</p>}</section>
      <footer>本人限定・認証未設定では配信とAPIを拒否 · 実データ未登録</footer>
    </main>
  );
}
