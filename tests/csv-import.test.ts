import { describe, expect, it, vi } from "vitest";
import { previewCsv, hash } from "../src/shared/csv-import";
import { handleImport, type ImportDb } from "../src/worker/import";
import { normalizeOfficialCsv, originalUtf8Proof } from "../src/shared/source-adapter";

const life = "local_day,drinking_presence,drink_cups,steps\n"
  + "2026-01-02,1,,\n2026-01-03,0,0,0\n2026-01-04,,,\n";
const eclear = "measured_at,weight_kg,body_fat_pct\n"
  + "2026-01-02T07:00:00+09:00,72.2,22.5\n";

const request = (path: string, body: unknown, contentType = "application/json") =>
  new Request("https://example.invalid/api/import/" + path, {
    method: "POST", headers: { "Content-Type": contentType },
    body: JSON.stringify(body),
  });
function blockedDb() {
  const prepare = vi.fn(() => { throw Error("UNEXPECTED_DB_ACCESS"); });
  const batch = vi.fn(async () => { throw Error("UNEXPECTED_DB_WRITE"); });
  return { db: { prepare, batch } as ImportDb, prepare, batch };
}

describe("synthetic canonical CSV mapping", () => {
  it("parses date-only weight without inventing measured time, keeps 0 invalid",async()=>{
    const csv="local_day,weight_kg\n2020-05-28,73.40\n2026-05-29,75.60\n";
    const p=await previewCsv("weight_day",csv);
    expect(p.errors).toEqual([]);
    expect(p.rows.map(r=>({day:r.day,weight:r.weight,timestamp:r.timestamp??null})))
      .toEqual([
        {day:"2020-05-28",weight:73.4,timestamp:null},
        {day:"2026-05-29",weight:75.6,timestamp:null},
      ]);
    const bad=await previewCsv("weight_day",
      "local_day,weight_kg\n2026-02-30,73\n2026-05-29,0\n");
    expect(bad.errors).toHaveLength(2);
  });

  it("distinguishes missing from explicit zero and retains source row identity", async () => {
    const p = await previewCsv("lifestyle", life);
    expect(p.errors).toEqual([]);
    expect(p.rows).toHaveLength(3);
    expect([p.rows[0].presence, p.rows[0].cups, p.rows[0].steps]).toEqual([1, null, null]);
    expect([p.rows[1].presence, p.rows[1].cups, p.rows[1].steps]).toEqual([0, 0, 0]);
    expect([p.rows[2].presence, p.rows[2].cups, p.rows[2].steps]).toEqual([null, null, null]);
    expect(p.rows.map(r => r.line)).toEqual([2, 3, 4]);
    expect(p.rows[0].key).toContain(p.hash);
  });
  it("validates canonical Fit steps and rejects invalid/duplicate dates",async()=>{
    const fit="local_day,steps\n2026-01-01,0\n2026-01-02,\n2026-01-03,5432\n";
    const p=await previewCsv("fit",fit);
    expect(p.errors).toEqual([]);
    expect(p.rows.map(r=>r.steps)).toEqual([0,null,5432]);
    expect((await previewCsv("fit",fit+"2026-02-30,10\n2026-01-04,-1\n")).errors).toHaveLength(2);
    await expect(previewCsv("fit","local_day,weight_kg\n2026-01-01,20")).rejects.toThrow();
  });
  it("rejects wrong header, duplicate columns, malformed and unclosed quotes", async () => {
    await expect(previewCsv("eclear", "x,y\n3,4")).rejects.toThrow();
    await expect(previewCsv("lifestyle", "local_day,steps,steps,steps\n2026-01-01,0,0,0")).rejects.toThrow();
    await expect(previewCsv("eclear", 'measured_at,weight_kg,body_fat_pct\n"oops,72,20')).rejects.toThrow();
    await expect(previewCsv("eclear", 'measured_at,weight_kg,body_fat_pct\n"oops"x,72,20')).rejects.toThrow();
  });
  it("reports invalid calendar days, inconsistent drinking and negative steps", async () => {
    const csv = life + "2026-02-30,1,2,100\n2026-01-05,,0,0\n2026-01-06,0,,\n2026-01-07,1,0,25\n2026-01-08,1,1,-1\n";
    const p = await previewCsv("lifestyle", csv);
    expect(p.errors).toHaveLength(5);
  });
  it("rejects invalid ECLEAR weight and out-of-range body fat", async () => {
    const p = await previewCsv("eclear", eclear + "2026-01-04T09:00:00+09:00,0,10\n"
      + "2026-01-05T09:00:00+09:00,72,101\n");
    expect(p.rows).toHaveLength(1);
    expect(p.errors).toHaveLength(2);
  });
  it("keeps different same-day measurements and cross-file fingerprint matches", async () => {
    const longer = eclear + "2026-01-02T21:00:00+09:00,72.5,23\n";
    const a = await previewCsv("eclear", eclear);
    const b = await previewCsv("eclear", longer);
    expect(a.hash).not.toBe(b.hash);
    expect(a.rows[0].fingerprint).toBe(b.rows[0].fingerprint);
    expect(b.rows[0].fingerprint).not.toBe(b.rows[1].fingerprint);
    expect(await hash(eclear)).toBe(a.hash);
  });
  it("rejects invalid length, NUL and BOM without normalization to zero", async () => {
    await expect(previewCsv("lifestyle", "x".repeat(65537))).rejects.toThrow();
    await expect(previewCsv("lifestyle", "\uFEFF" + life)).rejects.toThrow();
    await expect(previewCsv("lifestyle", life + "\0")).rejects.toThrow();
  });
});

describe("bounded UTF-8 original-byte provenance before D1 access (#209)",()=>{
  const original="\uFEFF日付,飲酒,歩数\r\n2026/01/02,1,0\r\n2026/01/03,0,\r\n";
  it("verifies original BOM and CRLF, independently re-normalizes, and leaves preview read-only",async()=>{
    const proof=await originalUtf8Proof(new TextEncoder().encode(original));
    const canonical=normalizeOfficialCsv("lifestyle",original).parts[0];
    const db=blockedDb();
    const res=await handleImport(request("preview",{
      source:"lifestyle",csv:canonical,hash:await hash(canonical),...proof
    }),db.db,"owner");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({source:"lifestyle",total:2,
      originalByteEvidence:"verified_only_not_saved"});
    const lf=await originalUtf8Proof(new TextEncoder().encode(original.replaceAll("\r\n","\n")));
    const noBom=await originalUtf8Proof(new TextEncoder().encode(original.replace("\uFEFF","")));
    expect(proof.originalSha256).not.toBe(lf.originalSha256);
    expect(proof.originalSha256).not.toBe(noBom.originalSha256);
    expect(normalizeOfficialCsv("lifestyle",original.replaceAll("\r\n","\n")).parts[0])
      .toBe(canonical);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });
  it("rejects unverified raw hashes, false matching canonical payloads, invalid base64/UTF-8 and multipart before D1",async()=>{
    const proof=await originalUtf8Proof(new TextEncoder().encode(original));
    const canonical=normalizeOfficialCsv("lifestyle",original).parts[0];
    const normalized=normalizeOfficialCsv("lifestyle",
      "日付,飲酒,歩数\n"+Array.from({length:9},(_,i)=>
        "2026/02/"+String(i+1).padStart(2,"0")+",0,0").join("\n")+"\n");
    const many="日付,飲酒,歩数\n"+Array.from({length:9},(_,i)=>
      "2026/02/"+String(i+1).padStart(2,"0")+",0,0").join("\n")+"\n";
    const multipart=await originalUtf8Proof(new TextEncoder().encode(many));
    expect(normalized.parts).toHaveLength(2);
    const garbage=Uint8Array.of(0x81,0xff,0x20);
    const rawSha=[...new Uint8Array(await crypto.subtle.digest("SHA-256",garbage))]
      .map(n=>n.toString(16).padStart(2,"0")).join("");
    const cases=[
      {...proof,originalSha256:"0".repeat(64)},
      {...proof,originalBase64:proof.originalBase64+"="},
      {...proof,originalBase64:proof.originalBase64.slice(0,-2)+"_="},
      {...proof,csv:canonical+"2026-01-05,1,,0\n"},
      {originalBase64:btoa(String.fromCharCode(...garbage)),originalSha256:rawSha},
      {...multipart,csv:normalized.parts[0]},
    ];
    const db=blockedDb();
    for(const item of cases){
      const res=await handleImport(request("confirm",{
        source:"lifestyle",csv:canonical,confirmed:true,hash:await hash(canonical),...item
      }),db.db,"owner");
      expect(res.ok).toBe(false);
    }
    expect((await handleImport(request("confirm",{
      source:"lifestyle",csv:canonical,hash:await hash(canonical),confirmed:true,
      originalBase64:proof.originalBase64
    }),db.db,"owner")).status).toBe(400);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });
  it("rejects original Shift_JIS and UTF-16 bytes rather than fabricating UTF-8 proof",async()=>{
    await expect(originalUtf8Proof(Uint8Array.of(0x81,0x30))).rejects.toThrow();
    await expect(originalUtf8Proof(Uint8Array.of(0xff,0xfe,0x61,0x00))).rejects.toThrow();
    await expect(originalUtf8Proof(new Uint8Array())).rejects.toThrow();
  });
});

describe("server-side CSV validation before DB access", () => {
  it("preview is read-only and does not require a write decision", async () => {
    const f = blockedDb();
    const res = await handleImport(request("preview", { source: "lifestyle", csv: life }), f.db, "owner");
    expect(res.status).toBe(200);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.batch).not.toHaveBeenCalled();
  });
  it("rejects missing explicit approval or wrong CSV hash", async () => {
    const f = blockedDb();
    for (const body of [
      { source: "lifestyle", csv: life, hash: await hash(life) },
      { source: "lifestyle", csv: life, confirmed: false, hash: await hash(life) },
      { source: "lifestyle", csv: life, confirmed: true, hash: "0".repeat(64) },
    ]) {
      expect((await handleImport(request("confirm", body), f.db, "owner")).status).toBe(409);
    }
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("blocks unsupported resolution mode, forged token, ECLEAR resolution", async () => {
    const f = blockedDb();
    const base = { source: "lifestyle", csv: life, hash: await hash(life), confirmed: true };
    expect((await handleImport(request("confirm", { ...base, resolution: { mode: "replace", token: "0".repeat(64) } }), f.db, "owner")).status).toBe(400);
    expect((await handleImport(request("confirm", { ...base, resolution: { mode: "keep_existing", token: "bad" } }), f.db, "owner")).status).toBe(400);
    const ec = { source: "eclear", csv: eclear, hash: await hash(eclear), confirmed: true,
      resolution: { mode: "keep_existing", token: "0".repeat(64) } };
    expect((await handleImport(request("confirm", ec), f.db, "owner")).status).toBe(409);
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("rejects malformed rows and duplicate days before any DB access", async () => {
    const f = blockedDb();
    for (const csv of [
      life + "2026-01-05,0,,\n",
      life + "2026-01-02,1,,\n",
    ]) {
      const r = await handleImport(request("confirm",
        { source: "lifestyle", csv, hash: await hash(csv), confirmed: true }), f.db, "owner");
      expect(r.status).toBe(422);
    }
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("rejects unsupported media type and broken JSON", async () => {
    const f = blockedDb();
    expect((await handleImport(request("confirm", {}, "text/plain"), f.db, "owner")).status).toBe(415);
    const broken = new Request("https://example.invalid/api/import/confirm",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect((await handleImport(broken, f.db, "owner")).status).toBe(400);
    expect(f.prepare).not.toHaveBeenCalled();
  });
});
