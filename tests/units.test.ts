import { describe, expect, it } from "vitest";
import { parseUnitCode } from "@/lib/units/code";
import { inferLines } from "@/lib/scrape/runner";

describe("parseUnitCode", () => {
  it("splits <floor><line> using a known line vocabulary", () => {
    const lines = ["01", "02", "03", "04", "05", "06", "07", "08"];
    expect(parseUnitCode("3208", lines)).toMatchObject({ floor: 32, line: "08" });
    expect(parseUnitCode("0512", lines)?.floor).toBe(5);
    expect(parseUnitCode("905", lines)).toMatchObject({ floor: 9, line: "05" });
  });

  it("marks the split exact only when it matches a known line", () => {
    expect(parseUnitCode("3208", ["08"])?.confidence).toBe("exact");
    expect(parseUnitCode("3277", ["08"])?.confidence).toBe("guess");
    expect(parseUnitCode("3208", [])?.confidence).toBe("inferred");
  });

  it("defaults to a two-digit line with no vocabulary", () => {
    expect(parseUnitCode("3208")).toMatchObject({ floor: 32, line: "08" });
  });

  it("strips the noise words sites put in front of unit numbers", () => {
    expect(parseUnitCode("Unit 3208")).toMatchObject({ floor: 32, line: "08" });
    expect(parseUnitCode("#3208")).toMatchObject({ floor: 32, line: "08" });
    expect(parseUnitCode("Apt. 3208")).toMatchObject({ floor: 32, line: "08" });
  });

  it("honours an explicit separator", () => {
    expect(parseUnitCode("32-08")).toMatchObject({
      floor: 32,
      line: "08",
      confidence: "exact",
    });
  });

  it("captures penthouse and wing designators", () => {
    // A penthouse label names the line but not the storey.
    expect(parseUnitCode("PH02", ["02"])).toMatchObject({
      floor: null,
      line: "02",
      penthouse: true,
    });
    expect(parseUnitCode("N1204", ["04"])).toMatchObject({ wing: "N", floor: 12 });
    expect(parseUnitCode("1204S", ["04"])).toMatchObject({ wing: "S", floor: 12 });
  });

  it("returns null for labels with no floor information", () => {
    expect(parseUnitCode("Garden A")).toBeNull();
    expect(parseUnitCode("")).toBeNull();
    expect(parseUnitCode("Loft")).toBeNull();
  });

  it("rejects splits that exceed the building's height", () => {
    expect(parseUnitCode("9908", [], { topFloor: 40 })?.floor).not.toBe(99);
  });
});

describe("inferLines", () => {
  it("recovers a two-digit line vocabulary from unit labels", () => {
    const codes: string[] = [];
    for (let floor = 4; floor <= 38; floor++) {
      for (const line of ["01", "02", "03", "04", "05", "06", "07", "08"]) {
        codes.push(`${floor}${line}`);
      }
    }
    const lines = inferLines(codes);
    expect(lines.sort()).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"]);
  });

  it("returns nothing useful from labels that are too short", () => {
    expect(inferLines(["1", "2", "3"])).toEqual([]);
  });
});
