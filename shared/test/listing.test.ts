import { describe, expect, it } from "vitest";
import {
  cheapestTerm,
  comparePrices,
  isAvailableNow,
  leaseTermTable,
  priceAtTerm,
  shortestTermAtAdvertisedPrice,
  uniformReprice,
} from "../src/listing";
import { chicagoDate, daysBetween, isIsoDay } from "../src/time";
import type { LeaseTermPrice } from "../src/types";

const table = (...pairs: [number, number][]): LeaseTermPrice[] =>
  pairs.map(([months, price]) => ({ months, price }));

describe("chicago calendar helpers", () => {
  it("maps instants onto the Chicago day, not the UTC day", () => {
    // 02:30 UTC on the 16th is still the evening of the 15th in Chicago.
    expect(chicagoDate("2026-11-16T02:30:00Z")).toBe("2026-11-15");
    expect(chicagoDate(new Date("2026-11-15T14:00:00Z"))).toBe("2026-11-15");
    // Daylight time: 04:59 UTC is 23:59 CDT the day before.
    expect(chicagoDate("2026-07-02T04:59:00Z")).toBe("2026-07-01");
  });

  it("validates ISO days strictly", () => {
    expect(isIsoDay("2026-12-18")).toBe(true);
    expect(isIsoDay("2026-02-31")).toBe(false);
    expect(isIsoDay("12/18/2026")).toBe(false);
    expect(isIsoDay("2026-12-18T00:00:00Z")).toBe(false);
  });

  it("counts whole days between ISO days", () => {
    expect(daysBetween("2026-11-15", "2026-12-18")).toBe(33);
    expect(daysBetween("2026-12-18", "2026-11-15")).toBe(-33);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
  });
});

describe("isAvailableNow", () => {
  const asOf = "2026-11-15T14:00:00Z";

  it("trusts the site's own flag", () => {
    expect(isAvailableNow({ availableNow: true, availableDate: null }, asOf)).toBe(true);
    // The Leo: vacant since September, flagged "Available Now".
    expect(isAvailableNow({ availableNow: true, availableDate: "2026-09-22" }, asOf)).toBe(true);
  });

  it("derives it from the move-in day when there is no flag (old snapshots)", () => {
    expect(isAvailableNow({ availableDate: "2026-11-15" }, asOf)).toBe(true);
    expect(isAvailableNow({ availableDate: "2026-09-22" }, asOf)).toBe(true);
    expect(isAvailableNow({ availableDate: "2026-12-18" }, asOf)).toBe(false);
  });

  it("uses the Chicago day of the snapshot, so a late-evening scrape is still 'today'", () => {
    // Scraped 02:30 UTC on the 16th = 20:30 on the 15th in Chicago.
    expect(isAvailableNow({ availableDate: "2026-11-16" }, "2026-11-16T02:30:00Z")).toBe(false);
    expect(isAvailableNow({ availableDate: "2026-11-15" }, "2026-11-16T02:30:00Z")).toBe(true);
  });

  it("says unknown when the site gives nothing", () => {
    expect(isAvailableNow({ availableDate: null }, asOf)).toBeNull();
    expect(isAvailableNow({ availableDate: null, availableNow: false }, asOf)).toBe(false);
  });
});

describe("lease-term tables", () => {
  const unit = {
    price: 3774,
    leaseTermMonths: 18,
    leaseTerms: table([12, 4955], [13, 3774], [14, 3802], [18, 3774]),
  };

  it("looks up a term without interpolating", () => {
    expect(priceAtTerm(unit, 12)).toBe(4955);
    expect(priceAtTerm(unit, 18)).toBe(3774);
    expect(priceAtTerm(unit, 9)).toBeNull();
  });

  it("falls back to the advertised term when there is no table", () => {
    const bare = { price: 2409, leaseTermMonths: 14 };
    expect(priceAtTerm(bare, 14)).toBe(2409);
    expect(priceAtTerm(bare, 12)).toBeNull();
    expect(leaseTermTable(bare)).toEqual(table([14, 2409]));
    expect(leaseTermTable({ price: 2400 })).toEqual([]);
  });

  it("finds the cheapest term, shortest lease winning ties", () => {
    expect(cheapestTerm(unit)).toEqual({ months: 13, price: 3774 });
    expect(cheapestTerm({ price: 2400 })).toBeNull();
  });
});

describe("comparePrices (like for like)", () => {
  it("compares headline prices when the term did not change", () => {
    expect(
      comparePrices({ price: 2400, leaseTermMonths: 12 }, { price: 2300, leaseTermMonths: 12 }),
    ).toEqual({ from: 2400, to: 2300, fromTerm: 12, toTerm: 12, notComparable: null });
    // Sites with no term info at all (Old Town Park, Stead, The Leo).
    expect(comparePrices({ price: 2400 }, { price: 2300 })).toEqual({
      from: 2400,
      to: 2300,
      notComparable: null,
    });
  });

  it("aligns on the old headline term when the new run has a table", () => {
    // Yesterday: capped quote of $2,409 @ 14 months. Today: the site's own
    // headline is $2,382 @ 18 months, and its table still says $2,409 for 14.
    const prev = { price: 2409, leaseTermMonths: 14 };
    const curr = {
      price: 2382,
      leaseTermMonths: 18,
      leaseTerms: table([12, 3846], [14, 2409], [18, 2382]),
    };
    expect(comparePrices(prev, curr)).toEqual({
      from: 2409,
      to: 2409,
      fromTerm: 14,
      toTerm: 14,
      notComparable: null,
    });
  });

  it("reports a real move at the shared term", () => {
    const prev = { price: 2409, leaseTermMonths: 14 };
    const curr = { price: 2382, leaseTermMonths: 18, leaseTerms: table([14, 2350], [18, 2382]) };
    expect(comparePrices(prev, curr)).toMatchObject({ from: 2409, to: 2350, fromTerm: 14 });
  });

  it("flags a pure headline-term switch that cannot be aligned", () => {
    const prev = { price: 2283, leaseTermMonths: 18 };
    const curr = { price: 2409, leaseTermMonths: 14 };
    expect(comparePrices(prev, curr)).toEqual({
      from: 2283,
      to: 2409,
      fromTerm: 18,
      toTerm: 14,
      notComparable: "lease-term",
    });
  });

  it("compares advertised rent with advertised rent when both runs carry the full lease table", () => {
    // 1225 #0704: every lease length except 18 months gets cheaper, and the
    // site now headlines 15 months. The 18-month price did not move — the
    // rent the site advertises did.
    const prev = { price: 4874, leaseTermMonths: 18, leaseTerms: table([12, 5058], [15, 4900], [18, 4874]) };
    const curr = { price: 4690, leaseTermMonths: 15, leaseTerms: table([12, 4800], [15, 4690], [18, 4874]) };
    expect(comparePrices(prev, curr)).toEqual({
      from: 4874,
      to: 4690,
      fromTerm: 18,
      toTerm: 15,
      notComparable: null,
    });
  });

  it("does not turn a shuffle of which lease length is cheapest into a rent increase", () => {
    // 1225 #0812 (real 15 Nov table): only the 18-month price jumps, the site
    // headlines 17 months at $5 more. That is +$5, not +$1,464.
    const prev = { price: 2382, leaseTermMonths: 18, leaseTerms: table([12, 3846], [17, 2387], [18, 2382]) };
    const curr = { price: 2387, leaseTermMonths: 17, leaseTerms: table([12, 3846], [17, 2387], [18, 3846]) };
    expect(comparePrices(prev, curr)).toMatchObject({ from: 2382, to: 2387, notComparable: null });
    // Same advertised rent at a different length is no change at all.
    const same = { price: 2382, leaseTermMonths: 17, leaseTerms: table([17, 2382], [18, 3846]) };
    expect(comparePrices(prev, same)).toMatchObject({ from: 2382, to: 2382, notComparable: null });
  });

  it("never lets a short-lease row stand in for the unit's price", () => {
    // Neither headline term exists on the other side; the only shared row is
    // the 2-month quote. With both tables present the headlines are compared.
    const prev = { price: 3000, leaseTermMonths: 18, leaseTerms: table([2, 3139], [18, 3000]) };
    const curr = { price: 2950, leaseTermMonths: 16, leaseTerms: table([2, 3300], [16, 2950]) };
    expect(comparePrices(prev, curr)).toMatchObject({ from: 3000, to: 2950, fromTerm: 18, toTerm: 16 });
  });

  it("aligns on the table-less side's lease length in either direction", () => {
    // A day the lease-table request failed: today has only the headline.
    const prev = { price: 2382, leaseTermMonths: 17, leaseTerms: table([17, 2382], [18, 2400]) };
    const curr = { price: 2390, leaseTermMonths: 18 };
    expect(comparePrices(prev, curr)).toEqual({ from: 2400, to: 2390, fromTerm: 18, toTerm: 18, notComparable: null });
    // The table has no row for that length: not comparable, and said so.
    const short = { price: 2390, leaseTermMonths: 9 };
    expect(comparePrices(prev, short).notComparable).toBe("lease-term");
  });

  it("does not invent a term change when one side simply has no term info", () => {
    expect(comparePrices({ price: 2400 }, { price: 2300, leaseTermMonths: 12 })).toMatchObject({
      from: 2400,
      to: 2300,
      notComparable: null,
    });
  });

  it("flags a range ↔ single-price flip as not comparable (Old Town Park's two pricing states)", () => {
    // Tower III #1207, 2026-11-15: "$3,225 - $3,342" at 13:25Z, "$3,096" at 13:52Z.
    expect(comparePrices({ price: 3225, priceMax: 3342 }, { price: 3096 })).toEqual({
      from: 3225,
      to: 3096,
      notComparable: "price-form",
    });
    expect(comparePrices({ price: 3640 }, { price: 3631, priceMax: 3882 }).notComparable).toBe("price-form");
    // Range to range, or single to single, is an ordinary price move.
    expect(comparePrices({ price: 3225, priceMax: 3342 }, { price: 3200, priceMax: 3300 }).notComparable).toBeNull();
    expect(comparePrices({ price: 3096 }, { price: 3050 }).notComparable).toBeNull();
    // A range appearing at an unchanged minimum is no change at all.
    expect(comparePrices({ price: 3096 }, { price: 3096, priceMax: 3200 })).toMatchObject({
      from: 3096,
      to: 3096,
      notComparable: null,
    });
  });
});

describe("uniformReprice (a concession netted into every price)", () => {
  const u = (unitNumber: string, price: number) => ({ unitNumber, floorplanName: "A", beds: 1, price });

  it("recognises every unit moving by the same ratio", () => {
    // The Leo, 10 → 12 Nov 2026: both units ×17/18.
    const r = uniformReprice([u("705", 3275), u("602", 2790)], [u("705", 3093), u("602", 2635)]);
    expect(r).not.toBeNull();
    expect(r!.units).toBe(2);
    expect(r!.ratio).toBeCloseTo(17 / 18, 3);
  });

  it("is not fooled by ordinary moves", () => {
    // Different moves.
    expect(uniformReprice([u("705", 3275), u("602", 2790)], [u("705", 3200), u("602", 2790)])).toBeNull();
    // Two units that shared a price and got the same cut.
    expect(uniformReprice([u("705", 3000), u("602", 3000)], [u("705", 2950), u("602", 2950)])).toBeNull();
    // One unit only, or nothing in common.
    expect(uniformReprice([u("705", 3275)], [u("705", 3093)])).toBeNull();
    expect(uniformReprice([u("705", 3275), u("602", 2790)], [u("801", 3093), u("802", 2635)])).toBeNull();
    // Nothing moved.
    expect(uniformReprice([u("705", 3275), u("602", 2790)], [u("705", 3275), u("602", 2790)])).toBeNull();
  });
});

describe("shortestTermAtAdvertisedPrice", () => {
  it("finds the shortest lease that costs no more than the headline", () => {
    // 1225 #0625: headline "$3,529 · 18 Months", but 12 months costs the same.
    const u0625 = {
      price: 3529,
      leaseTermMonths: 18,
      leaseTerms: table([10, 4472], [11, 4701], [12, 3529], [13, 3529], [18, 3529]),
    };
    expect(shortestTermAtAdvertisedPrice(u0625)).toBe(12);
    // 1225 #0812: the headline really is only available on the longest lease.
    const u0812 = { price: 2382, leaseTermMonths: 18, leaseTerms: table([12, 3846], [14, 2409], [18, 2382]) };
    expect(shortestTermAtAdvertisedPrice(u0812)).toBe(18);
  });

  it("says nothing without a lease table", () => {
    expect(shortestTermAtAdvertisedPrice({ price: 2400, leaseTermMonths: 12 })).toBeNull();
    expect(shortestTermAtAdvertisedPrice({ price: 2400 })).toBeNull();
  });
});
