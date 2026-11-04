import { useEffect, useState, type ChangeEvent } from "react";
import { previewCsv, csvSha256, CSV_MAX_BYTES, type ImportPreview } from "../shared/csv-import";
import type { Summary } from "../shared/legacy";

type LoadState = { kind: "loading" } | { kind: "blocked"; message: string } | { kind: "ok"; summary: Summary };

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [fileDraft, setFileDraft] = useState<{csv: string; hash: string; preview: ImportPreview} | null>(null);
  const [importState, setImportState] = useState("合成CSVを選択するとサーバーへの書き込みなしで検査します。");

  async function selectCsv(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    setFileDraft(null);
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    if (file.size > CSV_MAX_BYTES) { setImportState("ファイルが大きすぎます（30KB上限）。"); return; }
    try {
      const csv = await file.text();
      const preview = previewCsv(csv);
      const hash = await csvSha256(csv);
      setFileDraft({ csv, hash, preview });
      setImportState(preview.errors.length ? "異常行を修正してください。未登録です。" : "プレビューのみ完了。まだ登録していません。");
    } catch {
      setImportState("CSV形式を読み取れません。未登録です。");
    }
  }

  async function confirmCsv(): Promise<void> {
    if (!fileDraft || fileDraft.preview.errors.length) return;
    setImportState("ローカル専用APIへ登録要求中…");
    try {
      const response = await fetch("/api/import/confirm", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "same-origin", cache: "no-store",
        body: JSON.stringify({ csv: fileDraft.csv, hash: fileDraft.hash, kind: fileDraft.preview.kind, confirm: true }),
      });
      const result: {inserted?: number; skipped?: number; error?: string} = await response.json();
      if (!response.ok) {
        setImportState("登録不可: " + (result.error ?? "APIエラー") + "。原則、記録は変更されていません。");
        return;
      }
      setImportState("ローカルD1登録完了。新規 " + result.inserted + " 件、既存スキップ " + result.skipped + " 件。");
      setFileDraft(null);
    } catch {
      setImportState("通信エラー。再送前にローカルD1の登録状況を確認してください。");
    }
  }


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
      <section className="panel" aria-labelledby="import-title">
        <h2 id="import-title">合成CSVの取込プレビュー（ローカル限定）</h2>
        <p className="hint">生活記録・ECLEARのUTF-8 CSVのみ。最大30行・30KB。実個人データは使用しないでください。</p>
        <label className="file-label" htmlFor="csv-file">CSVファイルを選択</label>
        <input id="csv-file" aria-label="合成CSVを選択" type="file" accept=".csv,text/csv" onChange={e => void selectCsv(e)} />
        {fileDraft && (
          <div>
            <p>判定形式：{fileDraft.preview.kind === "lifestyle" ? "生活記録" : "ECLEAR"}、行数：{fileDraft.preview.totalRows}</p>
            <p className="hint">列対応：{fileDraft.preview.columns.join(" / ")}</p>
            <p>先頭3行プレビュー：</p>
            <pre className="preview-json">{JSON.stringify(fileDraft.preview.rows.slice(0, 3), null, 2)}</pre>
            <p>異常行数：{fileDraft.preview.errors.length}</p>
            {fileDraft.preview.errors.map(error => <p role="alert" key={error.line}>行{error.line}: {error.code}</p>)}
            <button className="confirm" type="button" disabled={fileDraft.preview.errors.length !== 0}
              onClick={() => void confirmCsv()}>確認したCSVをローカルD1へ登録</button>
          </div>
        )}
        <p role="status">{importState}</p>
      </section>
      <footer>本人限定・認証未設定では配信とAPIを拒否 · 実データ未登録</footer>
    </main>
  );
}
