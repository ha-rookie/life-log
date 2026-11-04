// Values absent from source documents must never be inferred as zero.
export interface Summary {
  latestWeightKg: number | null;
  measuredAt: string | null;
}

export type DrinkingObservation = { presence: 0 | 1 | null; cups: number | null };

export function normalizeLegacyDrinking(raw: string | null | undefined): DrinkingObservation {
  if (raw == null || raw.trim() === "") return { presence: null, cups: null };
  if (raw.trim() === "0") return { presence: 0, cups: 0 }; // Explicit no drinking
  if (raw.trim() === "1") return { presence: 1, cups: null }; // Presence known, cups unknown
  throw new Error("Unrecognized legacy drinking value");
}

export interface ImportRow {
  sourceId: string;
  rowKey: string;
  reliableFingerprint: string | null;
}

// This is only a preview helper: DB constraints are authoritative.
// Cross-source duplicate fingerprints are only used when provenance is reliable.
export function dedupeImportRows<T extends ImportRow>(rows: readonly T[]): { unique: T[]; skipped: number } {
  const sourceKeys = new Set<string>();
  const fingerprints = new Set<string>();
  const unique: T[] = [];
  let skipped = 0;
  for (const row of rows) {
    const key = JSON.stringify([row.sourceId, row.rowKey]);
    if (!row.sourceId || !row.rowKey) throw new Error("Source identity required");
    if (sourceKeys.has(key) || (row.reliableFingerprint !== null && fingerprints.has(row.reliableFingerprint))) {
      skipped++;
      continue;
    }
    sourceKeys.add(key);
    if (row.reliableFingerprint !== null) fingerprints.add(row.reliableFingerprint);
    unique.push(row);
  }
  return { unique, skipped };
}
