import { describe, expect, it } from "vitest";
import { computeDelta } from "../src/delta";
import type { UnitListing } from "../src/types";

function unit(unitNumber: string | null, price: number): UnitListing {
  return {
    unitNumber,
    floorplanName: "A1",
    beds: 1,
    baths: 1,
    sqft: 700,
    price,
    availableDate: null,
  };
}

describe("computeDelta", () => {
  it("reports nothing on the first snapshot", () => {
    const d = computeDelta(null, [unit("101", 2000)], null, "2026-08-03T00:00:00Z");
    expect(d.newUnits).toHaveLength(0);
    expect(d.removedUnits).toHaveLength(0);
    expect(d.priceChanges).toHaveLength(0);
  });

  it("detects new, removed, and price-changed units", () => {
    const prev = [unit("101", 2000), unit("202", 2500), unit("303", 3000)];
    const curr = [unit("101", 2100), unit("303", 3000), unit("404", 4000)];
    const d = computeDelta(prev, curr, "t0", "t1");
    expect(d.newUnits.map((u) => u.unitNumber)).toEqual(["404"]);
    expect(d.removedUnits.map((u) => u.unitNumber)).toEqual(["202"]);
    expect(d.priceChanges).toEqual([
      { unitNumber: "101", floorplanName: "A1", from: 2000, to: 2100 },
    ]);
  });

  it("ignores floorplan-only listings (null unitNumber)", () => {
    const d = computeDelta([unit(null, 2000)], [unit(null, 2100)], "t0", "t1");
    expect(d.newUnits).toHaveLength(0);
    expect(d.removedUnits).toHaveLength(0);
    expect(d.priceChanges).toHaveLength(0);
  });
});
