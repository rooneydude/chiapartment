import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { Snapshot, UnitListing } from "../../shared/src/types";
import { buildAlerts } from "../src/alerts";

// Uses the REAL repo config (focus.beds = [0, 2]) with injected snapshots.
const ROOT = join(import.meta.dirname, "..", "..");

function unit(unitNumber: string | null, beds: number, price: number, plan = "X"): UnitListing {
  return {
    unitNumber,
    floorplanName: plan,
    beds,
    baths: 1,
    sqft: 600,
    price,
    availableDate: null,
  };
}

function snap(
  timestamp: string,
  units: UnitListing[],
  status: "ok" | "error" = "ok",
  buildingId = "stead-220",
): Snapshot {
  return {
    schemaVersion: 1,
    timestamp,
    buildings: [
      {
        buildingId,
        status,
        ...(status === "error" ? { error: "boom" } : {}),
        source: { adapter: "stead220", fetchedUrl: "https://stead220.com/" },
        units,
      },
    ],
  };
}

describe("buildAlerts", () => {
  it("reports focus-bed drops and new listings, skips 1BRs", () => {
    const prev = snap("2026-08-01T12:00:00Z", [
      unit("101", 0, 2400),
      unit("202", 1, 3300), // 1BR — out of focus
      unit("303", 2, 4600),
    ]);
    const curr = snap("2026-08-08T12:00:00Z", [
      unit("101", 0, 2300), // studio drop ✓
      unit("202", 1, 3000), // 1BR drop — ignored
      unit("303", 2, 4600),
      unit("404", 2, 4400), // new 2BR ✓
    ]);
    const r = buildAlerts(ROOT, [prev, curr]);
    expect(r.drops).toBe(1);
    expect(r.newUnits).toBe(1);
    expect(r.markdown).toContain("#101");
    expect(r.markdown).toContain("$2,300");
    expect(r.markdown).toContain("#404");
    expect(r.markdown).not.toContain("#202");
    expect(r.title).toContain("1 drop");
  });

  it("alerts on Stead floorplan/stack price drops", () => {
    const prev = snap("2026-09-07T18:00:00Z", [
      unit(null, 0, 2400, "Large Studio - Unit 08"),
    ]);
    const curr = snap("2026-09-08T18:00:00Z", [
      unit(null, 0, 2200, "Large Studio - Unit 08"),
    ]);
    const r = buildAlerts(ROOT, [prev, curr]);
    expect(r.drops).toBe(1);
    expect(r.markdown).toContain("Large Studio - Unit 08");
    expect(r.markdown).toContain("$2,200");
  });

  it("diffs the last two successful scrapes, skipping an error in between", () => {
    const a = snap("2026-09-06T18:00:00Z", [unit("101", 0, 2400)]);
    const fail = snap("2026-09-07T18:00:00Z", [], "error");
    const b = snap("2026-09-08T18:00:00Z", [unit("101", 0, 2300)]);
    const r = buildAlerts(ROOT, [a, fail, b]);
    expect(r.drops).toBe(1);
    expect(r.errors).toBe(0);
    expect(r.markdown).toContain("#101");
  });

  it("reports a scrape failure without treating empty units as inventory gone", () => {
    const a = snap("2026-08-01T12:00:00Z", [unit("101", 0, 2400), unit("303", 2, 4600)]);
    const b = snap("2026-08-08T12:00:00Z", [], "error");
    const r = buildAlerts(ROOT, [a, b]);
    expect(r.errors).toBe(1);
    expect(r.drops).toBe(0);
    expect(r.newUnits).toBe(0);
    expect(r.markdown).toContain("scrape failed");
    expect(r.markdown).not.toContain("gone");
  });

  it("stays silent when nothing changed", () => {
    const a = snap("2026-08-01T12:00:00Z", [unit("101", 0, 2400)]);
    const b = snap("2026-08-08T12:00:00Z", [unit("101", 0, 2400)]);
    expect(buildAlerts(ROOT, [a, b]).markdown).toBeNull();
  });

  it("stays silent on price increases only", () => {
    const a = snap("2026-08-01T12:00:00Z", [unit("101", 0, 2400)]);
    const b = snap("2026-08-08T12:00:00Z", [unit("101", 0, 2500)]);
    expect(buildAlerts(ROOT, [a, b]).markdown).toBeNull();
  });

  it("does not re-announce a building the latest run did not scrape", () => {
    // Stead's drop was already alerted on Sep 8. A later single-building
    // refresh of 1225 must not announce it a second time.
    const a = snap("2026-09-07T18:00:00Z", [unit("101", 0, 2400)]);
    const b = snap("2026-09-08T18:00:00Z", [unit("101", 0, 2300)]);
    const onlyOther = snap("2026-09-08T20:00:00Z", [unit("0624", 0, 2390)], "ok", "1225-old-town");
    expect(buildAlerts(ROOT, [a, b]).drops).toBe(1);
    expect(buildAlerts(ROOT, [a, b, onlyOther]).markdown).toBeNull();
  });

  it("does not call a headline lease-term switch a price drop", () => {
    const terms = (...pairs: [number, number][]) => pairs.map(([months, price]) => ({ months, price }));
    const prev = snap(
      "2026-11-14T18:00:00Z",
      [{ ...unit("0812", 0, 2409), leaseTermMonths: 14 }],
      "ok",
      "1225-old-town",
    );
    // Headline fell from $2,409 to $2,382 only because it is now quoted for 18
    // months; the 14-month price in the lease table is unchanged.
    const sameAt14 = snap(
      "2026-11-15T18:00:00Z",
      [{ ...unit("0812", 0, 2382), leaseTermMonths: 18, leaseTerms: terms([14, 2409], [18, 2382]) }],
      "ok",
      "1225-old-town",
    );
    expect(buildAlerts(ROOT, [prev, sameAt14]).markdown).toBeNull();

    // No table to align on: still not an alert, the terms differ.
    const noTable = snap(
      "2026-11-15T18:00:00Z",
      [{ ...unit("0812", 0, 2382), leaseTermMonths: 18 }],
      "ok",
      "1225-old-town",
    );
    expect(buildAlerts(ROOT, [prev, noTable]).markdown).toBeNull();

    // A real like-for-like drop at 14 months does alert, and says the term.
    const realDrop = snap(
      "2026-11-15T18:00:00Z",
      [{ ...unit("0812", 0, 2382), leaseTermMonths: 18, leaseTerms: terms([14, 2350], [18, 2382]) }],
      "ok",
      "1225-old-town",
    );
    const r = buildAlerts(ROOT, [prev, realDrop]);
    expect(r.drops).toBe(1);
    expect(r.markdown).toContain("$2,409 → **$2,350**");
    expect(r.markdown).toContain("14-mo lease");
  });

  it("does not announce units as new when the old lease cap had merely hidden them", () => {
    const prev: Snapshot = {
      schemaVersion: 1,
      timestamp: "2026-11-14T18:00:00Z",
      buildings: [
        {
          buildingId: "1225-old-town",
          status: "ok",
          source: { adapter: "sightmap", fetchedUrl: "https://1225oldtown.com/" },
          units: [unit("0812", 0, 2409)],
          omitted: [
            { unitNumber: "0701", floorplanName: "B4", beds: 2, advertisedPrice: 4944, leaseTermMonths: 18, reason: "over-cap" },
          ],
        },
      ],
    };
    const curr = snap(
      "2026-11-15T18:00:00Z",
      [unit("0812", 0, 2409), unit("0701", 2, 4944), unit("0704", 2, 4874)],
      "ok",
      "1225-old-town",
    );
    const r = buildAlerts(ROOT, [prev, curr]);
    expect(r.newUnits).toBe(1);
    expect(r.markdown).toContain("#0704");
    expect(r.markdown).not.toContain("#0701");
  });

  it("tells you the lease term and move-in date of a new listing", () => {
    const prev = snap("2026-11-14T18:00:00Z", [unit("0812", 0, 2409)], "ok", "1225-old-town");
    const curr = snap(
      "2026-11-15T18:00:00Z",
      [
        unit("0812", 0, 2409),
        {
          ...unit("0704", 2, 4874),
          sqft: 1134,
          leaseTermMonths: 18,
          leaseTerms: [{ months: 12, price: 5058 }, { months: 18, price: 4874 }],
          availableDate: "2027-01-19",
          availableNow: false,
        },
        { ...unit("1503", 2, 5007), priceMax: 5200, availableDate: "2026-11-15", availableNow: true },
      ],
      "ok",
      "1225-old-town",
    );
    const r = buildAlerts(ROOT, [prev, curr]);
    expect(r.newUnits).toBe(2);
    expect(r.markdown).toContain(
      "#0704 (2 BR, 1134 sqft) listed at **$4,874** · 18-mo lease; 12-mo $5,058 · move-in Jan 19, 2027",
    );
    expect(r.markdown).toContain("#1503 (2 BR, 600 sqft) listed at **$5,007–$5,200** · move-in now");
  });

  it("does not alert when Old Town Park flips between a range and a single price", () => {
    // Tower I #1715 (2 BR) 'dropped' $4,849 → $4,528 on 2026-08-31 and was
    // back at $4,903 the next day: the site alternating pricing states.
    const day1 = snap("2026-08-30T18:00:00Z", [{ ...unit("1715", 2, 4849), priceMax: 5270 }], "ok", "old-town-park-1");
    const day2 = snap("2026-08-31T18:00:00Z", [unit("1715", 2, 4528)], "ok", "old-town-park-1");
    const day3 = snap("2026-09-01T18:00:00Z", [{ ...unit("1715", 2, 4903), priceMax: 5330 }], "ok", "old-town-park-1");
    expect(buildAlerts(ROOT, [day1, day2]).markdown).toBeNull();
    expect(buildAlerts(ROOT, [day1, day2, day3]).markdown).toBeNull();
    // An ordinary drop on the same unit still alerts.
    const real = snap("2026-08-31T18:00:00Z", [{ ...unit("1715", 2, 4700), priceMax: 5100 }], "ok", "old-town-park-1");
    expect(buildAlerts(ROOT, [day1, real]).drops).toBe(1);
  });
});
