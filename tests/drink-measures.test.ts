import { describe, expect, it } from "vitest";
import {
  drinkVariant, storedDrinkKind, equivalentNormalServings, pureAlcoholGrams,
  isDrinkKind, isDrinkSize, parseDrinkCupsInput, referenceMl, validDrinkAmounts,
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
