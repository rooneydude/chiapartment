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

describe("like-for-like price changes", () => {
  const T0 = "2026-11-14T18:58:17Z";
  const T1 = "2026-11-15T14:00:00Z";
  const terms = (...pairs: [number, number][]) => pairs.map(([months, price]) => ({ months, price }));

  it("does not report a price move when only the headlined lease term switched", () => {
    // Nov 14: capped quote at 14 months. Nov 15: site headline at 18 months,
    // and the lease table shows the 14-month price never moved.
    const prev = [unit("0812", 2409, { beds: 0, leaseTermMonths: 14 })];
    const curr = [
      unit("0812", 2382, {
        beds: 0,
        leaseTermMonths: 18,
        leaseTerms: terms([12, 3846], [14, 2409], [18, 2382]),
      }),
    ];
    const d = computeDelta(prev, curr, T0, T1);
    expect(d.priceChanges).toEqual([]);
  });

  it("reports the real move at the shared term", () => {
    const prev = [unit("0812", 2409, { beds: 0, leaseTermMonths: 14 })];
    const curr = [
      unit("0812", 2382, { beds: 0, leaseTermMonths: 18, leaseTerms: terms([14, 2350], [18, 2382]) }),
    ];
    const d = computeDelta(prev, curr, T0, T1);
    expect(d.priceChanges).toEqual([
      { unitNumber: "0812", floorplanName: "A1", from: 2409, to: 2350, beds: 0, fromTerm: 14, toTerm: 14 },
    ]);
  });

  it("flags a term switch it cannot align, and realPriceChanges drops it", async () => {
    const { realPriceChanges } = await import("../src/delta");
    const prev = [unit("0523", 2283, { beds: 0, leaseTermMonths: 18 })];
    const curr = [unit("0523", 2409, { beds: 0, leaseTermMonths: 14 })];
    const d = computeDelta(prev, curr, T0, T1);
    expect(d.priceChanges).toHaveLength(1);
    expect(d.priceChanges[0]).toMatchObject({ termChangeOnly: true, fromTerm: 18, toTerm: 14 });
    expect(realPriceChanges(d)).toEqual([]);
  });

  it("does not call a unit new when the previous run knew it under another list", () => {
    // 1225 on the day the lease cap went away: the 8 units it had hidden were
    // on the market the day before as well.
    const prev = [unit("0509", 3774)];
    const curr = [unit("0509", 3774), unit("0625", 3529), unit("0701", 4944, { beds: 2 })];
    const d = computeDelta(prev, curr, T0, T1, ["u:0625"]);
    expect(d.newUnits.map((u) => u.unitNumber)).toEqual(["0701"]);
  });
});

describe("move-in date changes", () => {
  const T0 = "2026-11-14T18:58:17Z";
  const T1 = "2026-11-15T14:00:00Z";

  it("ignores available-now units, whose date is just each run's own day", () => {
    const prev = [unit("2313", 2457, { availableDate: "2026-11-14" })];
    const curr = [unit("2313", 2457, { availableDate: "2026-11-15", availableNow: true })];
    expect(computeDelta(prev, curr, T0, T1).dateChanges).toEqual([]);
  });

  it("reports a future move-in day that moved", () => {
    const prev = [unit("2111", 3359, { availableDate: "2026-12-11" })];
    const curr = [unit("2111", 3359, { availableDate: "2026-12-18", availableNow: false })];
    expect(computeDelta(prev, curr, T0, T1).dateChanges).toEqual([
      { unitNumber: "2111", floorplanName: "A1", beds: 1, from: "2026-12-11", to: "2026-12-18" },
    ]);
  });

  it("reports a unit that became available now (to = null)", () => {
    const prev = [unit("2111", 3359, { availableDate: "2026-11-15" })]; // tomorrow, seen from T0
    const curr = [unit("2111", 3359, { availableDate: "2026-11-15", availableNow: true })];
    expect(computeDelta(prev, curr, T0, T1).dateChanges).toEqual([
      { unitNumber: "2111", floorplanName: "A1", beds: 1, from: "2026-11-15", to: null },
    ]);
  });

  it("says nothing when a side has no date at all (old Old Town Park snapshots)", () => {
    const prev = [unit("2111", 3359, { availableDate: null })];
    const curr = [unit("2111", 3359, { availableDate: "2026-12-18", availableNow: false })];
    expect(computeDelta(prev, curr, T0, T1).dateChanges).toEqual([]);
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
