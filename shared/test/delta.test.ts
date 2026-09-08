import { describe, expect, it } from "vitest";
import {
  chicagoDate,
  computeDelta,
  computeFocusDelta,
  filterFocusDelta,
  listingKey,
  listingLabel,
  priorChicagoDayRun,
} from "../src/delta";
import type { UnitListing } from "../src/types";

function unit(unitNumber: string | null, price: number, extra?: Partial<UnitListing>): UnitListing {
  return {
    unitNumber,
    floorplanName: extra?.floorplanName ?? "A1",
    beds: extra?.beds ?? 1,
    baths: 1,
    sqft: 700,
    price,
    availableDate: null,
    ...extra,
  };
}

describe("listing identity", () => {
  it("keys real units by number and floorplans by beds+name", () => {
    expect(listingKey(unit("101", 2000))).toBe("u:101");
    expect(listingKey(unit(null, 2200, { floorplanName: "Large Studio - Unit 08", beds: 0 }))).toBe(
      "fp:0:Large Studio - Unit 08",
    );
    expect(listingLabel(unit("0624", 2390))).toBe("#0624");
    expect(listingLabel(unit(null, 2200, { floorplanName: "Large Studio - Unit 08" }))).toBe(
      "Large Studio - Unit 08",
    );
  });
});

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
      { unitNumber: "101", floorplanName: "A1", from: 2000, to: 2100, beds: 1 },
    ]);
  });

  it("tracks floorplan-only listings by name + beds (Stead stacks)", () => {
    const studio = (price: number) =>
      unit(null, price, { floorplanName: "Large Studio - Unit 08", beds: 0 });
    const twoBed = (price: number) =>
      unit(null, price, { floorplanName: "Medium 2BR - Unit 09", beds: 2 });
    const d = computeDelta(
      [studio(2400), twoBed(3600)],
      [studio(2200)],
      "t0",
      "t1",
    );
    expect(d.priceChanges).toEqual([
      {
        unitNumber: "Large Studio - Unit 08",
        floorplanName: "Large Studio - Unit 08",
        from: 2400,
        to: 2200,
        beds: 0,
      },
    ]);
    expect(d.removedUnits.map((u) => u.floorplanName)).toEqual(["Medium 2BR - Unit 09"]);
    expect(d.newUnits).toHaveLength(0);
  });
});

describe("chicago calendar-day", () => {
  it("maps UTC timestamps onto America/Chicago dates", () => {
    expect(chicagoDate("2026-09-08T10:59:10Z")).toBe("2026-09-08");
    // 04:59 UTC is still Sep 7 in Chicago (CDT).
    expect(chicagoDate("2026-09-08T04:59:00Z")).toBe("2026-09-07");
  });

  it("picks the last ok run on a prior Chicago day, skipping same-day extras", () => {
    const runs = [
      { timestamp: "2026-09-07T18:00:00Z" },
      { timestamp: "2026-09-08T10:00:00Z" },
      { timestamp: "2026-09-08T18:00:00Z" },
    ];
    const prior = priorChicagoDayRun(runs, runs[2]!);
    expect(prior?.timestamp).toBe("2026-09-07T18:00:00Z");
  });
});

describe("focus delta", () => {
  it("keeps studios and 2-beds, drops 1BR noise", () => {
    const prev = [
      unit("101", 2400, { beds: 0 }),
      unit("202", 3300, { beds: 1 }),
      unit("303", 4600, { beds: 2 }),
    ];
    const curr = [
      unit("101", 2300, { beds: 0 }),
      unit("202", 3000, { beds: 1 }),
      unit("303", 4600, { beds: 2 }),
      unit("404", 4400, { beds: 2 }),
    ];
    const d = filterFocusDelta(computeDelta(prev, curr, "t0", "t1"), [0, 2]);
    expect(d.priceChanges.map((c) => c.unitNumber)).toEqual(["101"]);
    expect(d.newUnits.map((u) => u.unitNumber)).toEqual(["404"]);
  });

  it("calendar-day focus delta compares yesterday, not a same-day extra scrape", () => {
    const studio = (price: number) => unit("101", price, { beds: 0 });
    const fd = computeFocusDelta(
      [studio(2400)],
      [studio(2400), unit("404", 4400, { beds: 2 })],
      "2026-09-07T18:00:00Z",
      "2026-09-08T18:00:00Z",
      [0, 2],
    );
    expect(fd.chicagoFrom).toBe("2026-09-07");
    expect(fd.chicagoTo).toBe("2026-09-08");
    expect(fd.newUnits.map((u) => u.unitNumber)).toEqual(["404"]);
    expect(fd.focusBeds).toEqual([0, 2]);
  });
});
