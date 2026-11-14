/** Ordered glasses and equivalent volume must not be confused with alcohol grams. */
export type DrinkKind="beer"|"highball"|"green_tea_high"|"other_alcohol"|"non_alcohol";
export type StoredDrinkKind=Exclude<DrinkKind,"beer">;
export type DrinkSize="regular"|"large"|"mega"|"custom";
export type DrinkAmounts={cups:number;volumeMl:number|null;abvPct:number|null;alcohol:number};
export type DrinkRecord=DrinkAmounts&{
  key:string;observedAt:string;kind:DrinkKind;size:DrinkSize|null;
};
export const kinds:readonly DrinkKind[]=["highball","beer","green_tea_high","other_alcohol","non_alcohol"];
export const drinkNames:Record<DrinkKind,string>={
  highball:"ハイボール",beer:"ビール",green_tea_high:"緑茶ハイ",
  other_alcohol:"その他のお酒",non_alcohol:"ノンアルコール"
};
export const sizeNames:Record<DrinkSize,string>={
  regular:"普通",large:"大",mega:"メガ",custom:"量を指定"
};
/** UI reference volumes, NOT a restaurant standard or an observed fact. */
export const referenceMl:Record<Exclude<DrinkSize,"custom">,number>={
  regular:350,large:500,mega:700
};
export const normalReferenceMl=350;
export function isDrinkKind(x:unknown):x is DrinkKind{
  return typeof x==="string"&&(kinds as readonly string[]).includes(x);
}
export function isDrinkSize(x:unknown):x is DrinkSize{
  return x==="regular"||x==="large"||x==="mega"||x==="custom";
}
export function storedDrinkKind(kind:DrinkKind):StoredDrinkKind{
  return kind==="beer"?"other_alcohol":kind;
}
export function drinkVariant(kind:DrinkKind):"beer"|null{
  return kind==="beer"?"beer":null;
}
/** UI-only: keep the raw text while editing; convert only complete integer input.
 * Never treat a cleared field as zero or silently clamp an invalid cup count.
 */
export function parseDrinkCupsInput(raw:string):number|null{
  if(!/^[0-9]{1,2}$/.test(raw))return null;
  const cups=Number(raw);
  return cups>=1&&cups<=50?cups:null;
}
/** The backend accepts precise JST timestamps only within the previous 366 days. */
export function parseDrinkLocalDateTime(local:string,nowMs=Date.now()):string|null{
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)||!Number.isFinite(nowMs))return null;
  const observed=local+":00+09:00",epoch=Date.parse(observed);
  if(!Number.isFinite(epoch)||epoch<=nowMs-366*86400000||epoch>nowMs+60000)return null;
  // Reject silently normalized impossible calendar dates and invalid hours.
  if(new Date(epoch+9*3600000).toISOString().slice(0,16)!==local)return null;
  return observed;
}
/** Validates the selected history end day, without conflating it with today's totals. */
export function drinkHistoryRange(to:string,today:string):{from:string;to:string}|null{
  const validDay=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+"T00:00:00Z"))&&
    new Date(Date.parse(s+"T00:00:00Z")).toISOString().slice(0,10)===s;
  if(!validDay(to)||!validDay(today)||to>today)return null;
  return {from:new Date(Date.parse(to+"T00:00:00Z")-29*86400000).toISOString().slice(0,10),to};
}
export function validDrinkAmounts(kind:DrinkKind,cups:unknown,volumeMl:unknown,abvPct:unknown):boolean{
  if(!Number.isInteger(cups)||(cups as number)<1||(cups as number)>50)return false;
  if(volumeMl!==null&&(typeof volumeMl!=="number"||!Number.isFinite(volumeMl)||
     volumeMl<=0||volumeMl>3000))return false;
  if(abvPct!==null&&(typeof abvPct!=="number"||!Number.isFinite(abvPct)||
     abvPct<0||abvPct>100))return false;
  if(kind==="non_alcohol")return abvPct===null||abvPct===0;
  return abvPct===null||(abvPct as number)>0;
}
/** Pure alcohol: total beverage millilitres × ABV fraction × ethanol density 0.8g/ml. */
export function pureAlcoholGrams({cups,volumeMl,abvPct,alcohol}:DrinkAmounts):number|null{
  if(volumeMl===null||abvPct===null)return null;
  if(!Number.isInteger(cups)||cups<1||!Number.isFinite(volumeMl)||volumeMl<=0||
     !Number.isFinite(abvPct)||abvPct<0||abvPct>100)return null;
  if(alcohol===0&&abvPct===0)return 0;
  if(alcohol!==1||abvPct===0)return null;
  return Math.round(cups*volumeMl*abvPct*0.8)/100;
}
/** Relative volume in 350ml reference servings of the same drink; NOT grams. */
export function equivalentNormalServings({cups,volumeMl}:Pick<DrinkAmounts,"cups"|"volumeMl">):number|null{
  if(volumeMl===null||!Number.isFinite(volumeMl)||volumeMl<=0||!Number.isInteger(cups)||cups<1)return null;
  return Math.round(cups*volumeMl/normalReferenceMl*10)/10;
}
