import { useEffect, useRef, useState } from "react";
import type { WeightTrend, TrendDay } from "../shared/weight-trend";
import { dateRange, defaultRange } from "../shared/weight-trend";

type TrendState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; trend: WeightTrend };

const fmt = (n: number) => n.toFixed(1);
const fmtDate = (day: string) => day.slice(5).replace("-", "/");
function lines(days: TrendDay[], pick: (day: TrendDay) => number | null, y: (kg: number) => number): string[] {
  const paths: string[] = [];
  let current = "";
  days.forEach((day, i) => {
    const value = pick(day);
    if (value === null) {
      if (current) paths.push(current);
      current = "";
    } else {
      const point = `${(36 + i * 648 / Math.max(days.length - 1, 1)).toFixed(2)},${y(value).toFixed(2)}`;
      current += (current ? " L" : "M") + point;
    }
  });
  if (current) paths.push(current);
  return paths;
}
export function TrendPlot({ days, goalLow, goalHigh }: {
  days: TrendDay[]; goalLow: number; goalHigh: number;
}) {
  const values = days.flatMap(d => [d.weightKg, d.average7Kg]).filter((n): n is number => n !== null);
  if (values.length === 0) return <p className="hint">グラフに表示できる実測値がありません。</p>;
  const lo = Math.floor(Math.min(...values, goalLow) - 1);
  const hi = Math.ceil(Math.max(...values, goalHigh) + 1);
  const y = (n: number) => 192 - (n - lo) * 156 / Math.max(hi - lo, 1);
  return <div className="trend-scroll" role="region" tabIndex={0}
    aria-label="体重推移グラフ。横方向にスクロールできます。">
    <svg viewBox="0 0 720 230" role="img"
      aria-label="体重推移。青い実測線は欠測日で途切れます。緑の7日平均は観測日数4日以上の場合に表示され、欠測日にも値が付く場合があります。">
      <rect x="36" y={y(goalHigh)} width="648" height={Math.max(1, y(goalLow) - y(goalHigh))}
        fill="#e5f2ec" />
      {[lo, (lo + hi) / 2, hi].map(n => <g key={n}>
        <line x1="36" x2="684" y1={y(n)} y2={y(n)} stroke="#d9e4e6" strokeDasharray="3 4" />
        <text x="2" y={y(n) + 4} fontSize="11" fill="#53636a">{n.toFixed(0)}</text>
      </g>)}
      {lines(days, d => d.weightKg, y).map((path, i) =>
        <path key={"w" + i} d={path} fill="none" stroke="#2166a5" strokeWidth="2.5" />)}
      {days.map((d, i) => d.weightKg === null ? null :
        <circle key={d.day} cx={36 + i * 648 / Math.max(days.length - 1, 1)}
          cy={y(d.weightKg)} r="2.8" fill="#2166a5"><title>{d.day} 実測 {fmt(d.weightKg)}kg</title></circle>)}
      {lines(days, d => d.average7Kg, y).map((path, i) =>
        <path key={"a" + i} d={path} fill="none" stroke="#23845c" strokeWidth="2.5" />)}
      {days.map((d, i) => d.average7Kg === null ? null :
        <circle key={"avg-" + d.day} className="average-point"
          cx={36 + i * 648 / Math.max(days.length - 1, 1)}
          cy={y(d.average7Kg)} r="2.7" fill="#23845c">
          <title>{d.day} 7日平均 {d.average7Kg.toFixed(2)}kg（実測 {d.measuredDaysInWindow}/7日）</title>
        </circle>)}
      <text x="36" y="217" fontSize="12" fill="#53636a">{fmtDate(days[0].day)}</text>
      <text x="684" y="217" textAnchor="end" fontSize="12" fill="#53636a">{fmtDate(days[days.length - 1].day)}</text>
    </svg>
    <p className="hint">青：日次実測（欠測で途切れます）　緑：7日平均（4日以上。欠測日にも表示する場合があります）　淡緑：目標範囲</p>
    <p className="hint">画面が狭い場合、グラフは左右にスクロールできます。</p>
  </div>;
}
export function WeightTrendPanel() {
  const initial = defaultRange(Date.now());
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [range, setRange] = useState(initial);
  const [goalLow, setGoalLow] = useState("75");
  const [goalHigh, setGoalHigh] = useState("76");
  const [state, setState] = useState<TrendState>({ kind: "loading" });
  const seq = useRef(0);
  const validRange = dateRange(from, to) !== null;
  const low = Number(goalLow), high = Number(goalHigh);
  const validGoal = goalLow.trim() !== "" && goalHigh.trim() !== "" &&
    Number.isFinite(low) && Number.isFinite(high) && low > 0 && high < 500 && low <= high;
  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++seq.current;
    async function load() {
      setState({ kind: "loading" });
      try {
        const params = new URLSearchParams(range);
        const res = await fetch("/api/weight/trend?" + params.toString(), {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!res.ok) throw new Error("status");
        const data = await res.json() as WeightTrend;
        if (!controller.signal.aborted && epoch === seq.current) setState({ kind: "ok", trend: data });
      } catch {
        if (!controller.signal.aborted && epoch === seq.current) {
          setState({ kind: "error", message: "体重推移を取得できません。認証と接続を確認してください。" });
        }
      }
    }
    void load();
    return () => { controller.abort(); ++seq.current; };
  }, [range]);
  const trend = state.kind === "ok" ? state.trend : null;
  const latest = trend ? [...trend.days].reverse().find(d => d.weightKg !== null) : undefined;
  const difference = latest?.weightKg !== null && latest?.weightKg !== undefined && validGoal
    ? latest.weightKg < low ? `目標下限より${fmt(low - latest.weightKg)}kg低い`
      : latest.weightKg > high ? `目標上限まで${fmt(latest.weightKg - high)}kg`
      : "目標範囲内"
    : null;
  return <section className="panel" aria-labelledby="trend-title">
    <h2 id="trend-title">体重推移・7日平均</h2>
    <p className="hint">日本時間（JST）の1日ごとに最後の正常な実測を採用します。欠測は0kgに置き換えません。</p>
    <form className="trend-controls" onSubmit={e => {
      e.preventDefault();
      if (validRange) setRange({ from, to });
    }}>
      <label>開始日<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>終了日<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      <button type="submit" disabled={!validRange}>期間を表示</button>
      {!validRange && <p role="alert">日付を確認してください（最大366日）。</p>}
    </form>
    <div className="trend-controls">
      <label>目標下限（kg）<input type="number" min="1" max="499" step="0.1"
        value={goalLow} onChange={e => setGoalLow(e.target.value)} /></label>
      <label>目標上限（kg）<input type="number" min="1" max="499" step="0.1"
        value={goalHigh} onChange={e => setGoalHigh(e.target.value)} /></label>
    </div>
    {!validGoal && <p role="alert">目標は0kg超、500kg未満、下限が上限以下で指定してください。</p>}
    <p className="hint">目標日は2026/12/22（暫定）。目標の編集はこの画面内のみで、保存されません。</p>
    {state.kind === "loading" && <p role="status">体重推移を読み込み中…</p>}
    {state.kind === "error" && <p role="alert">{state.message}</p>}
    {trend && <>
      <p aria-live="polite">実測日 {trend.measuredDays} / {trend.days.length}日 · 欠測 {trend.missingDays}日
        · 異常/無効除外 {trend.excludedAnomaly}件 · 非実測除外 {trend.excludedNonMeasured}件</p>
      {difference && <p className="trend-difference">期間内の最新実測（{latest!.day}） {fmt(latest!.weightKg!)}kg · {difference}</p>}
      {validGoal && <TrendPlot days={trend.days} goalLow={low} goalHigh={high} />}
      {!validGoal && <p>目標値を修正するとグラフを表示します。</p>}
      <div className="trend-table-scroll" role="region" tabIndex={0}
        aria-label="日別体重一覧。左右にスクロールできます。">
        <table className="trend-table">
          <caption>日次体重と7日平均（古い日付から順に表示）</caption>
          <thead><tr><th scope="col">日付</th><th scope="col">実測kg</th>
            <th scope="col">7日平均kg</th><th scope="col">観測日数</th><th scope="col">出典・測定時刻</th></tr></thead>
          <tbody>{trend.days.map(d => <tr key={d.day}>
            <th scope="row">{d.day}</th><td>{d.weightKg === null ? "欠測" : fmt(d.weightKg)}</td>
            <td>{d.average7Kg === null ? "データ不足" : fmt(d.average7Kg)}</td>
            <td>{d.measuredDaysInWindow}/7</td>
            <td>{d.measuredAt ? `実測 · ${d.measuredAt}` : "記録なし"}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}
  </section>;
}
