import { useCallback, useEffect, useRef, useState } from "react";

type Kind="highball"|"green_tea_high"|"other_alcohol"|"non_alcohol";
type Drink={key:string;observedAt:string;kind:Kind;alcohol:number;cups:number};
type MealKind="home"|"restaurant"|"takeout"|null;
type Meal={day:string;lunchKind:MealKind;dinnerKind:MealKind;lateMeal:0|1|null};
type Outing={key:string;day:string;category:"work"|"bar"|"other"};
const mealLabel:Record<Exclude<MealKind,null>,string>={home:"自炊",restaurant:"外食",takeout:"中食"};
const venueLabel={work:"会社・接待",bar:"居酒屋・バー",other:"その他"};
type Experiment={id:string;statement:string;supportText:string|null;counterText:string|null;unknownText:string|null;
  status:string;startsOn:string;endsOn:string;targetAction:string;outcomeText:string|null;decision:string|null};
type Period={from:string;to:string;calendarDays:number;
  weight:{startKg:number|null;endKg:number|null;deltaKg:number|null;observedDays:number;missingDays:number};
  steps:{mean:number|null;observedDays:number;missingDays:number;zeroDays:number;sources:string[]};
  drinking:{observedDays:number;drinkingDays:number;nondrinkingDays:number;missingDays:number;
    recordedAlcoholCups:number;recordedNonAlcoholCups:number;cupEntryCount:number};
  outings:{visits:number;work:number;bar:number;other:number};
  meals:{lateMealDays:number;lateMealObservedDays:number;observedLunchDays:number;observedDinnerDays:number;
    restaurantLunchDays:number;restaurantDinnerDays:number;takeoutLunchDays:number;takeoutDinnerDays:number}};
type CompareResult={a:Period;b:Period;disclaimer:string};
const names:Record<Kind,string>={highball:"ハイボール",green_tea_high:"緑茶ハイ",
  other_alcohol:"その他のお酒",non_alcohol:"ノンアルコール"};
const jstNow=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,16);
const jstDay=()=>jstNow().slice(0,10);
const isoDay=(daysAgo:number)=>new Date(Date.now()+9*3600000-daysAgo*86400000).toISOString().slice(0,10);
const localTime=(observed:string)=>new Date(Date.parse(observed)+9*3600000).toISOString().slice(0,16);
const jstObserved=(local:string)=>local+":00+09:00";
const render=(num:number|null,suffix="")=>num===null?"データ不足":num.toLocaleString("ja-JP")+suffix;
async function jsonGet<T>(path:string):Promise<T>{
  const res=await fetch(path,{credentials:"same-origin",cache:"no-store"});
  if(!res.ok)throw Error("取得できません（HTTP "+res.status+"）");
  return await res.json() as T;
}
async function mutate(path:string,method:"POST"|"PUT"|"PATCH"|"DELETE",value:Record<string,unknown>){
  const res=await fetch(path,{method,credentials:"same-origin",cache:"no-store",
    headers:{"Content-Type":"application/json","X-Life-Log-Intent":"manual-write-v1"},body:JSON.stringify(value)});
  const data=await res.json().catch(()=>({})) as {error?:string;status?:string};
  if(!res.ok)throw Error(
    res.status===403?"本人認証・書込みの許可を確認してください。":
    data.error==="CONFLICT"?"履歴が更新されています。再取得してからやり直してください。":
    "処理できませんでした（"+(data.error??res.status)+"）");
  return data;
}
export function MvpFeatures({onSaved,mode="record"}:{onSaved:()=>void;mode?:"quick"|"record"|"analysis"|"data"}){
  const [drinks,setDrinks]=useState<Drink[]>([]);
  const [drinksError,setDrinksError]=useState("");
  const [drinksBusy,setDrinksBusy]=useState(false);
  const pending=useRef<{key:string;kind:Kind;observedAt:string}|null>(null);
  const [editing,setEditing]=useState<Drink|null>(null);
  const [editKind,setEditKind]=useState<Kind>("highball");
  const [editTime,setEditTime]=useState("");
  const [meals,setMeals]=useState<Meal[]>([]);
  const [mealDay,setMealDay]=useState(jstDay);
  const [mealLunch,setMealLunch]=useState("");
  const [mealDinner,setMealDinner]=useState("");
  const [mealLate,setMealLate]=useState("");
  const [mealsError,setMealsError]=useState("");
  const [mealBusy,setMealBusy]=useState(false);
  const [outings,setOutings]=useState<Outing[]>([]);
  const [outingDay,setOutingDay]=useState(jstDay);
  const [outingKind,setOutingKind]=useState<Outing["category"]>("bar");
  const [outingEdit,setOutingEdit]=useState<Outing|null>(null);
  const [outingError,setOutingError]=useState("");
  const [outingBusy,setOutingBusy]=useState(false);
  const pendingOuting=useRef<string|null>(null);
  const [experimentList,setExperimentList]=useState<Experiment[]>([]);
  const [experimentError,setExperimentError]=useState("");
  const [planBusy,setPlanBusy]=useState(false);
  const [statement,setStatement]=useState("");
  const [support,setSupport]=useState("");
  const [counter,setCounter]=useState("");
  const [unknown,setUnknown]=useState("");
  const [targetAction,setTargetAction]=useState("");
  const [startsOn,setStartsOn]=useState(jstDay);
  const [endsOn,setEndsOn]=useState(isoDay(-14));
  const [outcomes,setOutcomes]=useState<Record<string,string>>({});
  const [decision,setDecision]=useState<Record<string,string>>({});
  const [aFrom,setAFrom]=useState(isoDay(29));
  const [aTo,setATo]=useState(isoDay(15));
  const [bFrom,setBFrom]=useState(isoDay(14));
  const [bTo,setBTo]=useState(jstDay);
  const [comparison,setComparison]=useState<CompareResult|null>(null);
  const [compareError,setCompareError]=useState("");
  const [compareBusy,setCompareBusy]=useState(false);
  const [exportFrom,setExportFrom]=useState(isoDay(29));
  const [exportTo,setExportTo]=useState(jstDay);
  const [exportError,setExportError]=useState("");
  const [exportBusy,setExportBusy]=useState(false);
  const loadDrinks=useCallback(async()=>{
    try{
      const r=await jsonGet<{entries:Drink[]}>("/api/mvp/drinks");
      setDrinks(r.entries);setDrinksError("");
    }catch(e){setDrinksError(e instanceof Error?e.message:"飲酒履歴を取得できません。");}
  },[]);
  const loadExperiments=useCallback(async()=>{
    try{
      const r=await jsonGet<{experiments:Experiment[]}>("/api/mvp/experiments");
      setExperimentList(r.experiments);setExperimentError("");
    }catch(e){setExperimentError(e instanceof Error?e.message:"行動計画を取得できません。");}
  },[]);
  useEffect(()=>{if(mode==="quick"||mode==="record")void loadDrinks();if(mode==="analysis")void loadExperiments();},[loadDrinks,loadExperiments,mode]);
  const loadMeals=useCallback(async()=>{
    try{
      const res=await jsonGet<{entries:Meal[]}>("/api/mvp/meals");
      setMeals(res.entries);setMealsError("");
    }catch(err){setMealsError(err instanceof Error?err.message:"食事履歴を取得できません。");}
  },[]);
  const loadOutings=useCallback(async()=>{
    try{
      const res=await jsonGet<{entries:Outing[]}>("/api/mvp/outings");
      setOutings(res.entries);setOutingError("");
    }catch(err){setOutingError(err instanceof Error?err.message:"飲みの場を取得できません。");}
  },[]);
  useEffect(()=>{if(mode==="record"){void loadMeals();void loadOutings();}},[loadMeals,loadOutings,mode]);
  useEffect(()=>{
    const row=meals.find(x=>x.day===mealDay);
    setMealLunch(row?.lunchKind??"");
    setMealDinner(row?.dinnerKind??"");
    setMealLate(row?.lateMeal===null||row?.lateMeal===undefined?"":String(row.lateMeal));
  },[meals,mealDay]);

  const todayDrinks=drinks.filter(d=>localTime(d.observedAt).slice(0,10)===jstDay());
  const todayAlcohol=todayDrinks.filter(d=>d.alcohol===1).reduce((n,d)=>n+d.cups,0);
  const todayNoAlcohol=todayDrinks.filter(d=>d.alcohol===0).reduce((n,d)=>n+d.cups,0);
  async function addDrink(kind:Kind){
    if(drinksBusy)return;
    setDrinksBusy(true);setDrinksError("");
    if(!pending.current)pending.current={key:crypto.randomUUID(),kind,observedAt:new Date().toISOString()};
    try{
      await mutate("/api/mvp/drinks","POST",pending.current);
      pending.current=null;await loadDrinks();onSaved();
    }catch(e){
      await loadDrinks();
      setDrinksError(e instanceof Error?e.message:"通信結果が不明です。履歴を確認してください。");
    }finally{setDrinksBusy(false);}
  }
  async function updateDrink(){
    if(!editing||drinksBusy||!editTime)return;
    setDrinksBusy(true);setDrinksError("");
    try{
      await mutate("/api/mvp/drinks","PATCH",{
        key:editing.key,kind:editKind,observedAt:jstObserved(editTime),
        expectedObservedAt:editing.observedAt,expectedKind:editing.kind});
      setEditing(null);await loadDrinks();onSaved();
    }catch(e){await loadDrinks();setDrinksError(e instanceof Error?e.message:"訂正できませんでした。");}
    finally{setDrinksBusy(false);}
  }
  async function removeDrink(d:Drink){
    if(drinksBusy||!window.confirm("この1杯の記録を取り消しますか？"))return;
    setDrinksBusy(true);setDrinksError("");
    try{
      await mutate("/api/mvp/drinks","DELETE",{key:d.key,expectedObservedAt:d.observedAt,expectedKind:d.kind});
      if(editing?.key===d.key)setEditing(null);
      await loadDrinks();onSaved();
    }catch(e){await loadDrinks();setDrinksError(e instanceof Error?e.message:"取消できませんでした。");}
    finally{setDrinksBusy(false);}
  }

  async function saveMeal(){
    if(mealBusy)return;setMealBusy(true);setMealsError("");
    const old=meals.find(m=>m.day===mealDay)??null;
    try{
      await mutate("/api/mvp/meals","PUT",{
        day:mealDay,lunchKind:mealLunch||null,dinnerKind:mealDinner||null,
        lateMeal:mealLate===""?null:Number(mealLate),expected:old});
      await loadMeals();onSaved();
    }catch(err){await loadMeals();setMealsError(err instanceof Error?err.message:"食事区分を保存できません。");}
    finally{setMealBusy(false);}
  }
  async function cancelMeal(){
    if(mealBusy)return;
    const old=meals.find(m=>m.day===mealDay);
    if(!old||!window.confirm("この日の手入力した食事区分を取り消しますか？"))return;
    setMealBusy(true);setMealsError("");
    try{
      await mutate("/api/mvp/meals","DELETE",{day:old.day,expected:old});
      await loadMeals();onSaved();
    }catch(err){await loadMeals();setMealsError(err instanceof Error?err.message:"取り消せませんでした。");}
    finally{setMealBusy(false);}
  }
  async function saveOuting(){
    if(outingBusy)return;setOutingBusy(true);setOutingError("");
    const key=outingEdit?.key??(pendingOuting.current??=crypto.randomUUID());
    try{
      await mutate("/api/mvp/outings",outingEdit?"PATCH":"POST",{
        key,day:outingDay,category:outingKind,
        ...(outingEdit?{expectedDay:outingEdit.day,expectedCategory:outingEdit.category}:{})});
      pendingOuting.current=null;setOutingEdit(null);await loadOutings();onSaved();
    }catch(err){await loadOutings();setOutingError(err instanceof Error?err.message:"飲みの場を保存できません。");}
    finally{setOutingBusy(false);}
  }
  async function cancelOuting(row:Outing){
    if(outingBusy||!window.confirm("この参加記録を取り消しますか？"))return;
    setOutingBusy(true);setOutingError("");
    try{
      await mutate("/api/mvp/outings","DELETE",{
        key:row.key,expectedDay:row.day,expectedCategory:row.category});
      if(outingEdit?.key===row.key)setOutingEdit(null);
      await loadOutings();onSaved();
    }catch(err){await loadOutings();setOutingError(err instanceof Error?err.message:"取り消せませんでした。");}
    finally{setOutingBusy(false);}
  }
  async function compare(){
    if(compareBusy)return;
    setCompareBusy(true);setCompareError("");
    try{
      const q=new URLSearchParams({aFrom,aTo,bFrom,bTo});
      setComparison(await jsonGet<CompareResult>("/api/mvp/compare?"+q));
    }catch(e){setComparison(null);setCompareError(e instanceof Error?e.message:"期間を比較できません。");}
    finally{setCompareBusy(false);}
  }
  async function createPlan(e:React.FormEvent){
    e.preventDefault();if(planBusy)return;
    setPlanBusy(true);setExperimentError("");
    try{
      await mutate("/api/mvp/experiments","POST",{
        id:crypto.randomUUID(),statement,targetAction,supportText:support,counterText:counter,
        unknownText:unknown,startsOn,endsOn});
      await loadExperiments();setStatement("");setTargetAction("");
      setSupport("");setCounter("");setUnknown("");
    }catch(err){setExperimentError(err instanceof Error?err.message:"行動計画を作成できません。");}
    finally{setPlanBusy(false);}
  }
  async function decide(id:string){
    if(planBusy)return;setPlanBusy(true);setExperimentError("");
    try{
      await mutate("/api/mvp/experiments","PATCH",{
        id,decision:decision[id]??"unknown",outcomeText:outcomes[id]??""});
      await loadExperiments();
    }catch(err){setExperimentError(err instanceof Error?err.message:"本人判定を保存できません。");}
    finally{setPlanBusy(false);}
  }
  async function downloadCsv(){
    if(exportBusy)return;setExportBusy(true);setExportError("");
    try{
      const q=new URLSearchParams({from:exportFrom,to:exportTo});
      const res=await fetch("/api/mvp/export?"+q,{credentials:"same-origin",cache:"no-store"});
      if(!res.ok)throw Error("CSVを出力できません（HTTP "+res.status+"）");
      const blob=await res.blob();
      const url=URL.createObjectURL(blob);
      try{
        const a=document.createElement("a");a.href=url;a.download="life-log-"+exportFrom+"-"+exportTo+".csv";
        document.body.appendChild(a);a.click();a.remove();
      }finally{URL.revokeObjectURL(url);}
    }catch(err){setExportError(err instanceof Error?err.message:"CSV出力に失敗しました。");}
    finally{setExportBusy(false);}
  }

  return <>
    {(mode==="quick"||mode==="record")&&<section className="panel drinks-panel" aria-labelledby="drink-title">
      <h2 id="drink-title">飲酒を1杯ずつ記録</h2>
      <p className="hint">記録した杯数だけを表示します。過去の「飲酒あり・杯数不明」は勝手に1杯へ変換しません。</p>
      <p className="metric" aria-live="polite">今日：お酒 {todayAlcohol} 杯 ／ ノンアル {todayNoAlcohol} 杯</p>
      <div className="mvp-buttons" role="group" aria-label="飲み物を1杯追加">
        {(Object.keys(names) as Kind[]).map(k=><button type="button" key={k}
          disabled={drinksBusy} onClick={()=>void addDrink(k)}>{names[k]} ＋1</button>)}
      </div>
      {mode==="record"&&<button type="button" disabled={drinksBusy} onClick={()=>void loadDrinks()}>飲酒履歴を更新</button>}
      {drinksError&&<p role="alert">{drinksError}</p>}
      {mode==="record"&&<details className="sub-details"><summary>過去30日の飲酒記録を確認・訂正する</summary>
      <h3>直近30日の記録</h3>
      {drinks.length===0&&<p className="hint">まだ1杯ずつの記録はありません。</p>}
      <ul>{drinks.map(d=><li key={d.key} className="mvp-entry">
        <span>{localTime(d.observedAt).replace("T"," ")} · {names[d.kind]}</span>
        <button type="button" disabled={drinksBusy} onClick={()=>{
          setEditing(d);setEditKind(d.kind);setEditTime(localTime(d.observedAt));
        }}>訂正</button>
        <button type="button" disabled={drinksBusy} onClick={()=>void removeDrink(d)}>取消</button>
      </li>)}</ul>
      {editing&&<div className="mvp-edit">
        <h3>1杯の種類・日時を訂正</h3>
        <label>種類<select value={editKind} onChange={e=>setEditKind(e.target.value as Kind)}>
          {(Object.keys(names) as Kind[]).map(k=><option key={k} value={k}>{names[k]}</option>)}
        </select></label>
        <label>実際の日時（JST）<input type="datetime-local" value={editTime}
          max={jstNow()} onChange={e=>setEditTime(e.target.value)}/></label>
        <button type="button" disabled={drinksBusy||!editTime} onClick={()=>void updateDrink()}>訂正を保存</button>
        <button type="button" disabled={drinksBusy} onClick={()=>setEditing(null)}>やめる</button>
      </div>}
    </section>

    {mode==="record"&&<section className="panel" aria-labelledby="meals-title">
      <h2 id="meals-title">食事区分・夜食</h2>
      <p className="hint">選んでいない項目は「不明」として保存します。実際の記録がない日を外食なし・夜食なしとはみなしません。</p>
      <div className="mvp-grid">
        <label>日付（JST）<input type="date" value={mealDay} max={jstDay()}
          onChange={e=>setMealDay(e.target.value)}/></label>
        <label>昼食<select value={mealLunch} onChange={e=>setMealLunch(e.target.value)}>
          <option value="">不明・未入力</option>
          {Object.entries(mealLabel).map(([k,v])=><option key={k} value={k}>{v}</option>)}
        </select></label>
        <label>夕食<select value={mealDinner} onChange={e=>setMealDinner(e.target.value)}>
          <option value="">不明・未入力</option>
          {Object.entries(mealLabel).map(([k,v])=><option key={k} value={k}>{v}</option>)}
        </select></label>
        <label>夜食<select value={mealLate} onChange={e=>setMealLate(e.target.value)}>
          <option value="">不明・未入力</option><option value="0">なし</option><option value="1">あり</option>
        </select></label>
      </div>
      <button type="button" disabled={mealBusy} onClick={()=>void saveMeal()}>食事区分を保存・訂正</button>
      <button type="button" disabled={mealBusy||!meals.some(x=>x.day===mealDay)}
        onClick={()=>void cancelMeal()}>この日の手入力を取消</button>
      {mealsError&&<p role="alert">{mealsError}</p>}
      <p className="hint">直近の本人手入力：{meals.length}日。CSV由来の食事記録は上書きしません。</p>
    </section>}
    {mode==="record"&&<section className="panel" aria-labelledby="outings-title">
      <h2 id="outings-title">飲みの場・会食の参加</h2>
      <p className="hint">参加回数は飲酒杯数とは別に記録します。飲酒していない会食も参加として残せます。</p>
      <div className="mvp-grid">
        <label>日付（JST）<input type="date" value={outingDay} max={jstDay()}
          onChange={e=>setOutingDay(e.target.value)}/></label>
        <label>場の種類<select value={outingKind} onChange={e=>setOutingKind(e.target.value as Outing["category"])}>
          {Object.entries(venueLabel).map(([k,v])=><option key={k} value={k}>{v}</option>)}
        </select></label>
      </div>
      <button type="button" disabled={outingBusy} onClick={()=>void saveOuting()}>
        {outingEdit?"参加記録を訂正":"参加を記録"}</button>
      {outingEdit&&<button type="button" disabled={outingBusy} onClick={()=>{
        setOutingEdit(null);setOutingDay(jstDay());setOutingKind("bar");
      }}>訂正をやめる</button>}
      {outingError&&<p role="alert">{outingError}</p>}
      <ul>{outings.map(row=><li className="mvp-entry" key={row.key}>
        <span>{row.day} · {venueLabel[row.category]}</span>
        <button type="button" disabled={outingBusy} onClick={()=>{
          setOutingEdit(row);setOutingDay(row.day);setOutingKind(row.category);
        }}>訂正</button>
        <button type="button" disabled={outingBusy} onClick={()=>void cancelOuting(row)}>取消</button>
      </li>)}</ul>
    </section>}
    {mode==="analysis"&&<section className="panel" aria-labelledby="compare-title">
      <h2 id="compare-title">2期間の体重・生活比較</h2>
      <p className="hint">両期間は重ならないよう指定してください。測定数が少ない場合、変化や原因を断定しません。</p>
      <div className="mvp-grid">
        <fieldset><legend>比較期間A</legend>
          <label>開始<input type="date" value={aFrom} max={jstDay()} onChange={e=>setAFrom(e.target.value)}/></label>
          <label>終了<input type="date" value={aTo} max={jstDay()} onChange={e=>setATo(e.target.value)}/></label>
        </fieldset>
        <fieldset><legend>比較期間B</legend>
          <label>開始<input type="date" value={bFrom} max={jstDay()} onChange={e=>setBFrom(e.target.value)}/></label>
          <label>終了<input type="date" value={bTo} max={jstDay()} onChange={e=>setBTo(e.target.value)}/></label>
        </fieldset>
      </div>
      <button type="button" disabled={compareBusy} onClick={()=>void compare()}>期間を比較</button>
      {compareError&&<p role="alert">{compareError}</p>}
      {comparison&&<>
        <p className="hint">{comparison.disclaimer}</p>
        <div className="mvp-periods">
          {([["A",comparison.a],["B",comparison.b]] as const).map(([name,p])=><section key={name}>
            <h3>期間{name}：{p.from} ～ {p.to}</h3>
            <dl>
              <dt>体重の変化</dt><dd>{render(p.weight.deltaKg," kg")}（実測 {p.weight.observedDays}/{p.calendarDays}日）</dd>
              <dt>平均歩数</dt><dd>{render(p.steps.mean," 歩")}（観測 {p.steps.observedDays}日）</dd>
              <dt>飲酒した日</dt><dd>{p.drinking.drinkingDays}日／観測 {p.drinking.observedDays}日（欠測 {p.drinking.missingDays}日）</dd>
              <dt>実際に記録したお酒</dt><dd>{p.drinking.recordedAlcoholCups}杯（ノンアル {p.drinking.recordedNonAlcoholCups}杯）</dd>
              <dt>外食（昼・夜）</dt><dd>{p.meals.restaurantLunchDays}昼／{p.meals.restaurantDinnerDays}夜（観測 {p.meals.observedLunchDays}昼・{p.meals.observedDinnerDays}夜）</dd>
              <dt>夜食</dt><dd>あり {p.meals.lateMealDays}日／観測 {p.meals.lateMealObservedDays}日</dd>
              <dt>飲みの場への参加</dt><dd>{p.outings.visits}回（会社 {p.outings.work}・居酒屋/バー {p.outings.bar}・その他 {p.outings.other}）</dd>
            </dl>
          </section>)}
        </div>
      </>}
    </section>}
    {mode==="analysis"&&<section className="panel" aria-labelledby="experiment-title">
      <h2 id="experiment-title">行動実験・本人による判定</h2>
      <p className="hint">仮説を1つ登録し、終了時に根拠と反証を確認して継続・修正・終了・不明を選びます。</p>
      <form onSubmit={e=>void createPlan(e)}>
        <div className="mvp-grid">
          <label>検証したい仮説<input required maxLength={600} value={statement}
            onChange={e=>setStatement(e.target.value)} placeholder="例：夕食後の散歩と体重推移の関係"/></label>
          <label>行動計画<input required maxLength={600} value={targetAction}
            onChange={e=>setTargetAction(e.target.value)} placeholder="例：夕食後に20分歩く"/></label>
          <label>支持する材料<textarea maxLength={1200} value={support} onChange={e=>setSupport(e.target.value)}/></label>
          <label>反証する材料<textarea maxLength={1200} value={counter} onChange={e=>setCounter(e.target.value)}/></label>
          <label>まだわからないこと<textarea maxLength={1200} value={unknown} onChange={e=>setUnknown(e.target.value)}/></label>
          <label>開始日<input type="date" value={startsOn} onChange={e=>setStartsOn(e.target.value)}/></label>
          <label>終了日<input type="date" value={endsOn} onChange={e=>setEndsOn(e.target.value)}/></label>
        </div>
        <button type="submit" disabled={planBusy||!statement.trim()||!targetAction.trim()}>行動計画を登録</button>
      </form>
      {experimentError&&<p role="alert">{experimentError}</p>}
      {experimentList.map(x=><article key={x.id} className="mvp-plan">
        <h3>{x.statement}</h3>
        <p>{x.startsOn} ～ {x.endsOn} ／ {x.targetAction}</p>
        <p>支持：{x.supportText||"未記録"} ／ 反証：{x.counterText||"未記録"}</p>
        <p>不明点：{x.unknownText||"未記録"}</p>
        {x.decision?<p>本人判定：{({continue:"継続",revise:"修正",stop:"終了",unknown:"不明"} as Record<string,string>)[x.decision]||x.decision}
          {x.outcomeText?" · "+x.outcomeText:""}</p>:<div>
          <label>振り返り<textarea maxLength={1200} value={outcomes[x.id]??""}
            onChange={e=>setOutcomes(s=>({...s,[x.id]:e.target.value}))}/></label>
          <label>本人判定<select value={decision[x.id]??"unknown"}
            onChange={e=>setDecision(s=>({...s,[x.id]:e.target.value}))}>
            <option value="continue">継続</option><option value="revise">修正</option>
            <option value="stop">終了</option><option value="unknown">不明</option>
          </select></label>
          <button type="button" disabled={planBusy} onClick={()=>void decide(x.id)}>判定を保存</button>
        </div>}
      </article>)}
    </section>}
    {mode==="data"&&<section className="panel" aria-labelledby="export-title">
      <h2 id="export-title">本人データのCSV再出力</h2>
      <p className="hint">体重、歩数、飲酒、食事、飲みの場を元の出典とともにCSVへ出力します。欠測は空欄です。</p>
      <div className="mvp-grid">
        <label>開始日<input type="date" value={exportFrom} max={jstDay()}
          onChange={e=>setExportFrom(e.target.value)}/></label>
        <label>終了日<input type="date" value={exportTo} max={jstDay()}
          onChange={e=>setExportTo(e.target.value)}/></label>
      </div>
      <button type="button" disabled={exportBusy} onClick={()=>void downloadCsv()}>CSVを書き出す</button>
      {exportError&&<p role="alert">{exportError}</p>}
    </section>
  </>;
}
