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
