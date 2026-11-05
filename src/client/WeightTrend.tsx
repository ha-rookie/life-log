import { useEffect, useState } from "react";
import {
  dayNumber, dayText, todayTokyo,
  type TrendDay, type WeightTrend,
} from "../shared/weight-trend";

type TrendState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; trend: WeightTrend };

const W = 620, H = 250, LEFT = 47, RIGHT = 15, TOP = 16, BOTTOM = 38;
const numeric = (value: number) => value.toFixed(1);
const kg = (value: number | null) => value === null ? "欠測" : numeric(value) + " kg";

function chartSegments(
  days: TrendDay[], property: "weightKg" | "average7Kg",
  posX: (index: number) => number, posY: (value: number) => number,
): string[] {
  const segments: string[] = [];
  let consecutive: string[] = [];
  const flush = () => {
    if (consecutive.length) segments.push(consecutive.join(" "));
    consecutive = [];
  };
  days.forEach((day, i) => {
    const value = day[property];
    if (value === null) { flush(); return; }
    consecutive.push(posX(i).toFixed(1) + "," + posY(value).toFixed(1));
  });
  flush();
  return segments;
}

function WeightChart({ trend, goalLow, goalHigh }: {
  trend: WeightTrend; goalLow: number; goalHigh: number;
}) {
  const values = trend.days.flatMap(d => [d.weightKg, d.average7Kg])
    .filter((v): v is number => v !== null);
  if (values.length === 0) return <p role="status">この期間に表示できる実測体重はありません。期間を変更してください。</p>;
  const yMin = Math.floor(Math.min(...values, goalLow, goalHigh) - 1);
  const yMax = Math.ceil(Math.max(...values, goalLow, goalHigh) + 1);
  const span = Math.max(1, yMax - yMin);
  const x = (i: number) => LEFT + i * (W - LEFT - RIGHT) / Math.max(1, trend.days.length - 1);
  const y = (v: number) => TOP + (yMax - v) / span * (H - TOP - BOTTOM);
  const goalTop = Math.max(TOP, y(goalHigh));
  const goalHeight = Math.max(1, y(goalLow) - goalTop);
  const rawSegments = chartSegments(trend.days, "weightKg", x, y);
  const meanSegments = chartSegments(trend.days, "average7Kg", x, y);
  const first = trend.days[0].day;
  const last = trend.days[trend.days.length - 1].day;
  return <div className="chart-wrap">
    <svg role="img" aria-label={"体重推移 " + first + "から" + last + "。欠測日は線を接続せず、点線は7日平均。目標" + goalLow + "〜" + goalHigh + "kg。"}
      viewBox={"0 0 " + W + " " + H} className="weight-chart">
      <rect x={LEFT} y={goalTop} width={W - LEFT - RIGHT} height={goalHeight}
        className="goal-band" />
      {[0, 0.5, 1].map(q => {
        const value = yMin + span * q;
        return <g key={q}>
          <line x1={LEFT} x2={W - RIGHT} y1={y(value)} y2={y(value)} className="chart-grid"/>
          <text x={LEFT - 6} y={y(value) + 4} textAnchor="end" className="chart-label">{numeric(value)}</text>
        </g>;
      })}
      {rawSegments.map((points, i) =>
        <polyline key={"raw-" + i} points={points} className="chart-raw" />)}
      {meanSegments.map((points, i) =>
        <polyline key={"avg-" + i} points={points} className="chart-mean" />)}
      {trend.days.map((d, i) => d.weightKg === null ? null
        : <circle key={d.day} cx={x(i)} cy={y(d.weightKg)} r="3" className="chart-point">
          <title>{d.day + " 実測 " + kg(d.weightKg) + "・" + d.source + "・7日平均 " + kg(d.average7Kg) + "・実測 " + d.observed7Days + "/7日"}</title>
        </circle>)}
      <text x={LEFT} y={H - 10} className="chart-label">{first}</text>
      <text x={W - RIGHT} y={H - 10} textAnchor="end" className="chart-label">{last}</text>
      <text x="8" y="12" className="chart-label">kg</text>
    </svg>
    <div className="chart-legend">
      <span><i className="legend-raw"/> 実測（日別最終値）</span>
      <span><i className="legend-mean"/> 7日平均（4日以上）</span>
      <span><i className="legend-goal"/> 目標範囲</span>
    </div>
  </div>;
}

export function WeightTrendPanel() {
  const toDefault = todayTokyo();
  const [from, setFrom] = useState(() => dayText(dayNumber(toDefault) - 89));
  const [to, setTo] = useState(toDefault);
  const [goalLow, setGoalLow] = useState(75);
  const [goalHigh, setGoalHigh] = useState(76);
  const [state, setState] = useState<TrendState>({ kind: "loading" });
  const validGoals = Number.isFinite(goalLow) && Number.isFinite(goalHigh)
    && goalLow >= 30 && goalHigh < 350 && goalLow <= goalHigh;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setState({ kind: "loading" });
      try {
        const response = await fetch("/api/weight/trend?from="
          + encodeURIComponent(from) + "&to=" + encodeURIComponent(to), {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw Error(response.status === 400
          ? "期間の指定が不正です。366日以内の日付を選んでください。"
          : response.status === 422
            ? "対象期間に測定が多すぎます。期間を短くしてください。"
            : "体重推移を取得できません。認証や接続を確認してください。");
        const data = await response.json() as WeightTrend;
        if (!controller.signal.aborted) setState({ kind: "ready", trend: data });
      } catch (err) {
        if (!controller.signal.aborted) setState({
          kind: "error",
          message: err instanceof Error && (err.message.startsWith("期間") || err.message.startsWith("対象"))
            ? err.message : "体重推移を取得できません。認証や接続を確認してください。",
        });
      }
    }
    void load();
    return () => controller.abort();
  }, [from, to]);

  return <section className="panel trend-panel" aria-labelledby="trend-title">
    <h2 id="trend-title">体重推移と7日平均</h2>
    <p className="hint">日付は日本時間。1日に複数の実測がある場合は最後の測定を表示します。異常値・推定値は平均から除外します。</p>
    <div className="trend-controls">
      <label>開始日<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label>終了日<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
    </div>
    <fieldset className="goal-controls">
      <legend>表示目標（この画面だけ・保存されません）</legend>
      <label>下限（kg）<input type="number" min="30" max="350" step="0.1"
        value={goalLow} onChange={event => setGoalLow(Number(event.target.value))} /></label>
      <label>上限（kg）<input type="number" min="30" max="350" step="0.1"
        value={goalHigh} onChange={event => setGoalHigh(Number(event.target.value))} /></label>
      <small>初期値75〜76kg・目標日2026年12月22日（本人の検証目標、結果の保証ではありません）</small>
    </fieldset>
    {!validGoals && <p role="alert">目標は30kg以上350kg未満、下限≦上限で指定してください。</p>}
    {state.kind === "loading" && <p role="status">体重記録を読み込み中…</p>}
    {state.kind === "error" && <p role="alert">{state.message}</p>}
    {state.kind === "ready" && <div>
      <p className="trend-summary">
        <strong>観測 {state.trend.observedDays}日</strong> ／
        欠測 {state.trend.missingDays}日 ／
        異常値除外 {state.trend.excludedAnomalies}件 ／
        実測以外の除外 {state.trend.excludedNonMeasured}件
      </p>
      {validGoals && <WeightChart trend={state.trend} goalLow={goalLow} goalHigh={goalHigh} />}
      <p className="hint">7日平均は直近7暦日の実測日が4日以上ある場合だけ表示。欠測日を0kgとして補完せず、線でも接続しません。体重の増減から原因は確定できません。</p>
      <details>
        <summary>日別の測定値・出典と欠測を確認</summary>
        <div className="trend-table-scroll">
          <table className="trend-table"><thead><tr>
            <th scope="col">日付</th><th scope="col">代表値</th><th scope="col">7日平均</th>
            <th scope="col">実測日数</th><th scope="col">出典・測定日時</th>
          </tr></thead><tbody>
            {state.trend.days.map(d => <tr key={d.day}>
              <th scope="row">{d.day}</th>
              <td>{kg(d.weightKg)}</td>
              <td>{d.average7Kg === null ? "データ不足" : kg(d.average7Kg)}</td>
              <td>{d.observed7Days}/7</td>
              <td>{d.measuredAt === null ? "記録なし" : d.source + " / " + d.measuredAt + "（同日" + d.observations + "測定）"}</td>
            </tr>)}
          </tbody></table>
        </div>
      </details>
    </div>}
  </section>;
}
