/** Calendar day for a timestamp in Asia/Tokyo (no DST). */
export function jstCalendarDay(epochMs:number=Date.now(),daysAgo=0):string{
  return new Date(epochMs+9*3600000-daysAgo*86400000).toISOString().slice(0,10);
}

/** Daily totals are not final before the local calendar day ends. */
export function defaultCompletedDay(epochMs:number=Date.now()):string{
  return jstCalendarDay(epochMs,1);
}
