import {describe,expect,it} from "vitest";
import {defaultCompletedDay,jstCalendarDay} from "../src/client/entry-date";

describe("JST completed-day defaults",()=>{
  it("uses the previous JST calendar day, even at 00:00 local",()=>{
    const midnight=Date.parse("2026-11-19T15:00:00Z"); // Nov 20, 00:00 JST
    expect(jstCalendarDay(midnight)).toBe("2026-11-20");
    expect(defaultCompletedDay(midnight)).toBe("2026-11-19");
    expect(defaultCompletedDay(Date.parse("2026-11-19T14:59:59Z"))).toBe("2026-11-18");
    expect(defaultCompletedDay(Date.parse("2026-11-19T22:19:00Z"))).toBe("2026-11-19");
  });
  it("rolls across months, years and leap day without UTC date confusion",()=>{
    expect(defaultCompletedDay(Date.parse("2026-01-01T03:00:00Z"))).toBe("2025-12-31");
    expect(defaultCompletedDay(Date.parse("2026-03-01T00:00:00Z"))).toBe("2026-02-28");
    expect(defaultCompletedDay(Date.parse("2024-03-01T00:00:00Z"))).toBe("2024-02-29");
    expect(defaultCompletedDay(Date.parse("2026-11-30T15:00:00Z"))).toBe("2026-11-30");
  });
});
