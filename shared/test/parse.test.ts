import { describe, expect, it } from "vitest";
import { parseUnitNumber } from "../src/parse";
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
