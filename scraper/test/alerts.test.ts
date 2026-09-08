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
});
