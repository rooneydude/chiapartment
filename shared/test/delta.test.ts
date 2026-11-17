import { describe, expect, it } from "vitest";
import {
  chicagoDate,
  computeDelta,
  computeFocusDelta,
  deltaContextFor,
  filterFocusDelta,
  listingKey,
  listingLabel,
  pricedAgainInfo,
  priorChicagoDayRun,
  type DeltaRun,
} from "../src/delta";
import type { AlsoListed, UnitListing } from "../src/types";

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
    expect(d.priceChanges[0]).toMatchObject({ notComparable: "lease-term", fromTerm: 18, toTerm: 14 });
    expect(realPriceChanges(d)).toEqual([]);
  });

  it("does not call a unit new when the previous run knew it under another list", () => {
    // 1225 on the day the lease cap went away: the 8 units it had hidden were
    // on the market the day before as well.
    const prev = [unit("0509", 3774)];
    const curr = [unit("0509", 3774), unit("0625", 3529), unit("0701", 4944, { beds: 2 })];
    const d = computeDelta(prev, curr, T0, T1, { prevOmittedKeys: ["u:0625"] });
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

describe("computeDelta with run history (deltaContextFor)", () => {
  const run = (day: string, units: UnitListing[], alsoListed?: AlsoListed[]): DeltaRun => ({
    timestamp: `2026-10-${day}T18:00:00Z`,
    units,
    ...(alsoListed !== undefined ? { alsoListed } : {}),
  });
  const diff = (runs: DeltaRun[]) => {
    const prev = runs[runs.length - 2]!;
    const curr = runs[runs.length - 1]!;
    return computeDelta(prev.units, curr.units, prev.timestamp, curr.timestamp, deltaContextFor(runs, prev, curr));
  };
  const plan = (name: string, price: number, beds = 0): UnitListing =>
    unit(null, price, { floorplanName: name, beds });
  const unpriced = (name: string, beds: number | null = 0, extra: Partial<AlsoListed> = {}): AlsoListed => ({
    unitNumber: null,
    floorplanName: name,
    beds,
    note: "Contact for Pricing",
    ...extra,
  });

  it("announces a listing that gets its price back, with what it last cost", () => {
    // Stead 220 "Medium Studio - Unit 05": $2,250, then "Contact for Pricing", then priced again.
    const runs = [
      run("27", [plan("Unit 05", 2250), plan("Unit 01", 2475)], []),
      run("28", [plan("Unit 01", 2475)], [unpriced("Unit 05")]),
      run("29", [plan("Unit 01", 2475), plan("Unit 05", 1950)], []),
    ];
    // The price is withdrawn: still on the site, so not removed.
    const withdrawn = diff(runs.slice(0, 2));
    expect(withdrawn.removedUnits).toEqual([]);
    expect(withdrawn.newAlsoListed).toBeUndefined(); // it was listed before, with a price
    // The price comes back: reported, and comparable with the old one.
    const back = diff(runs);
    expect(back.newUnits.map((u) => u.floorplanName)).toEqual(["Unit 05"]);
    expect(back.pricedAgain).toEqual([
      { key: "fp:0:Unit 05", lastPrice: 2250, lastPricedAt: "2026-10-27T18:00:00Z" },
    ]);
    expect(back.relistedKeys).toBeUndefined();
    expect(pricedAgainInfo(back, back.newUnits[0]!)).toMatchObject({ lastPrice: 2250 });
  });

  it("follows a listing that starts without a price: appears, gets priced, or leaves", () => {
    const start = run("20", [plan("Unit 01", 2475)], []);
    const debut = run("21", [plan("Unit 01", 2475)], [unpriced("Unit 11")]);
    // It appears without a price.
    expect(diff([start, debut]).newAlsoListed).toEqual([unpriced("Unit 11")]);
    expect(diff([start, debut]).newUnits).toEqual([]);
    // It gets its first price: announced (there is no earlier price to quote).
    const priced = diff([start, debut, run("22", [plan("Unit 01", 2475), plan("Unit 11", 2300)], [])]);
    expect(priced.newUnits.map((u) => u.floorplanName)).toEqual(["Unit 11"]);
    expect(priced.pricedAgain).toEqual([{ key: "fp:0:Unit 11" }]);
    // Or it leaves the site without ever being priced.
    const left = diff([start, debut, run("22", [plan("Unit 01", 2475)], [])]);
    expect(left.removedAlsoListed).toEqual([unpriced("Unit 11")]);
    expect(left.removedUnits).toEqual([]);
  });

  it("says nothing about unpriced rows when the earlier run did not record them", () => {
    // Snapshots before 15 Nov 2026 have no alsoListed at all: its absence is not "none".
    const legacy = run("20", [plan("Unit 01", 2475)]);
    const now = run("21", [plan("Unit 01", 2475)], [unpriced("Penthouse", null, { unitNumber: "4003" })]);
    const d = diff([legacy, now]);
    expect(d.newAlsoListed).toBeUndefined();
    expect(d.removedAlsoListed).toBeUndefined();
  });

  it("does not call a row new when it already had a price and only lacked a bed count", () => {
    const townhome = unpriced("Townhome", null, { unitNumber: "0105", price: 8230, note: "Bed count not published" });
    const runs = [
      run("20", [unit("0201", 3000)], [townhome]),
      run("21", [unit("0201", 3000), unit("0105", 8230, { beds: 3 })], []),
    ];
    const d = diff(runs);
    expect(d.newUnits).toEqual([]);
    expect(d.pricedAgain).toBeUndefined();
    expect(d.removedAlsoListed).toBeUndefined();
  });

  it("marks a unit that left and came back, and only that one", () => {
    const runs = [
      run("01", [unit("705", 3275), unit("602", 2790)]),
      run("08", [unit("602", 2790)]),
      run("15", [unit("602", 2790), unit("705", 3275), unit("910", 4185)]),
    ];
    const d = diff(runs);
    expect(d.newUnits.map((u) => u.unitNumber).sort()).toEqual(["705", "910"]);
    expect(d.relistedKeys).toEqual(["u:705"]);
  });
});

describe("computeDelta: a unit that flips between a rent range and a single price", () => {
  const range = (unitNumber: string, min: number, max: number): UnitListing => unit(unitNumber, min, { priceMax: max, beds: 2 });
  const single = (unitNumber: string, price: number): UnitListing => unit(unitNumber, price, { beds: 2 });
  const day = (d: number, u: UnitListing): DeltaRun => ({
    timestamp: `2026-08-${String(d).padStart(2, "0")}T14:26:00Z`,
    units: [u],
  });
  const changes = (runs: DeltaRun[]) => {
    const prev = runs[runs.length - 2]!;
    const curr = runs[runs.length - 1]!;
    return computeDelta(prev.units, curr.units, prev.timestamp, curr.timestamp, deltaContextFor(runs, prev, curr))
      .priceChanges;
  };

  it("reports a real cut that landed on a flip day, once the range is back (Old Town Park I, 23 Aug 2026)", () => {
    const runs = [day(22, range("1015", 4505, 5445)), day(23, single("1015", 4445)), day(24, range("1015", 4445, 5373))];
    // The flip day itself: nothing to compare the single price with yet.
    expect(changes(runs.slice(0, 2))).toEqual([
      expect.objectContaining({ from: 4505, to: 4445, notComparable: "price-form" }),
    ]);
    // The range returns $60 lower than it left: a real move, measured from the 22nd.
    expect(changes(runs)).toEqual([
      { unitNumber: "1015", floorplanName: "A1", from: 4505, to: 4445, beds: 2, since: "2026-08-22T14:26:00Z" },
    ]);
  });

  it("stays silent while the site merely alternates between its two pricing states", () => {
    const runs = [
      day(1, single("1207", 3096)),
      day(2, range("1207", 3225, 3342)),
      day(3, single("1207", 3096)),
      day(4, range("1207", 3225, 3342)),
    ];
    expect(changes(runs.slice(0, 3))).toEqual([]);
    expect(changes(runs)).toEqual([]);
  });

  it("reports a repricing once, not once per form", () => {
    const runs = [
      day(1, single("1207", 3480)),
      day(2, range("1207", 3355, 3709)),
      day(3, single("1207", 3480)),
      day(4, range("1207", 3355, 3709)),
      day(5, single("1207", 3400)), // repriced: the single-price state shows it first
      day(6, range("1207", 3275, 3629)), // the range state catches up — same move
    ];
    expect(changes(runs.slice(0, 5))).toEqual([
      expect.objectContaining({ from: 3480, to: 3400, since: "2026-08-03T14:26:00Z" }),
    ]);
    expect(changes(runs)).toEqual([]);
  });

  it("compares directly when the form did not change", () => {
    const runs = [day(1, range("0622", 4441, 4833)), day(2, range("0622", 4381, 4773))];
    expect(changes(runs)).toEqual([
      { unitNumber: "0622", floorplanName: "A1", from: 4441, to: 4381, beds: 2 },
    ]);
  });
});

describe("reclassified listings", () => {
  const T0 = "2026-11-14T18:58:17Z";
  const T1 = "2026-11-15T14:00:00Z";

  it("treats a floor-plan row whose bed count alone changed as the same listing", () => {
    const prev = [unit(null, 2450, { floorplanName: "Medium Studio - Unit 11", beds: 0 })];
    const curr = [unit(null, 2400, { floorplanName: "Medium Studio - Unit 11", beds: 1 })];
    const d = computeDelta(prev, curr, T0, T1);
    expect(d.newUnits).toEqual([]);
    expect(d.removedUnits).toEqual([]);
    expect(d.priceChanges).toEqual([
      { unitNumber: "Medium Studio - Unit 11", floorplanName: "Medium Studio - Unit 11", from: 2450, to: 2400, beds: 1 },
    ]);
  });

  it("tells the shopper when a unit moves into the sizes being shopped for", () => {
    // The Leo #602: filed as a 1-bedroom until the site's own "Jr 1 Bedroom = 0 bedrooms" was read.
    const prev = [unit("705", 3093), unit("602", 2635, { beds: 1 })];
    const curr = [unit("705", 3093), unit("602", 2635, { beds: 0, planType: "Jr 1 Bedroom" })];
    const fd = computeFocusDelta(prev, curr, T0, T1, [0, 2]);
    expect(fd.newUnits.map((u) => u.unitNumber)).toEqual(["602"]);
    expect(fd.reclassifiedKeys).toEqual(["u:602"]);
    expect(fd.removedUnits).toEqual([]);
    // And the other way round.
    const out = computeFocusDelta(curr, prev, T0, T1, [0, 2]);
    expect(out.removedUnits.map((u) => u.unitNumber)).toEqual(["602"]);
    expect(out.newUnits).toEqual([]);
    // The unfiltered delta is unaffected: nothing appeared or left.
    expect(computeDelta(prev, curr, T0, T1).newUnits).toEqual([]);
  });

  it("keeps the focus slice's annotations in step with what it keeps", () => {
    const d = computeDelta(
      [unit("101", 2000)],
      [unit("101", 2000), unit("201", 2500, { beds: 0 }), unit("301", 3000, { beds: 1 })],
      T0,
      T1,
      {
        seenBefore: ["u:201", "u:301"],
        prevAlsoListed: [],
        currAlsoListed: [
          { unitNumber: "PH1", floorplanName: "Penthouse", beds: null, note: "Contact for Pricing" },
          { unitNumber: null, floorplanName: "3 BR", beds: 3, note: "Contact for Pricing" },
        ],
      },
    );
    expect(d.relistedKeys).toEqual(["u:201", "u:301"]);
    const f = filterFocusDelta(d, [0, 2]);
    expect(f.relistedKeys).toEqual(["u:201"]);
    // Unknown bed count might be in focus; a known out-of-focus one is not.
    expect(f.newAlsoListed?.map((r) => r.floorplanName)).toEqual(["Penthouse"]);
  });
});
