import { describe, expect, it } from "vitest";
import { dedupeImportRows, normalizeLegacyDrinking } from "../src/shared/legacy";

describe("legacy unknown vs zero semantics", () => {
  it("preserves absence and unknown cups instead of manufacturing counts", () => {
    expect(normalizeLegacyDrinking(undefined)).toEqual({ presence: null, cups: null });
    expect(normalizeLegacyDrinking("")).toEqual({ presence: null, cups: null });
    expect(normalizeLegacyDrinking("1")).toEqual({ presence: 1, cups: null });
    expect(normalizeLegacyDrinking("0")).toEqual({ presence: 0, cups: 0 });
    expect(() => normalizeLegacyDrinking("10")).toThrow();
  });
  it("dedupes by source identity or evidence-backed cross-file fingerprint", () => {
    const rows = [
      { sourceId: "eclear", rowKey: "one", reliableFingerprint: "measurement-1" },
      { sourceId: "eclear", rowKey: "one", reliableFingerprint: "measurement-1" },
      { sourceId: "old-txt", rowKey: "different", reliableFingerprint: "measurement-1" },
      { sourceId: "eclear", rowKey: "two", reliableFingerprint: "measurement-2" },
      { sourceId: "old-txt", rowKey: "unknown-fingerprint", reliableFingerprint: null },
      { sourceId: "eclear", rowKey: "unknown-fingerprint", reliableFingerprint: null },
    ];
    const {unique,skipped} = dedupeImportRows(rows);
    expect(unique).toHaveLength(4);
    expect(skipped).toBe(2);
  });
});
