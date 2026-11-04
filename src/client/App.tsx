import { useEffect, useState } from "react";
import type { Summary } from "../shared/legacy";

type LoadState = { kind: "loading" } | { kind: "blocked"; message: string } | { kind: "ok"; summary: Summary };

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

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
      <footer>本人限定・認証未設定では配信とAPIを拒否 · 実データ未登録</footer>
    </main>
  );
}
