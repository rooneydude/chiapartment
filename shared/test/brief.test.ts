import { describe, expect, it } from "vitest";
import { assembleWeekdayBrief, briefBuilding, focusDeltaFromRuns } from "../src/brief";
import type { BuildingHistory, UnitListing } from "../src/types";

function unit(unitNumber: string | null, beds: number, price: number, plan = "A"): UnitListing {
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

function history(partial: Partial<BuildingHistory>): BuildingHistory {
  return {
    buildingId: "x",
    latest: null,
    delta: null,
    perUnit: {},
    perFloorplan: {},
    perUnitMeta: {},
    warnings: [],
    runs: [],
    lastAttempt: null,
    focusDelta: null,
    omitted: [],
    ...partial,
  };
}

describe("focusDeltaFromRuns", () => {
  it("diffs the latest ok run against the last ok run on a prior Chicago day", () => {
    const okRuns = [
      { timestamp: "2026-09-07T18:00:00Z", units: [unit("101", 0, 2400)] },
      { timestamp: "2026-09-08T10:00:00Z", units: [unit("101", 0, 2400), unit("404", 2, 4400)] },
      { timestamp: "2026-09-08T18:00:00Z", units: [unit("101", 0, 2300), unit("404", 2, 4400)] },
    ];
    const fd = focusDeltaFromRuns(okRuns, [0, 2]);
    expect(fd?.from).toBe("2026-09-07T18:00:00Z");
    expect(fd?.to).toBe("2026-09-08T18:00:00Z");
    expect(fd?.priceChanges).toEqual([
      { unitNumber: "101", floorplanName: "A", from: 2400, to: 2300, beds: 0 },
    ]);
    expect(fd?.newUnits.map((u) => u.unitNumber)).toEqual(["404"]);
  });
});

describe("weekday brief", () => {
  it("emits focus-bed new/removed/drops a morning brief can consume", () => {
    const h = history({
      latest: {
        timestamp: "2026-09-08T18:00:00Z",
        units: [unit("101", 0, 2300), unit("404", 2, 4400)],
      },
      lastAttempt: { timestamp: "2026-09-08T18:00:00Z", status: "ok" },
      focusDelta: {
        from: "2026-09-07T18:00:00Z",
        to: "2026-09-08T18:00:00Z",
        chicagoFrom: "2026-09-07",
        chicagoTo: "2026-09-08",
        focusBeds: [0, 2],
        newUnits: [unit("404", 2, 4400)],
        removedUnits: [unit("303", 2, 4600)],
        priceChanges: [
          { unitNumber: "101", floorplanName: "A", from: 2400, to: 2300, beds: 0 },
        ],
      },
      omitted: [
        {
          unitNumber: "0523",
          floorplanName: "Studio",
          beds: 0,
          advertisedPrice: 2283,
          leaseTermMonths: 18,
          reason: "over-cap",
        },
      ],
    });
    const row = briefBuilding({ id: "1225-old-town", name: "1225 Old Town", history: h }, [0, 2]);
    expect(row.status).toBe("ok");
    expect(row.new.map((n) => n.label)).toEqual(["#404"]);
    expect(row.removed.map((n) => n.label)).toEqual(["#303"]);
    expect(row.drops).toEqual([
      {
        label: "#101",
        unitNumber: "101",
        floorplanName: "A",
        beds: 0,
        from: 2400,
        to: 2300,
      },
    ]);
    expect(row.omitted[0]).toMatchObject({ label: "#0523", leaseTermMonths: 18 });
  });

  it("does not replay last-good inventory as gone when the latest scrape failed", () => {
    const h = history({
      latest: { timestamp: "2026-09-07T18:00:00Z", units: [unit("101", 0, 2400)] },
      lastAttempt: { timestamp: "2026-09-08T18:00:00Z", status: "error", error: "WAF" },
      focusDelta: {
        from: "2026-09-06T18:00:00Z",
        to: "2026-09-07T18:00:00Z",
        chicagoFrom: "2026-09-06",
        chicagoTo: "2026-09-07",
        focusBeds: [0, 2],
        newUnits: [],
        removedUnits: [unit("101", 0, 2400)],
        priceChanges: [],
      },
    });
    const row = briefBuilding({ id: "the-leo", name: "The Leo", history: h }, [0, 2]);
    expect(row.status).toBe("error");
    expect(row.error).toBe("WAF");
    expect(row.new).toEqual([]);
    expect(row.removed).toEqual([]);
    expect(row.drops).toEqual([]);
  });

  it("rolls up a portfolio summary", () => {
    const brief = assembleWeekdayBrief(
      [
        {
          id: "a",
          name: "A",
          history: history({
            latest: { timestamp: "2026-09-08T18:00:00Z", units: [unit("1", 0, 2000)] },
            lastAttempt: { timestamp: "2026-09-08T18:00:00Z", status: "ok" },
            focusDelta: {
              from: "2026-09-07T18:00:00Z",
              to: "2026-09-08T18:00:00Z",
              chicagoFrom: "2026-09-07",
              chicagoTo: "2026-09-08",
              focusBeds: [0, 2],
              newUnits: [unit("1", 0, 2000)],
              removedUnits: [],
              priceChanges: [],
            },
          }),
        },
        {
          id: "b",
          name: "B",
          history: history({
            lastAttempt: { timestamp: "2026-09-08T18:00:00Z", status: "error", error: "boom" },
          }),
        },
      ],
      [0, 2],
      "2026-09-08T18:01:00Z",
    );
    expect(brief.schemaVersion).toBe(1);
    expect(brief.timezone).toBe("America/Chicago");
    expect(brief.summary).toEqual({
      drops: 0,
      newListings: 1,
      removed: 0,
      scrapeErrors: 1,
      omittedOverCap: 0,
    });
  });
});
