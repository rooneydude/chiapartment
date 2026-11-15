import { describe, expect, it } from "vitest";
import { parseAvailableDate, parseLeaseTermMonths, parseUnitNumber, stackFromPlan } from "../src/parse";
import { UnitMappingSchema } from "../src/types";

const floorPrefix = UnitMappingSchema.parse({ scheme: "floor-prefix" });

describe("parseUnitNumber (floor-prefix)", () => {
  it("splits a 4-digit unit into floor + stack", () => {
    expect(parseUnitNumber("2314", floorPrefix)).toEqual({ floor: 23, stack: "14" });
  });

  it("splits a 3-digit unit", () => {
    expect(parseUnitNumber("314", floorPrefix)).toEqual({ floor: 3, stack: "14" });
  });

  it("tolerates prefixes and letter suffixes", () => {
    expect(parseUnitNumber("Unit 1204A", floorPrefix)).toEqual({ floor: 12, stack: "04" });
  });

  it("returns nulls when digits are too short to contain a floor", () => {
    expect(parseUnitNumber("07", floorPrefix)).toEqual({ floor: null, stack: null });
  });

  it("returns nulls for non-numeric units and null input", () => {
    expect(parseUnitNumber("PH", floorPrefix)).toEqual({ floor: null, stack: null });
    expect(parseUnitNumber(null, floorPrefix)).toEqual({ floor: null, stack: null });
  });

  it("applies floorOffset", () => {
    const m = UnitMappingSchema.parse({ scheme: "floor-prefix", floorOffset: 2 });
    expect(parseUnitNumber("314", m)).toEqual({ floor: 5, stack: "14" });
  });
});

describe("parseAvailableDate", () => {
  const ref = new Date("2026-08-03T12:00:00Z");

  it("maps now/available/today to the reference date", () => {
    expect(parseAvailableDate("Available Now", ref)).toBe("2026-08-03");
    expect(parseAvailableDate("Available", ref)).toBe("2026-08-03");
    expect(parseAvailableDate("today", ref)).toBe("2026-08-03");
  });

  it("parses month-day with current year", () => {
    expect(parseAvailableDate("Available Aug 15", ref)).toBe("2026-08-15");
    expect(parseAvailableDate("Sep. 1st", ref)).toBe("2026-09-01");
  });

  it("keeps explicit years and ISO dates", () => {
    expect(parseAvailableDate("Aug 15, 2027", ref)).toBe("2027-08-15");
    expect(parseAvailableDate("2026-10-09", ref)).toBe("2026-10-09");
  });

  it("infers next year when the date already passed (with grace)", () => {
    expect(parseAvailableDate("Jan 15", ref)).toBe("2027-01-15"); // long past
    expect(parseAvailableDate("Jul 30", ref)).toBe("2026-07-30"); // within 7-day grace
  });

  it("returns null for garbage", () => {
    expect(parseAvailableDate("call for details", ref)).toBeNull();
    expect(parseAvailableDate(null, ref)).toBeNull();
    expect(parseAvailableDate(undefined, ref)).toBeNull();
    expect(parseAvailableDate("not available", ref)).toBeNull();
  });

  // Old Town Park prints future move-in days as M/D/YYYY. The parser used to
  // know only "Mon DD", so every future-dated unit lost its date.
  it("parses US numeric dates (the Old Town Park format)", () => {
    const nov = new Date("2026-11-15T14:00:00Z");
    expect(parseAvailableDate("12/18/2026", nov)).toBe("2026-12-18");
    expect(parseAvailableDate("1/2/2027", nov)).toBe("2027-01-02");
    expect(parseAvailableDate("11/26/2026", nov)).toBe("2026-11-26");
    expect(parseAvailableDate("Available 12/7/2026", nov)).toBe("2026-12-07");
    expect(parseAvailableDate("1/22/27", nov)).toBe("2027-01-22");
    expect(parseAvailableDate("12-18-2026", nov)).toBe("2026-12-18");
  });

  it("infers the year for a numeric month/day", () => {
    const nov = new Date("2026-11-15T14:00:00Z");
    expect(parseAvailableDate("12/18", nov)).toBe("2026-12-18");
    expect(parseAvailableDate("1/5", nov)).toBe("2027-01-05"); // already past this year
    expect(parseAvailableDate("11/10", nov)).toBe("2026-11-10"); // within the grace week
  });

  it("parses ordinal and long month names (the SightMap display format)", () => {
    const nov = new Date("2026-11-15T14:00:00Z");
    expect(parseAvailableDate("Available Dec 26th", nov)).toBe("2026-12-26");
    expect(parseAvailableDate("Available Jan 1st", nov)).toBe("2027-01-01");
    expect(parseAvailableDate("December 26, 2026", nov)).toBe("2026-12-26");
    expect(parseAvailableDate("Move-in: Nov 22nd", nov)).toBe("2026-11-22");
  });

  it("rejects impossible calendar days instead of rolling them over", () => {
    expect(parseAvailableDate("2/31/2027", ref)).toBeNull();
    expect(parseAvailableDate("2026-02-31", ref)).toBeNull();
    expect(parseAvailableDate("13/5/2026", ref)).toBeNull();
  });

  it("treats 'now' as the CHICAGO day, even after UTC has rolled over", () => {
    // 02:30 UTC on Nov 16 is 8:30 pm on Nov 15 in Chicago.
    const lateEvening = new Date("2026-11-16T02:30:00Z");
    expect(parseAvailableDate("Available Now", lateEvening)).toBe("2026-11-15");
    expect(parseAvailableDate("Available", lateEvening)).toBe("2026-11-15");
    expect(parseAvailableDate("available now!", lateEvening)).toBe("2026-11-15");
  });
});

describe("stackFromPlan", () => {
  const m = UnitMappingSchema.parse({
    scheme: "floor-prefix",
    stackFromPlanRegex: "Unit\\s*0?(\\d{1,2})\\b",
  });

  it("extracts and zero-pads the stack", () => {
    expect(stackFromPlan("Large Studio - Unit 01", m)).toBe("01");
    expect(stackFromPlan("Medium 1BR - Unit 3", m)).toBe("03");
    expect(stackFromPlan("Large 1BR - Unit 12", m)).toBe("12");
  });

  it("misses cleanly", () => {
    expect(stackFromPlan("A1", m)).toBeNull();
    expect(stackFromPlan("A1", UnitMappingSchema.parse({}))).toBeNull();
  });
});

describe("parseUnitNumber (regex)", () => {
  it("uses named groups", () => {
    const m = UnitMappingSchema.parse({
      scheme: "regex",
      regex: "^T\\d-(?<floor>\\d+)(?<stack>\\d{2})$",
    });
    expect(parseUnitNumber("T2-1805", m)).toEqual({ floor: 18, stack: "05" });
  });

  it("returns nulls when the pattern misses", () => {
    const m = UnitMappingSchema.parse({ scheme: "regex", regex: "(?<floor>\\d+)-X" });
    expect(parseUnitNumber("1204", m)).toEqual({ floor: null, stack: null });
  });
});

describe("parseLeaseTermMonths", () => {
  it("parses common term labels", () => {
    expect(parseLeaseTermMonths("14 Months")).toBe(14);
    expect(parseLeaseTermMonths("12-month lease")).toBe(12);
    expect(parseLeaseTermMonths("Lease term: 13 mo")).toBe(13);
    expect(parseLeaseTermMonths("16 Months ")).toBe(16);
  });
  it("rejects junk", () => {
    expect(parseLeaseTermMonths(null)).toBeNull();
    expect(parseLeaseTermMonths("")).toBeNull();
    expect(parseLeaseTermMonths("Available Aug 15")).toBeNull();
    expect(parseLeaseTermMonths("99 months")).toBeNull();
  });
});

describe("parseAvailableDate never invents a date", () => {
  const on = (day: string) => new Date(`${day}T18:00:00Z`);

  it("does not read the start of a year, a quantity or an ordinary word as a day", () => {
    const ref = on("2026-11-15");
    // A month and a year name no day.
    expect(parseAvailableDate("Available December 2026", ref)).toBeNull();
    expect(parseAvailableDate("Available January 2028", ref)).toBeNull();
    // Quantities are not dates.
    expect(parseAvailableDate("Available in 1-2 weeks", ref)).toBeNull();
    expect(parseAvailableDate("1/2 month free", ref)).toBeNull();
    expect(parseAvailableDate("2/2 bath", ref)).toBeNull();
    // A word that merely starts like a month.
    expect(parseAvailableDate("Junior 1 Bedroom", ref)).toBeNull();
    expect(parseAvailableDate("Marble 12 counters", ref)).toBeNull();
    // Real dates still parse, in every form the sites use.
    expect(parseAvailableDate("Available December 26, 2026", ref)).toBe("2026-12-26");
    expect(parseAvailableDate("Dec. 26th", ref)).toBe("2026-12-26");
    expect(parseAvailableDate("12/10/2026", ref)).toBe("2026-12-10");
    expect(parseAvailableDate("12-10-2026", ref)).toBe("2026-12-10");
    expect(parseAvailableDate("1/2/27", ref)).toBe("2027-01-02");
    expect(parseAvailableDate("12/18", ref)).toBe("2026-12-18");
    expect(parseAvailableDate("Sept 5", on("2026-08-01"))).toBe("2026-09-05");
    expect(parseAvailableDate("May 3", on("2026-04-01"))).toBe("2026-05-03");
  });

  it("reads a year-less date just after New Year as the day that just passed", () => {
    // Seen on 2 Jan 2027, "Dec 28" was five days ago — not next December.
    expect(parseAvailableDate("Dec 28", on("2027-01-02"))).toBe("2026-12-28");
    expect(parseAvailableDate("12/30", on("2027-01-02"))).toBe("2026-12-30");
    // And one that is further back than a week means the coming one.
    expect(parseAvailableDate("Dec 20", on("2027-01-02"))).toBe("2027-12-20");
    // Just before New Year, January is next month.
    expect(parseAvailableDate("Jan 5", on("2026-12-20"))).toBe("2027-01-05");
    expect(parseAvailableDate("Feb 29", on("2027-06-01"))).toBe("2028-02-29");
  });
});
