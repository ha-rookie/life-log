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
  auditStatus?: "legacy_unavailable" | "complete";
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
      <ImportHistory />
      <footer>本人限定・認証未設定では配信とAPIを拒否 · 実データ未登録</footer>
    </main>
  );
}


type AuditState = "recorded" | "legacy_unavailable" | "incomplete";
type HistoryJob = {
  id: string; source: "lifestyle" | "eclear";
  status: "confirmed" | "partial";
  startedAt: string; completedAt: string | null;
  auditState: AuditState; auditCount: number | null;
  counts: { inserted: number; skipped: number; conflicted: number } | null;
};
type HistoryPage = { jobs: HistoryJob[]; page: number; limit: number; hasMore: boolean };
type HistoryAuditRow = {
  line: number; result: "inserted" | "skipped" | "conflict" | "invalid";
  errorCode: string | null;
  currentLifestyle: {
    drinkingPresence: number | null; drinkCups: number | null; steps: number | null;
  } | null;
};
type RowPage = { job: HistoryJob; rows: HistoryAuditRow[]; page: number; limit: number; hasMore: boolean };

const showAuditState = (job: HistoryJob) => {
  if (job.auditState === "legacy_unavailable") {
    return "旧形式：行監査なし（過去の結果は復元・推測しません）";
  }
  if (job.auditState === "incomplete") return "監査欠落または不整合：要確認";
  return "監査 " + (job.auditCount ?? "不明") + " 件（元CSV行数との完全照合は未実施）";
};
const showResult = (result: HistoryAuditRow["result"]) => ({
  inserted: "登録", skipped: "重複スキップ",
  conflict: "競合：既存値を維持", invalid: "不正",
})[result];
const showPresence = (value: number | null) =>
  value === null ? "不明" : value === 0 ? "なし（0）" : "あり（1）";
const showAmount = (value: number | null) => value === null ? "不明" : String(value);

function ImportHistory() {
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [jobs, setJobs] = useState<HistoryJob[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");
  const [chosen, setChosen] = useState<HistoryJob | null>(null);
  const [rowPage, setRowPage] = useState(1);
  const [rows, setRows] = useState<HistoryAuditRow[]>([]);
  const [rowsMore, setRowsMore] = useState(false);
  const [rowState, setRowState] = useState<"loading" | "loaded" | "failed">("loaded");

  useEffect(() => {
    const abort = new AbortController();
    setLoadState("loading");
    setJobs([]);
    void (async () => {
      try {
        const response = await fetch("/api/import/history?page=" + page + "&limit=10", {
          credentials: "same-origin", cache: "no-store", signal: abort.signal,
        });
        if (!response.ok) throw Error("HISTORY_REQUEST");
        const body = await response.json() as HistoryPage;
        if (!abort.signal.aborted) {
          setJobs(body.jobs);
          setHasMore(body.hasMore);
          setLoadState("loaded");
        }
      } catch {
        if (!abort.signal.aborted) setLoadState("failed");
      }
    })();
    return () => abort.abort();
  }, [page, version]);

  useEffect(() => {
    if (!chosen) { setRows([]); setRowsMore(false); setRowState("loaded"); return; }
    const abort = new AbortController();
    setRowState("loading");
    setRows([]);
    void (async () => {
      try {
        const url = "/api/import/history/rows?job=" + encodeURIComponent(chosen.id)
          + "&page=" + rowPage + "&limit=10";
        const response = await fetch(url, {
          credentials: "same-origin", cache: "no-store", signal: abort.signal,
        });
        if (!response.ok) throw Error("AUDIT_REQUEST");
        const body = await response.json() as RowPage;
        if (!abort.signal.aborted) {
          setRows(body.rows);
          setRowsMore(body.hasMore);
          setRowState("loaded");
        }
      } catch {
        if (!abort.signal.aborted) setRowState("failed");
      }
    })();
    return () => abort.abort();
  }, [chosen, rowPage]);

  const changePage = (next: number) => {
    setChosen(null);
    setPage(next);
    setRowPage(1);
  };
  const choose = (job: HistoryJob) => {
    setChosen(job);
    setRows([]);
    setRowPage(1);
  };

  return (
    <section className="panel" aria-labelledby="history-title">
      <div className="history-top">
        <h2 id="history-title">CSV取込監査履歴（本人専用）</h2>
        <button type="button" onClick={() => {
          setChosen(null); setPage(1); setVersion(v => v + 1);
        }}>再読み込み</button>
      </div>
      <p className="hint">監査履歴は読み取り専用。個人情報・CSV本文は表示しません。
        保存値は取得できる場合の現在値であり、当時のCSVの複製ではありません。</p>
      {loadState === "loading" && <p role="status">履歴を読み込み中…</p>}
      {loadState === "failed" && <p role="alert">履歴を取得できません。認証・通信状態を確認してください。</p>}
      {loadState === "loaded" && jobs.length === 0 && <p>このページに取込履歴はありません。</p>}
      {loadState === "loaded" && jobs.length > 0 && <ul className="history-list">
        {jobs.map(job => <li className="history-item" key={job.id}>
          <p><strong>{job.source === "lifestyle" ? "生活記録" : "ECLEAR"}</strong>
            {" · "}{job.status === "partial" ? "競合を残して確定" : "確定"}
            {" · "}{job.completedAt ?? "確定日時不明"}</p>
          <p className="hint">{showAuditState(job)}</p>
          {job.counts !== null && <p className="hint">
            追加 {job.counts.inserted} / スキップ {job.counts.skipped}
            {" / "}競合 {job.counts.conflicted}
          </p>}
          <button type="button" aria-pressed={chosen?.id === job.id} onClick={() => choose(job)}>
            行監査を表示
          </button>
        </li>)}
      </ul>}
      <div className="history-pager">
        <button type="button" disabled={loadState !== "loaded" || page <= 1}
          onClick={() => changePage(page - 1)}>前の履歴</button>
        <span>ページ {page}</span>
        <button type="button" disabled={loadState !== "loaded" || !hasMore}
          onClick={() => changePage(page + 1)}>次の履歴</button>
      </div>
      {chosen && <div className="history-detail" aria-live="polite">
        <div className="history-top">
          <h3>{chosen.source === "lifestyle" ? "生活記録" : "ECLEAR"} の行監査</h3>
          <button type="button" onClick={() => setChosen(null)}>閉じる</button>
        </div>
        <p className="hint">{showAuditState(chosen)}</p>
        {rowState === "loading" && <p role="status">行監査を読み込み中…</p>}
        {rowState === "failed" && <p role="alert">行監査を取得できません。</p>}
        {rowState === "loaded" && rows.length === 0 && <p>表示できる行監査記録はありません。</p>}
        {rowState === "loaded" && rows.length > 0 && <ul className="history-list">
          {rows.map(row => <li key={row.line} className="history-item">
            <strong>元CSV {row.line}行：{showResult(row.result)}</strong>
            {row.errorCode === "LIFESTYLE_CONFLICT_KEPT" && <p className="hint">
              既存の値を優先した記録です。</p>}
            {row.currentLifestyle !== null && <p className="hint">
              現在の保存値：飲酒 {showPresence(row.currentLifestyle.drinkingPresence)}
              {" / "}杯数 {showAmount(row.currentLifestyle.drinkCups)}
              {" / "}歩数 {showAmount(row.currentLifestyle.steps)}
            </p>}
            {row.result !== "inserted" && <p className="hint">
              この行の取込時の値は保存されていません。</p>}
          </li>)}
        </ul>}
        <div className="history-pager">
          <button type="button" disabled={rowState !== "loaded" || rowPage <= 1}
            onClick={() => setRowPage(p => p - 1)}>前の行</button>
          <span>行ページ {rowPage}</span>
          <button type="button" disabled={rowState !== "loaded" || !rowsMore}
            onClick={() => setRowPage(p => p + 1)}>次の行</button>
        </div>
      </div>}
    </section>
  );
}
