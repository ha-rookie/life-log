import { normalizeLegacyDrinking } from "./legacy";

export type ImportKind = "lifestyle" | "eclear";
export type ImportRow =
  | { kind: "lifestyle"; line: number; key: string; localDay: string; steps: number | null; weightKg: number | null; drinkingPresence: 0 | 1 | null; drinkCups: number | null }
  | { kind: "eclear"; line: number; key: string; measuredAt: string; weightKg: number | null; bodyFatPct: number | null; skeletalMusclePct: number | null };

export type ImportPreview = {
  kind: ImportKind;
  columns: string[];
  rows: ImportRow[];
  errors: { line: number; code: string }[];
  totalRows: number;
};
export class CsvIssue extends Error {
  constructor(public readonly code: string) { super(code); }
}
export const CSV_MAX_BYTES = 30000;
export const CSV_MAX_ROWS = 30;

function tokenize(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, "");
  if (new TextEncoder().encode(input).byteLength > CSV_MAX_BYTES) throw new CsvIssue("FILE_TOO_LARGE");
  const result: string[][] = [];
  let cells: string[] = [], field = "", quoted = false, closed = false;
  const finish = () => { cells.push(field); field = ""; closed = false; };
  const line = () => {
    finish();
    if (cells.some(v => v.trim() !== "")) result.push(cells);
    cells = [];
    if (result.length > CSV_MAX_ROWS + 1) throw new CsvIssue("TOO_MANY_ROWS");
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === ",") finish();
    else if (char === "\n" || char === "\r") {
      line();
      if (char === "\r" && input[i + 1] === "\n") i++;
    } else if (char === '"') {
      if (field !== "" || closed) throw new CsvIssue("MALFORMED_QUOTE");
      quoted = true;
    } else if (closed) {
      if (char !== " " && char !== "\t") throw new CsvIssue("MALFORMED_QUOTE");
    } else field += char;
  }
  if (quoted) throw new CsvIssue("MALFORMED_QUOTE");
  if (field !== "" || cells.length > 0 || closed) line();
  if (result.length < 2) throw new CsvIssue("NO_DATA");
  return result;
}
function day(value: string): string {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value.trim());
  if (!m) throw new CsvIssue("INVALID_DATE");
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const parsed = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || y > 2100 || parsed.getUTCFullYear() !== y || parsed.getUTCMonth() + 1 !== mo || parsed.getUTCDate() !== d)
    throw new CsvIssue("INVALID_DATE");
  return [String(y), String(mo).padStart(2, "0"), String(d).padStart(2, "0")].join("-");
}
function clock(value: string): string {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? "0") > 59) throw new CsvIssue("INVALID_TIME");
  return String(Number(m[1])).padStart(2, "0") + ":" + m[2] + ":" + (m[3] ?? "00");
}
function numeric(raw: string, max: number, integer = false): number | null {
  const value = raw.trim();
  if (value === "") return null;
  if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new CsvIssue("INVALID_NUMBER");
  const n = Number(value);
  if (!Number.isFinite(n) || n > max || (integer && !Number.isInteger(n))) throw new CsvIssue("OUT_OF_RANGE");
  return n;
}
function weight(raw: string): number | null {
  const n = numeric(raw, 499);
  if (n === 0) throw new CsvIssue("OUT_OF_RANGE");
  return n;
}

export function previewCsv(csv: string): ImportPreview {
  const records = tokenize(csv);
  const columns = records[0].map(s => s.trim());
  if (new Set(columns).size !== columns.length || columns.includes("")) throw new CsvIssue("INVALID_COLUMNS");
  const kind: ImportKind = columns.includes("日付") ? "lifestyle" : columns.includes("年月日") ? "eclear" : (() => { throw new CsvIssue("UNKNOWN_FORMAT"); })();
  const required = kind === "lifestyle" ? ["日付", "飲酒"] : ["年月日", "時刻", "体重"];
  if (!required.every(x => columns.includes(x))) throw new CsvIssue("REQUIRED_COLUMN_MISSING");
  const get = (line: string[], name: string) => {
    const index = columns.indexOf(name);
    return index < 0 ? "" : (line[index] ?? "");
  };
  const rows: ImportRow[] = [], errors: ImportPreview["errors"] = [];
  const encountered = new Set<string>();
  for (const [i, record] of records.slice(1).entries()) {
    const line = i + 2;
    try {
      if (record.length !== columns.length) throw new CsvIssue("COLUMN_COUNT");
      let row: ImportRow;
      if (kind === "lifestyle") {
        const localDay = day(get(record, "日付"));
        const drinking = normalizeLegacyDrinking(get(record, "飲酒"));
        row = {
          kind, line, key: localDay, localDay,
          steps: numeric(get(record, "歩数"), 150000, true),
          weightKg: weight(get(record, "体重_kg")),
          drinkingPresence: drinking.presence, drinkCups: drinking.cups,
        };
      } else {
        const measuredAt = day(get(record, "年月日")) + "T" + clock(get(record, "時刻")) + "+09:00";
        row = {
          kind, line, key: measuredAt, measuredAt,
          weightKg: weight(get(record, "体重")),
          bodyFatPct: numeric(get(record, "体脂肪率"), 100),
          skeletalMusclePct: numeric(get(record, "骨格筋率"), 100),
        };
        if (row.weightKg === null && row.bodyFatPct === null && row.skeletalMusclePct === null)
          throw new CsvIssue("EMPTY_MEASUREMENT");
      }
      if (encountered.has(row.key)) throw new CsvIssue("DUPLICATE_IN_FILE");
      encountered.add(row.key);
      rows.push(row);
    } catch (error) {
      errors.push({ line, code: error instanceof CsvIssue ? error.code : "INVALID_ROW" });
    }
  }
  return { kind, columns, rows, errors, totalRows: records.length - 1 };
}

export async function csvSha256(csv: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(csv));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
