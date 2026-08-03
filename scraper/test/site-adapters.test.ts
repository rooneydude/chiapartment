import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildingsConfigSchema, UnitListingSchema } from "../../shared/src/types";
import { leo } from "../src/adapters/leo";
import { oldtownpark } from "../src/adapters/oldtownpark";
import { sightmap } from "../src/adapters/sightmap";
import { stead220 } from "../src/adapters/stead220";
import type { AdapterContext } from "../src/adapters/types";
import { makeFixtureFetch } from "../src/fixtures";

const ROOT = join(import.meta.dirname, "..", "..");
const config = BuildingsConfigSchema.parse(
  JSON.parse(readFileSync(join(ROOT, "buildings.json"), "utf8")),
);
const buildingById = (id: string) => config.buildings.find((b) => b.id === id)!;

function ctxFor(buildingId: string): AdapterContext {
  return {
    fetch: makeFixtureFetch(join(ROOT, "scraper", "fixtures", buildingId)),
    log: () => {},
  };
}

describe("oldtownpark adapter (real captured page)", () => {
  it("parses every unit card on the tower-1 availability page", async () => {
    const listings = await oldtownpark.scrape(buildingById("old-town-park-1"), ctxFor("old-town-park-1"));
    expect(listings.length).toBeGreaterThanOrEqual(25); // page had 29 unit cards
    for (const l of listings) UnitListingSchema.parse(l);
    // Real unit numbers, not card indexes.
    expect(listings.every((l) => /^\d{3,4}$/.test(l.unitNumber ?? ""))).toBe(true);
    // Plan names are clean slugs, no template whitespace.
    expect(listings.every((l) => !/\s{2,}|\n/.test(l.floorplanName))).toBe(true);
    // Sane Chicago rents.
    expect(listings.every((l) => l.price >= 1500 && l.price <= 15000)).toBe(true);
    // Ranges preserved when present.
    expect(listings.some((l) => l.priceMax !== undefined && l.priceMax > l.price)).toBe(true);
    // Cards carry "Total SQFT: N" — every listing gets sqft now.
    expect(listings.every((l) => l.sqft !== null)).toBe(true);
    // Bare "Available" labels resolve to an ISO date.
    expect(listings.every((l) => l.availableDate === null || /^\d{4}-\d{2}-\d{2}$/.test(l.availableDate))).toBe(true);
  });
});

describe("sightmap adapter (real captured payload)", () => {
  it("maps every available unit with dates, sqft, and clean plan names", async () => {
    const listings = await sightmap.scrape(buildingById("1225-old-town"), ctxFor("1225-old-town"));
    expect(listings.length).toBeGreaterThanOrEqual(20); // payload had 27
    for (const l of listings) UnitListingSchema.parse(l);
    expect(listings.every((l) => /^\d{3,4}$/.test(l.unitNumber ?? ""))).toBe(true);
    expect(listings.every((l) => l.availableDate === null || /^\d{4}-\d{2}-\d{2}$/.test(l.availableDate))).toBe(true);
    expect(listings.filter((l) => l.sqft !== null).length).toBeGreaterThanOrEqual(20);
    // Plan names never leak serialized JSON.
    expect(listings.every((l) => !l.floorplanName.includes("{"))).toBe(true);
    const known = listings.find((l) => l.unitNumber === "0424");
    expect(known).toMatchObject({ beds: 0, price: 2350, sqft: 546, availableDate: "2026-10-09" });
  });
});

describe("leo adapter (real captured page)", () => {
  it("parses unit-level cards with sqft and baths", async () => {
    const listings = await leo.scrape(buildingById("the-leo"), ctxFor("the-leo"));
    expect(listings.length).toBeGreaterThanOrEqual(8); // page had 9 cards
    for (const l of listings) UnitListingSchema.parse(l);
    // Cards are unit-level on this site.
    expect(listings.filter((l) => l.unitNumber !== null).length).toBeGreaterThanOrEqual(8);
    expect(listings.every((l) => l.sqft !== null && l.baths !== null)).toBe(true);
    const studio408 = listings.find((l) => l.unitNumber === "408");
    expect(studio408).toMatchObject({ beds: 0, price: 2350, sqft: 467, baths: 1 });
  });
});

describe("stead220 adapter (real captured page)", () => {
  it("parses floorplan cards with honest floorplan-level listings", async () => {
    const listings = await stead220.scrape(buildingById("stead-220"), ctxFor("stead-220"));
    expect(listings.length).toBeGreaterThanOrEqual(10);
    for (const l of listings) UnitListingSchema.parse(l);
    // No fabricated unit numbers — plan cards are stacks, not units.
    expect(listings.every((l) => l.unitNumber === null || /^\d{3,4}[A-Z]?$/i.test(l.unitNumber))).toBe(true);
    // Plan identity carries the stack tag.
    expect(listings.some((l) => /unit\s*\d+/i.test(l.floorplanName))).toBe(true);
    const studio = listings.find((l) => l.beds === 0);
    expect(studio).toBeDefined();
    expect(studio!.price).toBeGreaterThanOrEqual(2000);
  });
});
