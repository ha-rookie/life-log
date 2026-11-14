import { describe, expect, it } from "vitest";
import {
  drinkVariant, storedDrinkKind, equivalentNormalServings, pureAlcoholGrams,
  isDrinkKind, isDrinkSize, parseDrinkCupsInput, parseDrinkLocalDateTime, referenceMl, validDrinkAmounts,
} from "../src/shared/drink-measures";

describe("Android numeric keyboard: cup text draft and save-time validation",()=>{
  it("keeps empty input invalid instead of normalizing it to zero",()=>{
    expect(parseDrinkCupsInput("")).toBeNull();
    expect(parseDrinkCupsInput("0")).toBeNull();
    expect(parseDrinkCupsInput("00")).toBeNull();
  });
  it("accepts only complete integer glasses in the inclusive range 1–50",()=>{
    for(const [raw,want] of [["1",1],["5",5],["10",10],["50",50],["07",7]] as const){
      expect(parseDrinkCupsInput(raw)).toBe(want);
      expect(validDrinkAmounts("highball",parseDrinkCupsInput(raw),350,null)).toBe(true);
    }
    for(const raw of ["51","99","-1","1.5","1e1","1 "," 1","abc","７","5杯"]){
      expect(parseDrinkCupsInput(raw)).toBeNull();
      expect(validDrinkAmounts("highball",parseDrinkCupsInput(raw),350,null)).toBe(false);
    }
  });
});
describe("drink volume and pure alcohol quantity (synthetic only)",()=>{
  it("distinguishes ordered cups from relative 350ml reference serves",()=>{
    expect(equivalentNormalServings({cups:2,volumeMl:referenceMl.mega})).toBe(4);
    expect(equivalentNormalServings({cups:2,volumeMl:referenceMl.large})).toBe(2.9);
    expect(equivalentNormalServings({cups:2,volumeMl:null})).toBeNull();
    expect(equivalentNormalServings({cups:0,volumeMl:350})).toBeNull();
  });
  it("computes pure alcohol only with supplied size AND ABV",()=>{
    expect(pureAlcoholGrams({cups:2,volumeMl:700,abvPct:5,alcohol:1})).toBe(56);
    expect(pureAlcoholGrams({cups:1,volumeMl:350,abvPct:7,alcohol:1})).toBe(19.6);
    expect(pureAlcoholGrams({cups:1,volumeMl:700,abvPct:null,alcohol:1})).toBeNull();
    expect(pureAlcoholGrams({cups:1,volumeMl:null,abvPct:7,alcohol:1})).toBeNull();
    expect(pureAlcoholGrams({cups:1,volumeMl:500,abvPct:0,alcohol:0})).toBe(0);
    expect(pureAlcoholGrams({cups:1,volumeMl:null,abvPct:0,alcohol:0})).toBeNull();
  });
  it("rejects false precision and invalid servings",()=>{
    expect(validDrinkAmounts("beer",1,350,null)).toBe(true);
    expect(validDrinkAmounts("beer",2,700,5)).toBe(true);
    expect(validDrinkAmounts("beer",0,700,5)).toBe(false);
    expect(validDrinkAmounts("beer",1.5,350,5)).toBe(false);
    expect(validDrinkAmounts("beer",51,350,5)).toBe(false);
    expect(validDrinkAmounts("highball",1,-500,7)).toBe(false);
    expect(validDrinkAmounts("highball",1,3001,7)).toBe(false);
    expect(validDrinkAmounts("beer",1,350,101)).toBe(false);
    expect(validDrinkAmounts("highball",1,350,0)).toBe(false);
    expect(validDrinkAmounts("non_alcohol",1,350,5)).toBe(false);
    expect(validDrinkAmounts("non_alcohol",1,350,0)).toBe(true);
    expect(isDrinkKind("beer")).toBe(true);
    expect(isDrinkKind("unknown")).toBe(false);
    expect(isDrinkSize("mega")).toBe(true);
    expect(isDrinkSize("enormous")).toBe(false);
    expect(storedDrinkKind("beer")).toBe("other_alcohol");
    expect(drinkVariant("beer")).toBe("beer");
    expect(drinkVariant("highball")).toBeNull();
  });
});

describe("new drink entry historical JST date/time validation",()=>{
  const now=Date.parse("2026-11-14T12:00:00+09:00");
  it("POST carries the selected historical JST date/time instead of submission time",()=>{
    expect(parseDrinkLocalDateTime("2026-11-09T19:30",now)).toBe("2026-11-09T19:30:00+09:00");
    expect(parseDrinkLocalDateTime("2026-11-14T12:00",now)).toBe("2026-11-14T12:00:00+09:00");
    expect(parseDrinkLocalDateTime("2026-11-14T12:01",now)).toBe("2026-11-14T12:01:00+09:00");
  });
  it("blocks blank, malformed, impossible, future and too-old times",()=>{
    for(const raw of ["","2026-11-09","2026-11-09T19:30:00","2026-11-09T19:30Z",
      "2026-02-30T19:30","2026-11-31T19:30","2026-11-14T24:00",
      "2026-11-15T19:30","2025-11-12T19:30"]){
      expect(parseDrinkLocalDateTime(raw,now),raw).toBeNull();
    }
  });
  it("aligns with exact server 366-day window and accepts real leap day",()=>{
    const edge=now-366*86400000;
    const exact=new Date(edge+9*3600000).toISOString().slice(0,16);
    expect(parseDrinkLocalDateTime(exact,now)).toBeNull();
    const inside=new Date(edge+9*3600000+60000).toISOString().slice(0,16);
    expect(parseDrinkLocalDateTime(inside,now)).not.toBeNull();
    expect(parseDrinkLocalDateTime("2024-02-29T19:30",Date.parse("2024-03-02T12:00:00+09:00")))
      .toBe("2024-02-29T19:30:00+09:00");
  });
});
