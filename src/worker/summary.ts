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
