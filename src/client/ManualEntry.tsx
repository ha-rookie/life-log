import { useCallback, useEffect, useRef, useState } from "react";
import { manualHistoryRange } from "../shared/manual-history";
import { defaultCompletedDay } from "./entry-date";
import { redirectOnExpiredOwnerSession } from "./auth-recovery";

type Weight = { key: string; measuredAt: string; weightKg: number };
type Steps = { day: string; steps: number };
type Records = { from: string; to: string; weights: Weight[]; steps: Steps[] };
const jstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const empty: Records = { from: "", to: "", weights: [], steps: [] };
type Action = "weight" | "steps";
export function ManualEntry({ onSaved }: { onSaved: () => void }) {
  const [rows, setRows] = useState<Records>(empty);
  const [historyTo,setHistoryTo]=useState(jstToday);
  const historySequence=useRef(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [weightAt, setWeightAt] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [weightKey, setWeightKey] = useState<string | null>(null);
  const [weightOriginal, setWeightOriginal] = useState<Weight | null>(null);
  const pendingKey = useRef<string | null>(null);
  const [stepsDay, setStepsDay] = useState(defaultCompletedDay);
  const [stepsValue, setStepsValue] = useState("");
  const [oldSteps, setOldSteps] = useState<number | null>(null);
  const [stepEditing, setStepEditing] = useState(false);
  const load = useCallback(async () => {
    const current=++historySequence.current;
    const range=manualHistoryRange(historyTo,jstToday());
    if(!range){
      setRows(empty);setLoading(false);setMessage("履歴の終了日を確認してください。未来の日付は選べません。");return;
    }
    setLoading(true);
    try {
      const response=await fetch("/api/manual/records?"+new URLSearchParams(range).toString(),
        {credentials:"same-origin",cache:"no-store"});
      if(response.status===403 && await redirectOnExpiredOwnerSession(response))throw new Error("LOGIN_REQUIRED");
      if(!response.ok)throw new Error("GET");
      const data=await response.json() as Records;
      if(current===historySequence.current)setRows(data);
    }catch{
      if(current===historySequence.current){
        setRows(empty);
        setMessage("選択した期間の手入力履歴を取得できません。認証と接続を確認してください。");
      }
    }finally{if(current===historySequence.current)setLoading(false);}
  },[historyTo]);
  useEffect(()=>{
    void load();
    return ()=>{historySequence.current+=1;};
  },[load]);
  async function refreshHistory(day=historyTo){
    if(day!==historyTo)setHistoryTo(day);
    else await load();
  }
  const historyRange=manualHistoryRange(historyTo,jstToday());

  async function request(path: Action, method: string, payload: Record<string, unknown>) {
    const response = await fetch("/api/manual/" + path, {
      method, credentials: "same-origin", cache: "no-store",
      // A non-simple custom request header complements strict server-side Origin
      // and Fetch Metadata validation for remote browser writes.
      headers: { "Content-Type": "application/json",
        "X-Life-Log-Intent": "manual-write-v1" },
      body: JSON.stringify(payload),
    });
    if(response.status===403 && await redirectOnExpiredOwnerSession(response))throw new Error("LOGIN_REQUIRED");
    // The global Access gate can return text rather than JSON for expired JWTs.
    let data: { error?: string; status?: string } = {};
    try { data = await response.json() as typeof data; } catch { /* denied auth may be text */ }
    if (!response.ok) {
      if (response.status === 403) throw new Error(
        "書込が拒否されました。本人認証とローカル開発環境／承認済み本人専用環境の設定を確認してください。");
      if (data.error === "SOURCE_CONFLICT") throw new Error("同日にCSVなど別出典の歩数があります。上書きしません。");
      if (response.status === 409) throw new Error("既存の値と競合しています。履歴を再表示し、訂正操作を選択してください。");
      throw new Error("登録できませんでした（" + (data.error ?? response.status) + "）。");
    }
    return data;
  }

  async function saveWeight(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !weightAt || !weightKg || (weightKey !== null && !weightOriginal)) return;
    setBusy(true); setMessage("");
    // A retry after a failed response reuses the same key. A successful save
    // rotates it; no speculative "saved" UI before the server response.
    const key = weightKey ?? (pendingKey.current ??= crypto.randomUUID());
    try {
      const measuredAt = weightAt + ":00+09:00";
      await request("weight", weightKey ? "PATCH" : "POST", {
        key, measuredAt, weightKg: Number(weightKg),
        ...(weightOriginal && weightKey ? {
          expectedMeasuredAt: weightOriginal.measuredAt,
          expectedWeightKg: weightOriginal.weightKg,
        } : {}),
      });
      setMessage(weightKey ? "体重の訂正を保存しました。" : "体重を記録しました。");
      setWeightKey(null); setWeightOriginal(null);
      pendingKey.current = null; setWeightAt(""); setWeightKg("");
      await refreshHistory(measuredAt.slice(0,10)); onSaved();
    } catch (err) {
      // An unknown network outcome may mean the write committed. Re-read
      // before the user retries; a POST reuses its stable UUID if needed.
      await load();
      setMessage(err instanceof Error ? err.message
        : "通信結果が不明です。履歴を確認してから再試行してください。");
    } finally { setBusy(false); }
  }
  async function saveSteps(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || stepsValue === "") return;
    setBusy(true); setMessage("");
    try {
      await request("steps", stepEditing ? "PUT" : "POST", {
        day: stepsDay, steps: Number(stepsValue),
        ...(stepEditing ? { expectedSteps: oldSteps } : {}),
      });
      setMessage(stepEditing ? "歩数を訂正しました。" : "歩数を記録しました。");
      setStepEditing(false); setOldSteps(null); setStepsValue("");
      await refreshHistory(stepsDay); onSaved();
    } catch (err) {
      await load();
      setMessage(err instanceof Error ? err.message
        : "通信結果が不明です。履歴を確認してから再試行してください。");
    } finally { setBusy(false); }
  }
  async function removeWeight(row: Weight) {
    if (busy || !window.confirm("この手入力の体重を取り消しますか？CSV由来データは変更されません。")) return;
    setBusy(true); setMessage("");
    try {
      await request("weight", "DELETE", {
        key: row.key, expectedMeasuredAt: row.measuredAt,
        expectedWeightKg: row.weightKg,
      });
      setMessage("手入力の体重を取り消しました。");
      setWeightKey(null); setWeightOriginal(null); pendingKey.current = null;
      await refreshHistory(); onSaved();
    } catch (err) {
      await load();
      setMessage(err instanceof Error ? err.message : "取消結果が不明です。履歴を確認してください。");
    } finally { setBusy(false); }
  }
  async function removeSteps(day: string, expectedSteps: number) {
    if (busy || !window.confirm(day + " の手入力歩数を取り消しますか？")) return;
    setBusy(true); setMessage("");
    try {
      await request("steps", "DELETE", { day, expectedSteps });
      setMessage("手入力の歩数を取り消しました。");
      setStepEditing(false); setOldSteps(null);
      await refreshHistory(); onSaved();
    } catch (err) {
      await load();
      setMessage(err instanceof Error ? err.message : "取消結果が不明です。履歴を確認してください。");
    } finally { setBusy(false); }
  }
  return <section className="panel manual-entry" aria-labelledby="manual-title">
    <h2 id="manual-title">体重・歩数の入力</h2>
    <p className="hint">体重には実際の測定日時を入力します。CSVの数値がある日はCSVを優先表示し、手入力も残ります。</p>
    <form onSubmit={e => void saveWeight(e)}>
      <h3>体重の実測</h3>
      <div className="manual-fields">
        <label>測定日時（日本時間）<input type="datetime-local" required step="60"
          value={weightAt} onChange={e => {setWeightAt(e.target.value);if(!weightKey) pendingKey.current=null;}} disabled={busy}/></label>
        <label>体重（kg）<input type="number" required min="0.1" max="499.9" step="0.1"
          value={weightKg} onChange={e => {setWeightKg(e.target.value);if(!weightKey) pendingKey.current=null;}} disabled={busy}/></label>
      </div>
      <div className="manual-actions">
        <button type="submit" disabled={busy || !weightAt || !weightKg}>{weightKey ? "体重を訂正" : "体重を記録"}</button>
        {weightKey && <button type="button" disabled={busy} onClick={() => {
          setWeightKey(null); setWeightOriginal(null);
          pendingKey.current=null; setWeightAt(""); setWeightKg("");
        }}>訂正をやめる</button>}
      </div>
    </form>
    <form onSubmit={e => void saveSteps(e)}>
      <h3>歩数</h3>
      <p className="hint">1日分の歩数が確定した前日を初期表示します。別の日も選べます。</p>
      <div className="manual-fields">
        <label>日付（日本時間）<input id="steps-day" type="date" required max={jstToday()}
          value={stepsDay} disabled={busy || stepEditing}
          onChange={e => setStepsDay(e.target.value)}/></label>
        <label>歩数<input type="number" required min="0" max="300000" step="1"
          value={stepsValue} disabled={busy}
          onChange={e => setStepsValue(e.target.value)}/></label>
      </div>
      <div className="manual-actions">
        <button type="submit" disabled={busy || !stepsDay || stepsValue===""}>{stepEditing ? "歩数を訂正" : "歩数を記録"}</button>
        {stepEditing && <button type="button" disabled={busy} onClick={() => {
          setStepEditing(false); setOldSteps(null); setStepsValue("");
        }}>訂正をやめる</button>}
      </div>
    </form>
    {message && <p role="status" aria-live="polite">{message}</p>}
    <details className="manual-records sub-details">
      <summary>手入力の履歴・訂正・取消</summary>
      <h3>過去の手入力履歴（30日単位）</h3>
      <div className="manual-fields">
        <label>履歴の終了日（日本時間）<input id="manual-history-to" type="date"
          value={historyTo} max={jstToday()} disabled={busy}
          aria-invalid={historyRange===null}
          onChange={e=>{
            setWeightKey(null);setWeightOriginal(null);setStepEditing(false);setOldSteps(null);
            setHistoryTo(e.target.value);
          }}/></label>
        <button type="button" disabled={busy} onClick={()=>setHistoryTo(jstToday())}>
          直近30日に戻る
        </button>
      </div>
      {historyRange&&<p className="hint">表示期間：{historyRange.from} 〜 {historyRange.to}</p>}
      <button type="button" disabled={busy || loading} onClick={() => void load()}>履歴を更新</button>
      {loading && <p role="status">記録を読み込み中…</p>}
      {!loading && <div className="manual-history">
        <div><h4>体重</h4>
          {!rows.weights.length && <p className="hint">手入力なし</p>}
          <ul>{rows.weights.map(w => <li key={w.key}>
            <span>{w.measuredAt.replace("T", " ").slice(0,16)} · {w.weightKg.toFixed(1)}kg</span>
            <button type="button" disabled={busy} onClick={() => {
              setWeightKey(w.key); setWeightOriginal(w); pendingKey.current=null;
              setWeightAt(w.measuredAt.slice(0,16)); setWeightKg(String(w.weightKg));
            }}>編集</button>
            <button type="button" disabled={busy} onClick={() => void removeWeight(w)}>取消</button>
          </li>)}</ul>
        </div>
        <div><h4>歩数</h4>
          {!rows.steps.length && <p className="hint">手入力なし</p>}
          <ul>{rows.steps.map(r => <li key={r.day}>
            <span>{r.day} · {r.steps.toLocaleString()}歩</span>
            <button type="button" disabled={busy} onClick={() => {
              setStepEditing(true); setStepsDay(r.day); setOldSteps(r.steps); setStepsValue(String(r.steps));
            }}>編集</button>
            <button type="button" disabled={busy} onClick={() => void removeSteps(r.day,r.steps)}>取消</button>
          </li>)}</ul>
        </div>
      </div>}
    </details>
  </section>;
}
