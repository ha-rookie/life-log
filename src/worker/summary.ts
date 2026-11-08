import type { Summary } from "../shared/legacy";

// Minimal D1 contract enables isolated unit tests without remote databases.
export interface Database {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null> };
  };
}

export async function getSummary(db: Database, ownerId: string): Promise<Summary> {
  const row = await db.prepare(
    "SELECT measured_at, weight_kg FROM body_measurements WHERE owner_id = ? AND weight_kg IS NOT NULL ORDER BY measured_at DESC, id DESC LIMIT 1",
  ).bind(ownerId).first<{ measured_at: string; weight_kg: number }>();
  return {
    latestWeightKg: row ? row.weight_kg : null,
    measuredAt: row ? row.measured_at : null,
  };
}


/** Read-only owner dashboard. Each metric selects the most recent observed JST day.
 * Within a day the canonical source wins over manual input, never the reverse.
 */
export type DashboardSummary = {
  latestWeightKg:number|null; measuredAt:string|null; weightSource:string|null;
  latestSteps:number|null; stepsDay:string|null; stepsSource:string|null;
};
export async function getDashboard(db:Database,ownerId:string):Promise<DashboardSummary>{
  const [weight,steps]=await Promise.all([
    db.prepare(
      "SELECT weight_kg,measured_at,source_id FROM body_measurements"+
      " WHERE owner_id=? AND weight_kg IS NOT NULL AND anomaly_flag=0"+
      " AND source_kind='measured' AND"+
      " (source_id='eclear' OR source_id LIKE 'csv:eclear%'"+
      " OR source_id LIKE 'eclear:%' OR source_id LIKE 'manual:%')"+
      " ORDER BY date(measured_at,'+9 hours') DESC,"+
      " CASE WHEN source_id='eclear' OR source_id LIKE 'csv:eclear%' OR source_id LIKE 'eclear:%'"+
      " THEN 0 ELSE 1 END ASC, unixepoch(measured_at) DESC,id DESC LIMIT 1"
    ).bind(ownerId).first<{weight_kg:number;measured_at:string;source_id:string}>(),
    db.prepare(
      "SELECT steps,local_day,source_id FROM activity_daily WHERE owner_id=?"+
      " AND steps IS NOT NULL AND"+
      " (source_id='fit' OR source_id='google_fit' OR source_id='google-fit'"+
      " OR source_id LIKE 'fit:%' OR source_id LIKE 'google_fit:%'"+
      " OR source_id LIKE 'csv:fit%' OR source_id LIKE 'manual:%')"+
      " ORDER BY local_day DESC,CASE"+
      " WHEN source_id='fit' OR source_id='google_fit' OR source_id='google-fit'"+
      " OR source_id LIKE 'fit:%' OR source_id LIKE 'google_fit:%'"+
      " OR source_id LIKE 'csv:fit%' THEN 0 ELSE 1 END ASC LIMIT 1"
    ).bind(ownerId).first<{steps:number;local_day:string;source_id:string}>()
  ]);
  return {
    latestWeightKg:weight?.weight_kg??null,measuredAt:weight?.measured_at??null,
    weightSource:weight?.source_id??null,latestSteps:steps?.steps??null,
    stepsDay:steps?.local_day??null,stepsSource:steps?.source_id??null
  };
}
