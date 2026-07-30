import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureSite, type FixtureSite } from "@/lib/testing/fixture-site";

/**
 * The whole pipeline, end to end, against a stand-in leasing site.
 *
 * This is the test that matters: it registers a source the way `--add` does,
 * scrapes it, then scrapes a *changed* version of the same site and checks the
 * refresh behaves — prices recorded as history, vanished units marked leased
 * rather than deleted, rollups appended, geometry re-derived.
 *
 * Everything is imported dynamically because the database module resolves its
 * path once, at import time, and these tests need a throwaway file.
 */

const tempDir = mkdtempSync(join(tmpdir(), "chiapartment-test-"));
process.env.CHIAPARTMENT_DB = join(tempDir, "test.db");
process.env.CHIAPARTMENT_FLOORPLANS = join(tempDir, "floorplans");
process.env.CHIAPARTMENT_CACHE = join(tempDir, "cache");

type Db = typeof import("@/lib/db");
type Runner = typeof import("@/lib/scrape/runner");
type Registry = typeof import("@/lib/scrape/registry");
type Queries = typeof import("@/lib/db/queries");

let db: Db;
let runner: Runner;
let registry: Registry;
let queries: Queries;
let site: FixtureSite;

const SOURCE = { slug: "fixture", buildingSlug: "fixture", url: "", crawlDelaySec: 0 };

beforeAll(async () => {
  db = await import("@/lib/db");
  runner = await import("@/lib/scrape/runner");
  registry = await import("@/lib/scrape/registry");
  queries = await import("@/lib/db/queries");

  site = await startFixtureSite({ round: 1 });
  SOURCE.url = site.url;

  db.getDb()
    .insert(db.schema.buildings)
    .values({ slug: "fixture", name: "Fixture Residences", websiteUrl: site.url })
    .onConflictDoNothing()
    .run();
}, 30_000);

afterAll(async () => {
  await site?.close();
  // Windows refuses to delete a file SQLite still holds open, so close the
  // connection before removing the temp directory.
  db?.closeDb();
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("adapter selection", () => {
  it("routes a homepage with no availability to the crawler", async () => {
    const html = await fetch(site.url).then((r) => r.text());
    const detection = registry.detectAdapter(html, site.url);
    expect(detection.adapter.id).toBe("site-crawl");
  });

  it("routes the availability page itself to a direct extractor", async () => {
    const html = await fetch(`${site.url}floorplans`).then((r) => r.text());
    const detection = registry.detectAdapter(html, `${site.url}floorplans`);
    // The units are right there, so crawling is not the best choice.
    expect(detection.adapter.id).not.toBe("site-crawl");
    expect(detection.score).toBeGreaterThan(0.4);
  });
});

describe("first scrape", () => {
  let summary: Awaited<ReturnType<Runner["runSource"]>>;

  beforeAll(async () => {
    summary = await runner.runSource(SOURCE, { skipImages: false });
  }, 60_000);

  it("finds the units by crawling from the homepage", () => {
    expect(summary.unitsFound).toBeGreaterThan(10);
    expect(summary.adapter).toBe("site-crawl");
  });

  it("records a price observation for every unit", () => {
    expect(summary.unitsChanged).toBe(summary.unitsFound);
  });

  it("reads the address and coordinates out of JSON-LD", () => {
    const building = queries.getBuilding("fixture")!;
    expect(building.address).toContain("500 N Fixture St");
    expect(building.lat).toBeCloseTo(41.8921, 3);
    expect(building.lng).toBeCloseTo(-87.6338, 3);
  });

  it("downloads the floor plan images", () => {
    expect(summary.imagesDownloaded).toBeGreaterThan(0);
  });

  it("creates a plan record for every plan a unit references", () => {
    // Plans named only in the availability table have no marketing image, but
    // units still point at them — a missing record breaks the foreign key.
    const rows = db
      .getDb()
      .select()
      .from(db.schema.units)
      .all()
      .filter((u) => u.floorplanId != null);
    const planIds = new Set(
      db.getDb().select().from(db.schema.floorplans).all().map((p) => p.id),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const u of rows) expect(planIds.has(u.floorplanId!)).toBe(true);
  });

  it("parses every unit label into a floor and a line", () => {
    expect(summary.unparsedUnitCodes).toEqual([]);
    const units = db.getDb().select().from(db.schema.units).all();
    for (const u of units) {
      expect(u.floor).not.toBeNull();
      expect(u.line).not.toBeNull();
    }
  });

  it("derives the massing and places every available unit", () => {
    const building = queries.getBuilding("fixture")!;
    expect(building.spec).not.toBeNull();
    expect(building.plate).not.toBeNull();
    expect(building.spec!.topFloor).toBeGreaterThan(20);

    const placed = queries.listUnits("fixture", { status: "available" });
    expect(placed.length).toBeGreaterThan(0);
    for (const p of placed) {
      expect(p.placement).not.toBeNull();
      expect(p.placement!.facing).toMatch(/^[NSEW]/);
      expect(p.placement!.areaSqft).toBeGreaterThan(300);
      expect(p.placement!.slabHeightM).toBeGreaterThan(0);
    }
  });

  it("writes a per-bedroom-type rollup", () => {
    const summaries = queries.typeSummary("fixture");
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    for (const s of summaries) {
      expect(s.medianRent).toBeGreaterThan(1000);
      expect(s.availableCount).toBeGreaterThan(0);
    }
  });
});

describe("manual refresh against changed data", () => {
  let before: { available: number; snapshots: number };
  let summary: Awaited<ReturnType<Runner["runSource"]>>;

  beforeAll(async () => {
    const d = db.getDb();
    before = {
      available: d
        .select()
        .from(db.schema.units)
        .all()
        .filter((u) => u.status === "available").length,
      snapshots: d.select().from(db.schema.priceSnapshots).all().length,
    };

    // Swap the site for a version with different prices and inventory, the
    // way a real building's page changes between scrapes.
    await site.close();
    site = await startFixtureSite({ round: 2 });
    SOURCE.url = site.url;

    summary = await runner.runSource(SOURCE, { skipImages: false });
  }, 60_000);

  it("records the new prices as additional history, not replacements", () => {
    const snapshots = db.getDb().select().from(db.schema.priceSnapshots).all();
    expect(snapshots.length).toBeGreaterThan(before.snapshots);
  });

  it("marks vanished units as leased rather than deleting them", () => {
    const units = db.getDb().select().from(db.schema.units).all();
    const leased = units.filter((u) => u.status === "leased");
    expect(summary.unitsDelisted).toBeGreaterThan(0);
    expect(leased.length).toBe(summary.unitsDelisted);
    // Nothing is ever removed: the total can only grow.
    expect(units.length).toBeGreaterThanOrEqual(before.available);
  });

  it("keeps the leased units' last known rent", () => {
    const leased = db
      .getDb()
      .select()
      .from(db.schema.units)
      .all()
      .filter((u) => u.status === "leased");
    for (const u of leased) expect(u.rent).not.toBeNull();
  });

  it("appends a second set of type rollups so a trend exists", () => {
    const rollups = db.getDb().select().from(db.schema.typeSnapshots).all();
    const byType = new Map<number, number>();
    for (const r of rollups) byType.set(r.bedrooms, (byType.get(r.bedrooms) ?? 0) + 1);
    for (const count of byType.values()) expect(count).toBeGreaterThanOrEqual(2);
  });

  it("surfaces the price movements", () => {
    // Rents dropped $75 across the board in round 2, so any unit listed in
    // both rounds must show a decrease.
    const changes = queries.recentPriceChanges(50);
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      expect(c.rent).not.toBe(c.previousRent);
      expect(c.delta).toBe(c.rent - c.previousRent);
    }
  });

  it("still places every available unit after the refresh", () => {
    const placed = queries.listUnits("fixture", { status: "available" });
    expect(placed.length).toBe(summary.unitsFound);
    for (const p of placed) expect(p.placement).not.toBeNull();
  });

  it("records both runs", () => {
    const runs = db.getDb().select().from(db.schema.scrapeRuns).all();
    expect(runs.length).toBe(2);
    for (const r of runs) {
      expect(r.ok).toBe(true);
      expect(r.finishedAt).not.toBeNull();
    }
  });
});

describe("refreshing when nothing has changed", () => {
  let before: { snapshots: number; units: number };
  let summary: Awaited<ReturnType<Runner["runSource"]>>;

  beforeAll(async () => {
    const d = db.getDb();
    before = {
      snapshots: d.select().from(db.schema.priceSnapshots).all().length,
      units: d.select().from(db.schema.units).all().length,
    };
    // Same site, same URL, same data — re-scraping must be a no-op.
    summary = await runner.runSource(SOURCE, { skipImages: false });
  }, 60_000);

  it("writes no new price history", () => {
    // A snapshot is only appended when something material moved. Writing one
    // per run regardless would bloat the table and invent price "changes".
    expect(summary.unitsChanged).toBe(0);
    const snapshots = db.getDb().select().from(db.schema.priceSnapshots).all();
    expect(snapshots.length).toBe(before.snapshots);
  });

  it("delists nothing and adds nothing", () => {
    expect(summary.unitsDelisted).toBe(0);
    const units = db.getDb().select().from(db.schema.units).all();
    expect(units.length).toBe(before.units);
  });

  it("does not re-download floor plan images", () => {
    // The image URLs are unchanged, so the building should not be asked for
    // them again.
    expect(summary.imagesDownloaded).toBe(0);
  });

  it("still reports the same units as available", () => {
    const placed = queries.listUnits("fixture", { status: "available" });
    expect(placed.length).toBe(summary.unitsFound);
  });
});
