import type { EclearCompositionMeasurement } from "../shared/source-adapter";
import type { ImportDb } from "./import";

/**
 * Stage 2A of #124: read-only, owner-scoped local D1 classification.
 * No API routing, D1 mutation, import_job replay or audit rewriting is permitted
 * in this stage. Stage 2B must recheck every snapshot atomically before writing.
 */
export const ECLEAR_FIELDS=[
  ["weightKg","weight_kg"],
  ["bodyFatPct","body_fat_pct"],
  ["skeletalMusclePct","skeletal_muscle_pct"],
  ["bmi","bmi"],
  ["visceralFatLevel","visceral_fat_level"],
  ["boneMassKg","bone_mass_kg"],
  ["basalMetabolismKcal","basal_metabolism_kcal"]
] as const;

export type Field=typeof ECLEAR_FIELDS[number][0];
export type StoredMeasurement={
  id:string;source_id:string;measured_at:string;
  weight_kg:number|null;body_fat_pct:number|null;skeletal_muscle_pct:number|null;
  bmi:number|null;visceral_fat_level:number|null;bone_mass_kg:number|null;
  basal_metabolism_kcal:number|null;
};
export type EclearEnrichmentClassification={
  line:number; status:"new"|"enrich"|"unchanged"|"conflict";
  enrichFields:Field[]; conflictFields:Field[];
  reason?:"ambiguous_eclear"|"non_eclear_source"|"date_only_source"|"existing_value_conflict";
};
export type EclearEnrichmentPreview={
  total:number; newMeasurements:number; enrichMeasurements:number;
  enrichCells:number; sameCells:number; conflictMeasurements:number;
  missingCells:number; unchangedMeasurements:number;
  classifications:EclearEnrichmentClassification[];
};

function validTime(value:string):boolean{
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(value))return false;
  const [date,time]=value.split("T"),parts=time.slice(0,8).split(":").map(Number);
  if(parts[0]>23||parts[1]>59||parts[2]>59)return false;
  const d=new Date(date+"T00:00:00Z");
  return Number.isFinite(d.valueOf())&&d.toISOString().slice(0,10)===date;
}
function validRow(row:EclearCompositionMeasurement):boolean{
  if(!row||!validTime(row.measuredAt)||!Number.isFinite(row.weightKg) ||
     row.weightKg<=0||row.weightKg>=500)return false;
  return ECLEAR_FIELDS.slice(1).every(([key])=>{
    const v=row[key];
    if(v===null)return true;
    if(typeof v!=="number"||!Number.isFinite(v)||v<0)return false;
    return (key!=="bodyFatPct" && key!=="skeletalMusclePct")||v<=100;
  });
}

/**
 * Classify without leaking numeric measurement values or modifying DB.
 * A single csv:eclear row is eligible even if a manual row exists at the same
 * timestamp; a manual-only row is not eligible for inference/auto-merge.
 */
export type EclearEnrichmentSnapshot={incoming:EclearCompositionMeasurement;existing:StoredMeasurement[]};
export async function readEclearEnrichmentPlan(
  db:Pick<ImportDb,"prepare">,owner:string,measurements:readonly EclearCompositionMeasurement[]
):Promise<{preview:EclearEnrichmentPreview;snapshots:EclearEnrichmentSnapshot[]}>{
  if(!owner||measurements.length<1||measurements.length>40)
    throw Error("ECLEAR_ENRICHMENT_INPUT_INVALID");
  const seen=new Set<string>();
  for(const row of measurements){
    if(!validRow(row)||seen.has(row.measuredAt))throw Error("ECLEAR_ENRICHMENT_INPUT_INVALID");
    seen.add(row.measuredAt);
  }
  const result:EclearEnrichmentPreview={
    total:measurements.length,newMeasurements:0,enrichMeasurements:0,enrichCells:0,
    sameCells:0,conflictMeasurements:0,missingCells:0,unchangedMeasurements:0,
    classifications:[]
  };
  const snapshots:EclearEnrichmentSnapshot[]=[];
  for(const [index,incoming] of measurements.entries()){
    const found=await db.prepare(
      "SELECT id,source_id,measured_at,weight_kg,body_fat_pct,"+
      "skeletal_muscle_pct,bmi,visceral_fat_level,bone_mass_kg,basal_metabolism_kcal"+
      // A date-only source may denote the same physical observation. Do not
      // silently create a second measurement before its origin is reviewed.
      " FROM body_measurements WHERE owner_id=? AND (measured_at=? OR measured_at=?)"+
      " ORDER BY CASE WHEN source_id='csv:eclear' AND measured_at=? THEN 0 ELSE 1 END,id LIMIT 3"
    ).bind(owner,incoming.measuredAt,incoming.measuredAt.slice(0,10),incoming.measuredAt).all<StoredMeasurement>();
    if(!Array.isArray(found.results))throw Error("ECLEAR_ENRICHMENT_DB_UNAVAILABLE");
    snapshots.push({incoming,existing:found.results});
    // Only the identical physical timestamp qualifies as the canonical row.
    const matches=found.results.filter(r=>r.source_id==="csv:eclear" && r.measured_at===incoming.measuredAt);
    const nullCells=ECLEAR_FIELDS.filter(([name])=>incoming[name]===null).length;
    result.missingCells+=nullCells;
    if(found.results.length===0){
      result.newMeasurements++;
      result.classifications.push({line:index+2,status:"new",enrichFields:[],conflictFields:[]});
      continue;
    }
    // Never join to manual/date-only/unknown-source rows.
    if(matches.length!==1){
      result.conflictMeasurements++;
      result.classifications.push({
        line:index+2,status:"conflict",enrichFields:[],conflictFields:[],
        reason:matches.length>1?"ambiguous_eclear":
          found.results.some(r=>r.measured_at===incoming.measuredAt.slice(0,10))
            ?"date_only_source":"non_eclear_source"
      });
      continue;
    }
    const stored=matches[0];
    const enrichFields:Field[]=[],conflictFields:Field[]=[];
    let sameFields=0;
    for(const [input,dbField] of ECLEAR_FIELDS){
      const next=incoming[input],previous=stored[dbField];
      if(next===null)continue; // A CSV blank never erases a saved value.
      if(previous===null)enrichFields.push(input);
      else if(previous===next)sameFields++;
      else conflictFields.push(input); // Non-NULL values never auto-overwrite.
    }
    result.sameCells+=sameFields;
    if(conflictFields.length){
      result.conflictMeasurements++;
      result.classifications.push({
        line:index+2,status:"conflict",enrichFields,conflictFields,
        reason:"existing_value_conflict"
      });
    }else if(enrichFields.length){
      result.enrichMeasurements++;
      result.enrichCells+=enrichFields.length;
      result.classifications.push({line:index+2,status:"enrich",enrichFields,conflictFields});
    }else{
      result.unchangedMeasurements++;
      result.classifications.push({line:index+2,status:"unchanged",enrichFields,conflictFields});
    }
  }
  return {preview:result,snapshots};
}

/** Stage 2A public summary intentionally contains no D1 measurements. */
export async function previewEclearEnrichment(
  db:Pick<ImportDb,"prepare">,owner:string,measurements:readonly EclearCompositionMeasurement[]
):Promise<EclearEnrichmentPreview>{
  return (await readEclearEnrichmentPlan(db,owner,measurements)).preview;
}
