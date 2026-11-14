import {describe,it,expect} from "vitest";
import {manualHistoryRange} from "../src/shared/manual-history";
describe("older manual weight and steps history",()=>{
  it("uses exact inclusive 30-day JST windows across month and leap boundaries",()=>{
    expect(manualHistoryRange("2026-09-30","2026-11-14")).toEqual({from:"2026-09-01",to:"2026-09-30"});
    expect(manualHistoryRange("2024-03-01","2026-11-14")).toEqual({from:"2024-02-01",to:"2024-03-01"});
    expect(manualHistoryRange("2026-11-14","2026-11-14")).toEqual({from:"2026-10-16",to:"2026-11-14"});
  });
  it("rejects empty, impossible and future range dates",()=>{
    for(const s of ["","2026-02-30","2026-13-01","2026-11-15","2026-11-14T10:00","abc"]){
      expect(manualHistoryRange(s,"2026-11-14")).toBeNull();
    }
  });
});
