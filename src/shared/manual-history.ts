/** Inclusive 30-day JST window for earlier manual weight/steps. */
export function manualHistoryRange(to:string,today:string):{from:string;to:string}|null{
  const valid=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+"T00:00:00Z"))&&
    new Date(Date.parse(s+"T00:00:00Z")).toISOString().slice(0,10)===s;
  if(!valid(to)||!valid(today)||to>today)return null;
  return {from:new Date(Date.parse(to+"T00:00:00Z")-29*86400000).toISOString().slice(0,10),to};
}
