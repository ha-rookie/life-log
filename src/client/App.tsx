import { useEffect, useRef, useState } from "react";
import type { Summary } from "../shared/legacy";
import { previewCsv, type CsvSource, type Preview } from "../shared/csv-import";

type LoadState =
  | { kind: "loading" }
  | { kind: "blocked"; message: string }
  | { kind: "ok"; summary: Summary };
type Conflict = { day: string; fields: string[] };
type Review = { token: string; conflicts: Conflict[] };
type ImportResult = {
  status?: string; error?: string; inserted?: number; skipped?: number;
  conflicted?: number; reviewToken?: string | null; conflicts?: Conflict[];
};

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [csvSource, setCsvSource] = useState<CsvSource>("lifestyle");
  const [csvText, setCsvText] = useState("");
  const [csvPreview, setCsvPreview] = useState<Preview | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [importStatus, setImportStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const selectionEpoch = useRef(0);

  async function selectCsv(file: File, source: CsvSource) {
    const epoch = ++selectionEpoch.current;
    setCsvText(""); setCsvPreview(null); setReview(null); setImportStatus("");
    if (file.size > 65536) {
      setImportStatus("CSVのサイズは64KiB以下にしてください。");
      return;
    }
    try {
      const text = await file.text();
      const parsed = await previewCsv(source, text);
      if (epoch !== selectionEpoch.current) return;
      setCsvText(text);
      setCsvPreview(parsed);
    } catch {
      if (epoch === selectionEpoch.current) setImportStatus("CSVの形式または列名が不正です。");
    }
  }

  async function submit(keepExisting = false) {
    if (!csvPreview || csvPreview.errors.length || !csvPreview.rows.length || busy) return;
    if (keepExisting && (!review || review.conflicts.length === 0)) return;
    const epoch = selectionEpoch.current;
    setBusy(true);
    setImportStatus("");
    try {
      const res = await fetch("/api/import/confirm", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
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
          ? "このCSVはすでに取込済みです。二重登録はしていません。"
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
        setImportStatus("通信に失敗しました。取込状況を確認してから再試行してください。");
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
  }, []);

  return (
    <main className="container">
      <div className="eyebrow">PERSONAL LIFE LOG · DEVELOPMENT</div>
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
      <section className="panel" aria-labelledby="next-title">
        <h2 id="next-title">次の一手</h2>
        <p>行動実験・飲酒+1は後続Issueで実装予定です。</p>
      </section>
      <section className="panel" aria-labelledby="csv-title">
        <h2 id="csv-title">合成CSV取込（開発用）</h2>
        <p>実ECLEARの列仕様は未確認。合成サンプルだけに対応します。</p>
        <label>種類{" "}
          <select value={csvSource} disabled={busy} onChange={e => {
            ++selectionEpoch.current;
            setCsvSource(e.target.value as CsvSource);
            setCsvText(""); setCsvPreview(null); setReview(null); setImportStatus("");
          }}>
            <option value="lifestyle">生活記録</option>
            <option value="eclear">ECLEAR</option>
          </select>
        </label>
        <p><input type="file" accept=".csv,text/csv" disabled={busy} onChange={e => {
          const file = e.target.files?.[0];
          if (file) void selectCsv(file, csvSource);
        }} /></p>
        {csvPreview && <div aria-live="polite">
          <p>対象 {csvPreview.total} 行 / 有効 {csvPreview.rows.length} 行 /
            異常 {csvPreview.errors.length} 行</p>
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
      <footer>本人限定・認証未設定では配信とAPIを拒否 · 実データ未登録</footer>
    </main>
  );
}
