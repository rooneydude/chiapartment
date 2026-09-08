import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildingsConfigSchema, UnitListingSchema } from "../../shared/src/types";
import { leo, isWafPage, parseLeoPage } from "../src/adapters/leo";
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

describe("oldtownpark adapter (placeholder pricing)", () => {
  it("skips $0 call-for-pricing rows instead of failing the whole run", async () => {
    const html = `
      <div class="js-plan-group" data-plan-slug="s1" data-cat="Convertible">
        <div class="yard__unit" data-unit="1501" data-rent-min="3200" data-rent-max="3400">
          Available Now Total SQFT: 565
        </div>
        <div class="yard__unit" data-unit="1502" data-rent-min="0" data-rent-max="0">
          Available Now Total SQFT: 565
        </div>
      </div>`;
    const ctx: AdapterContext = {
      fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }),
      log: () => {},
    };
    const listings = await oldtownpark.scrape(buildingById("old-town-park-3"), ctx);
    expect(listings.map((l) => l.unitNumber)).toEqual(["1501"]);
    for (const l of listings) UnitListingSchema.parse(l);
  });
});

describe("sightmap adapter (real captured payload)", () => {
  it("maps every available unit with dates, sqft, and clean plan names", async () => {
    const listings = await sightmap.scrape(buildingById("1225-old-town"), ctxFor("1225-old-town"));
    expect(listings.length).toBeGreaterThanOrEqual(4);
    for (const l of listings) UnitListingSchema.parse(l);
    expect(listings.every((l) => /^\d{3,4}$/.test(l.unitNumber ?? ""))).toBe(true);
    expect(listings.every((l) => l.availableDate === null || /^\d{4}-\d{2}-\d{2}$/.test(l.availableDate))).toBe(true);
    expect(listings.filter((l) => l.sqft !== null).length).toBeGreaterThanOrEqual(4);
    // Plan names never leak serialized JSON.
    expect(listings.every((l) => !l.floorplanName.includes("{"))).toBe(true);
    // Structural spot-check only — prices drift between fixture captures.
    const known = listings.find((l) => l.unitNumber === "0624");
    expect(known).toMatchObject({ beds: 0, sqft: 546 });
    expect(known!.price).toBeGreaterThan(1800);
    expect(known!.price).toBeLessThan(3200);
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
    expect(studio408).toMatchObject({ beds: 0, sqft: 467, baths: 1 });
    expect(studio408!.price).toBeGreaterThan(1800);
    expect(studio408!.price).toBeLessThan(3200);
  });

  it("prefers the embedded Jonah JSON over card markup", () => {
    const html = readFileSync(join(ROOT, "scraper", "fixtures", "the-leo", "00-floorplans.html"), "utf8");
    const listings = parseLeoPage(html, "https://leochicago.com/");
    expect(listings.length).toBeGreaterThanOrEqual(8);
    expect(listings.every((l) => /^\d{3,4}$/.test(l.unitNumber ?? ""))).toBe(true);
    // Unix available_date on the JSON blob becomes an ISO day.
    expect(listings.every((l) => l.availableDate === null || /^\d{4}-\d{2}-\d{2}$/.test(l.availableDate))).toBe(true);
  });

  it("recognizes Imunify360 WAF bodies so we retry instead of treating them as empty inventory", () => {
    expect(
      isWafPage(
        JSON.stringify({
          message: "Access denied by Imunify360 bot-protection. IPs used for automation should be whitelisted",
        }),
      ),
    ).toBe(true);
    expect(isWafPage("<html><body>floorplans</body></html>")).toBe(false);
    expect(parseLeoPage('{"message":"Access denied by Imunify360 bot-protection."}', "https://leochicago.com/")).toEqual(
      [],
    );
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

describe("sightmap lease-term cap", () => {
  it("extracts term→price pairs from unknown matrix shapes", async () => {
    const { extractTermPrices } = await import("../src/adapters/sightmap");
    const m1 = extractTermPrices({
      data: { prices: [
        { lease_term: 12, price: 2500 },
        { lease_term: 16, price: 2300 },
        { lease_term: 12, price: 2450 },
      ]},
    });
    expect(m1.get(12)).toBe(2450); // cheapest per term wins
    expect(m1.get(16)).toBe(2300);
    const m2 = extractTermPrices({
      terms: [{ months: "14 Months", rent: "$2,395" }, { months: "15 Months", rent: "$2,295" }],
    });
    expect(m2.get(14)).toBe(2395);
    expect(m2.get(15)).toBe(2295);
    expect(extractTermPrices({ nothing: true }).size).toBe(0);
  });

  it("re-prices over-cap advertised prices from the leasing matrix", async () => {
    const payload = {
      data: {
        floors: [],
        floor_plans: [{ id: "p1", name: "S1", bedroom_count: 0, bathroom_count: 1 }],
        units: [
          {
            id: "u1", unit_number: "0901", floor_id: "f", floor_plan_id: "p1",
            price: 2200, area: 500, available_on: null,
            display_lease_term: "16 Months",
            leasing_price_url: "https://sightmap.com/app/api/v1/leasing/x/unit/u1",
          },
          {
            id: "u2", unit_number: "0902", floor_id: "f", floor_plan_id: "p1",
            price: 2400, area: 500, available_on: null,
            display_lease_term: "12 Months",
            leasing_price_url: "https://sightmap.com/app/api/v1/leasing/x/unit/u2",
          },
        ],
      },
    };
    const matrix = {
      data: { prices: [
        { lease_term: 12, price: 2450 },
        { lease_term: 14, price: 2380 },
        { lease_term: 16, price: 2200 },
      ]},
    };
    const ctx = {
      fetch: (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("/leasing/")) return new Response(JSON.stringify(matrix));
        return new Response(JSON.stringify(payload));
      }) as typeof fetch,
      log: () => {},
      maxLeaseTermMonths: 14,
    };
    const building = { ...buildingById("1225-old-town") };
    const listings = await sightmap.scrape(building, ctx);
    const over = listings.find((l) => l.unitNumber === "0901")!;
    // 16-month teaser replaced by the cheapest ≤14-month price.
    expect(over.price).toBe(2380);
    expect(over.leaseTermMonths).toBe(14);
    const within = listings.find((l) => l.unitNumber === "0902")!;
    // Already within cap: advertised price kept, no matrix fetch needed.
    expect(within.price).toBe(2400);
    expect(within.leaseTermMonths).toBe(12);
  });

  it("omits over-cap units when the matrix has no in-cap price", async () => {
    const payload = {
      data: {
        floors: [],
        floor_plans: [{ id: "p1", name: "S1", bedroom_count: 0, bathroom_count: 1 }],
        units: [
          {
            id: "u1",
            unit_number: "0901",
            floor_id: "f",
            floor_plan_id: "p1",
            price: 2200,
            area: 500,
            available_on: null,
            display_lease_term: "18 Months",
            leasing_price_url: "https://sightmap.com/app/api/v1/leasing/x/unit/u1",
          },
        ],
      },
    };
    const matrix = { data: { options: [{ lease_term: 18, price: 2200 }] } };
    const ctx = {
      fetch: (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("/leasing/")) return new Response(JSON.stringify(matrix));
        return new Response(JSON.stringify(payload));
      }) as typeof fetch,
      log: () => {},
      maxLeaseTermMonths: 14,
    };
    const listings = await sightmap.scrape({ ...buildingById("1225-old-town") }, ctx);
    expect(listings).toEqual([]);
  });

  it("keeps real-fixture listings term-tagged and within the 14-month cap", async () => {
    const listings = await sightmap.scrape(buildingById("1225-old-town"), {
      ...ctxFor("1225-old-town"),
      maxLeaseTermMonths: 14,
    });
    const tagged = listings.filter((l) => l.leaseTermMonths != null);
    expect(tagged.length).toBe(listings.length); // every 1225 unit carries a term
    expect(tagged.every((l) => l.leaseTermMonths! <= 14)).toBe(true);
    // Over-cap teasers with no in-cap matrix price are omitted, not quoted.
    expect(listings.find((l) => l.unitNumber === "1308")).toBeUndefined();
  });
});
