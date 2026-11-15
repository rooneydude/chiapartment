import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AlsoListedSchema,
  BuildingsConfigSchema,
  UnitListingSchema,
  type AlsoListed,
  type UnitListing,
} from "../../shared/src/types";
import { leo, isWafPage, parseLeoInventory, parseLeoPage } from "../src/adapters/leo";
import { oldtownpark, parseOldTownParkPage } from "../src/adapters/oldtownpark";
import { leasingUrlForDate, parseLeaseTable, sightmap } from "../src/adapters/sightmap";
import { extractSsrData, parseSteadFloorplans, stead220 } from "../src/adapters/stead220";
import type { AdapterContext } from "../src/adapters/types";
import { makeFixtureFetch } from "../src/fixtures";

const ROOT = join(import.meta.dirname, "..", "..");
const config = BuildingsConfigSchema.parse(
  JSON.parse(readFileSync(join(ROOT, "buildings.json"), "utf8")),
);
const buildingById = (id: string) => config.buildings.find((b) => b.id === id)!;

/** The moment the current fixtures were captured (2026-11-15, 7:55 am Chicago). */
const CAPTURED = new Date("2026-11-15T13:55:39Z");
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

interface Run {
  listings: UnitListing[];
  alsoListed: AlsoListed[];
  notices: string[];
  logs: string[];
}

function ctxFor(dir: string, into?: Partial<Run>, now: Date = CAPTURED): AdapterContext {
  return {
    fetch: makeFixtureFetch(join(ROOT, "scraper", "fixtures", dir)),
    log: (m) => into?.logs?.push(m),
    now: () => now,
    reportAlsoListed: (row) => into?.alsoListed?.push(row),
    reportNotice: (text) => into?.notices?.push(text),
  };
}

async function run(
  adapter: { scrape: (typeof sightmap)["scrape"] },
  buildingId: string,
  dir = buildingId,
): Promise<Run> {
  const out: Run = { listings: [], alsoListed: [], notices: [], logs: [] };
  out.listings = await adapter.scrape(buildingById(buildingId), ctxFor(dir, out));
  for (const l of out.listings) UnitListingSchema.parse(l);
  for (const a of out.alsoListed) AlsoListedSchema.parse(a);
  return out;
}

/** Invariants every adapter's output must satisfy, whatever the site. */
function expectSaneListings(listings: UnitListing[]): void {
  const seen = new Set<string>();
  for (const l of listings) {
    expect(l.price).toBeGreaterThanOrEqual(400);
    expect(l.price).toBeLessThanOrEqual(25000);
    if (l.priceMax !== undefined) expect(l.priceMax).toBeGreaterThan(l.price);
    if (l.availableDate !== null) expect(l.availableDate).toMatch(ISO_DAY);
    // The flag and the date may never contradict each other.
    if (l.availableNow === false) expect(l.availableDate! > "2026-11-15").toBe(true);
    if (l.leaseTerms) {
      const months = l.leaseTerms.map((t) => t.months);
      expect(months).toEqual([...months].sort((a, b) => a - b));
      expect(new Set(months).size).toBe(months.length);
    }
    expect(l.floorplanName).not.toMatch(/[{}\n]|\s{2,}/);
    const key = l.unitNumber ? `u:${l.unitNumber}` : `f:${l.floorplanName}:${l.beds}`;
    expect(seen.has(key)).toBe(false);
    seen.add(key);
  }
}

// ---------------------------------------------------------------------------
// 1225 Old Town — SightMap
// ---------------------------------------------------------------------------

describe("sightmap adapter (1225 Old Town, captured 2026-11-15)", () => {
  it("records EVERY unit the site lists, at the site's own price and lease term", async () => {
    const { listings, logs } = await run(sightmap, "1225-old-town");
    const payload = JSON.parse(
      readFileSync(
        join(ROOT, "scraper/fixtures/1225-old-town/00-app-api-v1-60p7xoklv7n-sightmaps-87594.json"),
        "utf8",
      ),
    ) as { data: { units: { unit_number: string; price: number }[] } };
    // The old lease cap dropped 8 of these 15. Nothing may be dropped now.
    expect(listings).toHaveLength(payload.data.units.length);
    expect(listings).toHaveLength(15);
    for (const raw of payload.data.units) {
      const l = listings.find((x) => x.unitNumber === raw.unit_number)!;
      expect(l.price).toBe(raw.price); // headline price, never re-priced
      expect(l.leaseTermMonths).toBe(18);
    }
    expectSaneListings(listings);
    expect(logs).toContain("15/15 units have a lease-term price table");
  });

  it("attaches the full lease-term price table to every unit", async () => {
    const { listings } = await run(sightmap, "1225-old-town");
    for (const l of listings) {
      expect(l.leaseTerms!.map((t) => t.months)).toEqual([
        2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
      ]);
      // The headline price is the table's price at the headline term.
      expect(l.leaseTerms!.find((t) => t.months === l.leaseTermMonths)!.price).toBe(l.price);
    }
    const u0509 = listings.find((l) => l.unitNumber === "0509")!;
    expect(u0509.leaseTerms!.find((t) => t.months === 12)!.price).toBe(4955);
    expect(u0509.leaseTerms!.find((t) => t.months === 13)!.price).toBe(3774);
  });

  it("keeps future move-in units, with their real dates", async () => {
    const { listings } = await run(sightmap, "1225-old-town");
    const future = listings.filter((l) => l.availableNow === false);
    const now = listings.filter((l) => l.availableNow === true);
    expect(future.map((l) => l.unitNumber).sort()).toEqual(
      ["0625", "0701", "0704", "0705", "0718", "0725", "1022", "1505"].sort(),
    );
    expect(now).toHaveLength(7);
    expect(listings.find((l) => l.unitNumber === "0625")).toMatchObject({
      availableDate: "2026-12-26",
      availableNow: false,
      price: 3529,
      beds: 1,
      sqft: 786,
    });
    expect(listings.find((l) => l.unitNumber === "0704")!.availableDate).toBe("2027-01-19");
    // A 12-month lease on 0625 costs exactly its headline price — the unit
    // the old cap threw away as having "no in-cap price".
    const u0625 = listings.find((l) => l.unitNumber === "0625")!;
    expect(u0625.leaseTerms!.find((t) => t.months === 12)!.price).toBe(3529);
  });

  it("links each unit to the site's own apply page for that unit and term", async () => {
    const { listings } = await run(sightmap, "1225-old-town");
    for (const l of listings) {
      expect(l.url).toMatch(/^https:\/\/www\.1225oldtown\.com\/OnlineLeasing\.aspx\?/);
      expect(l.url).toContain("LeaseTerm=18");
      expect(l.url).toContain(`MoveInDate=${l.availableDate}`);
    }
  });
});

describe("sightmap adapter (lease-term API behaviour)", () => {
  const payload = (units: object[]) => ({
    data: {
      floors: [],
      floor_plans: [{ id: "p1", name: "S1", bedroom_count: 0, bathroom_count: 1 }],
      units,
    },
  });
  const unit = (over: object) => ({
    id: "u1",
    unit_number: "0901",
    floor_id: "f",
    floor_plan_id: "p1",
    price: 2200,
    area: 500,
    available_on: "2026-12-26",
    display_available_on: "Available Dec 26th",
    display_lease_term: "18 Months",
    leasing_price_url: "https://sightmap.com/app/api/v1/leasing/x/unit/u1?sightmap_id=1&currency_code=USD",
    ...over,
  });

  it("asks for the lease table on the unit's own move-in day", async () => {
    // The real API answers {"options": []} for a not-yet-vacant unit unless
    // the request names a date on/after its move-in day.
    const asked: string[] = [];
    const ctx: AdapterContext = {
      fetch: (async (url: string | URL | Request) => {
        const u = String(url);
        if (!u.includes("/leasing/")) return new Response(JSON.stringify(payload([unit({})])));
        asked.push(u);
        const options = new URL(u).searchParams.get("date") === "2026-12-26"
          ? [
              { lease_term: 12, price: 2450, apply_url: "https://example.com/apply?t=12" },
              { lease_term: 18, price: 2200, apply_url: "https://example.com/apply?t=18" },
            ]
          : [];
        return new Response(JSON.stringify({ data: { default_option: 0, options } }));
      }) as typeof fetch,
      log: () => {},
      now: () => CAPTURED,
    };
    const [l] = await sightmap.scrape({ ...buildingById("1225-old-town") }, ctx);
    expect(asked).toHaveLength(1);
    expect(new URL(asked[0]!).searchParams.get("date")).toBe("2026-12-26");
    expect(l).toMatchObject({
      unitNumber: "0901",
      price: 2200,
      leaseTermMonths: 18,
      leaseTerms: [
        { months: 12, price: 2450 },
        { months: 18, price: 2200 },
      ],
      availableDate: "2026-12-26",
      availableNow: false,
      url: "https://example.com/apply?t=18",
    });
  });

  it("never drops a unit because of its lease term or a failed lease-table request", async () => {
    const logs: string[] = [];
    const ctx: AdapterContext = {
      fetch: (async (url: string | URL | Request) => {
        if (String(url).includes("/leasing/")) return new Response("nope", { status: 500 });
        return new Response(
          JSON.stringify(
            payload([
              unit({ display_lease_term: "24 Months", price: 2100 }),
              unit({ id: "u2", unit_number: "0902", leasing_price_url: null, display_lease_term: null }),
            ]),
          ),
        );
      }) as typeof fetch,
      log: (m) => logs.push(m),
      now: () => CAPTURED,
    };
    const listings = await sightmap.scrape({ ...buildingById("1225-old-town") }, ctx);
    expect(listings.map((l) => l.unitNumber)).toEqual(["0901", "0902"]);
    expect(listings[0]).toMatchObject({ price: 2100, leaseTermMonths: 24 });
    expect(listings[0]!.leaseTerms).toBeUndefined();
    expect(listings[1]!.leaseTermMonths).toBeNull();
    expect(logs.some((m) => m.includes("lease terms for unit 0901 unavailable"))).toBe(true);
  });

  it("flags a vacant unit as available now from either the label or the date", async () => {
    const ctx: AdapterContext = {
      fetch: (async () =>
        new Response(
          JSON.stringify(
            payload([
              unit({ available_on: "2026-11-15", display_available_on: "Available Now", leasing_price_url: null }),
              unit({ id: "u2", unit_number: "0902", available_on: "2026-11-10", display_available_on: null, leasing_price_url: null }),
              unit({ id: "u3", unit_number: "0903", available_on: null, display_available_on: null, leasing_price_url: null }),
            ]),
          ),
        )) as typeof fetch,
      log: () => {},
      now: () => CAPTURED,
    };
    const listings = await sightmap.scrape({ ...buildingById("1225-old-town") }, ctx);
    expect(listings.map((l) => [l.unitNumber, l.availableDate, l.availableNow])).toEqual([
      ["0901", "2026-11-15", true],
      ["0902", "2026-11-10", true],
      ["0903", null, undefined],
    ]);
  });

  it("builds dated leasing URLs without disturbing the other parameters", () => {
    const base = "https://sightmap.com/app/api/v1/leasing/x/unit/1?sightmap_id=87594&currency_code=USD";
    expect(leasingUrlForDate(base, "2026-12-26")).toBe(`${base}&date=2026-12-26`);
    expect(leasingUrlForDate(base, null)).toBe(base);
    expect(leasingUrlForDate(base, "12/26/2026")).toBe(base);
  });

  it("parses the documented options shape and tolerates unknown shapes", async () => {
    const t = parseLeaseTable({
      data: {
        default_option: 1,
        options: [
          { lease_term: 18, price: 3774, apply_url: "https://x.example/a?LeaseTerm=18" },
          { lease_term: 12, price: 4955.4, apply_url: "javascript:alert(1)" },
          { lease_term: 99, price: 100 }, // junk row
        ],
      },
    });
    expect(t.terms).toEqual([
      { months: 12, price: 4955 },
      { months: 18, price: 3774 },
    ]);
    expect([...t.applyUrls.keys()]).toEqual([18]);

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
    expect(parseLeaseTable({ terms: [{ months: 14, rent: 2395 }] }).terms).toEqual([
      { months: 14, price: 2395 },
    ]);
    expect(parseLeaseTable(null).terms).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Old Town Park
// ---------------------------------------------------------------------------

describe("oldtownpark adapter (captured 2026-11-15)", () => {
  it("gives every unit its move-in date — 'Available' and M/D/YYYY alike", async () => {
    for (const id of ["old-town-park-1", "old-town-park-2", "old-town-park-3"]) {
      const { listings } = await run(oldtownpark, id);
      expect(listings.length).toBeGreaterThanOrEqual(15);
      expectSaneListings(listings);
      // The regression: future-dated units used to come back with null.
      expect(listings.filter((l) => l.availableDate === null)).toEqual([]);
      expect(listings.some((l) => l.availableNow === false)).toBe(true);
      expect(listings.some((l) => l.availableNow === true)).toBe(true);
      expect(listings.every((l) => /^\d{3,4}$/.test(l.unitNumber ?? ""))).toBe(true);
    }
  });

  it("reads the printed dates exactly (tower 1)", async () => {
    const { listings } = await run(oldtownpark, "old-town-park-1");
    expect(listings).toHaveLength(19);
    const by = (n: string) => listings.find((l) => l.unitNumber === n)!;
    expect(by("2111")).toMatchObject({ availableDate: "2026-12-18", availableNow: false, price: 3359, priceMax: 3514, beds: 1 });
    expect(by("2906")).toMatchObject({ availableDate: "2027-01-22", availableNow: false });
    expect(by("2313")).toMatchObject({ availableDate: "2026-11-15", availableNow: true, price: 2457, priceMax: 2478, beds: 0 });
    expect(by("0619")).toMatchObject({ availableDate: "2026-12-10", beds: 0 });
  });

  it("separates interior from outdoor square footage", async () => {
    const { listings } = await run(oldtownpark, "old-town-park-1");
    const by = (n: string) => listings.find((l) => l.unitNumber === n)!;
    expect(by("1004")).toMatchObject({ sqft: 690, outdoorSqft: 69 }); // "Total SQFT: 759"
    expect(by("2313").sqft).toBe(565);
    expect(by("2313").outdoorSqft).toBeUndefined(); // "Outdoor: 0"
    expect(listings.every((l) => l.sqft !== null)).toBe(true);
  });

  it("deep-links each unit to its page in the leasing portal", async () => {
    const { listings } = await run(oldtownpark, "old-town-park-1");
    const u = listings.find((l) => l.unitNumber === "2313")!;
    expect(u.url).toContain("oldtownpark.securecafe.com");
    expect(u.url).toContain("UnitID=35648567");
    expect(u.url).not.toContain("&amp;");
  });

  it("reports penthouse / townhome rows instead of dropping them, and the site-wide special", async () => {
    const { listings, alsoListed, notices } = await run(oldtownpark, "old-town-park-3");
    expect(listings).toHaveLength(20);
    expect(alsoListed.map((a) => a.unitNumber)).toEqual(["4003", "0105"]);
    expect(alsoListed[0]).toMatchObject({
      beds: null,
      note: "Penthouse — Contact for Pricing",
      sqft: 2039,
      outdoorSqft: 1400,
    });
    expect(alsoListed[0]!.price).toBeUndefined(); // data-rent-min="23599" is not a quote
    expect(alsoListed[1]).toMatchObject({
      beds: null,
      price: 8230,
      priceMax: 8548,
      note: "Townhomes — bed count not published",
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("$1,000 Rent Credit");
    // "Inquire" on a button is not "no price": those units stay regular listings.
    expect(listings.find((l) => l.unitNumber === "1703")).toMatchObject({
      price: 2330,
      availableDate: "2026-11-26",
    });
  });

  it("treats a tower with the availability block but no rows as fully leased, not broken", async () => {
    const fullyLeased = `<section><div class="yard__availability"></div>
      <div class="yard__no-results"><h3>ONE Old Town Park is fully leased.</h3></div></section>`;
    const ctx = (html: string): AdapterContext => ({
      fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }),
      log: () => {},
      now: () => CAPTURED,
    });
    await expect(oldtownpark.scrape(buildingById("old-town-park-1"), ctx(fullyLeased))).resolves.toEqual([]);
    await expect(
      oldtownpark.scrape(buildingById("old-town-park-1"), ctx("<html><body>Just a moment...</body></html>")),
    ).rejects.toThrow(/page structure may have changed/);
  });

  it("keeps $0 placeholder rows out of the price list but on the record", () => {
    const html = `
      <div class="js-plan-group" data-plan-slug="s1" data-cat="Convertible">
        <div class="yard__unit" data-unit="1501" data-rent-min="3200" data-rent-max="3400">
          Available Now Total SQFT: 565
        </div>
        <div class="yard__unit" data-unit="1502" data-rent-min="0" data-rent-max="0">
          Available Now Total SQFT: 565
        </div>
      </div>`;
    const page = parseOldTownParkPage(html, "https://oldtownpark.com/availability-tower-3", CAPTURED);
    expect(page.listings.map((l) => l.unitNumber)).toEqual(["1501"]);
    expect(page.listings[0]).toMatchObject({ availableDate: "2026-11-15", availableNow: true, priceMax: 3400 });
    expect(page.alsoListed).toEqual([
      expect.objectContaining({ unitNumber: "1502", beds: 0, note: "No price published" }),
    ]);
  });
});

describe("oldtownpark adapter (legacy Aug 2026 markup)", () => {
  it("still parses every unit card on the old tower-1 capture", async () => {
    const { listings } = await run(oldtownpark, "old-town-park-1", "legacy-2026-09/old-town-park-1");
    expect(listings.length).toBeGreaterThanOrEqual(25); // page had 29 unit cards
    expect(listings.every((l) => /^\d{3,4}$/.test(l.unitNumber ?? ""))).toBe(true);
    expect(listings.every((l) => l.price >= 1500 && l.price <= 15000)).toBe(true);
    expect(listings.some((l) => l.priceMax !== undefined && l.priceMax > l.price)).toBe(true);
    expect(listings.every((l) => l.sqft !== null)).toBe(true);
    expect(listings.every((l) => l.availableDate === null || ISO_DAY.test(l.availableDate))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The Leo
// ---------------------------------------------------------------------------

describe("leo adapter (captured 2026-11-15)", () => {
  it("parses the two listed units with the site's 'Available Now' flag", async () => {
    const { listings, alsoListed } = await run(leo, "the-leo");
    expectSaneListings(listings);
    expect(alsoListed).toEqual([]);
    expect(listings).toHaveLength(2);
    expect(listings.find((l) => l.unitNumber === "705")).toMatchObject({
      beds: 1,
      baths: 1,
      sqft: 712,
      price: 3093,
      floorplanName: "1 BR",
      // Vacant since September — the site says "Available Now".
      availableDate: "2026-09-22",
      availableNow: true,
    });
    expect(listings.find((l) => l.unitNumber === "602")).toMatchObject({
      beds: 1,
      sqft: 508,
      price: 2635,
      floorplanName: "JR 1 BR",
      availableNow: true,
    });
    expect(listings[0]!.url).toMatch(/^https:\/\/leochicago\.com\/floorplans\/unit-/);
  });

  it("treats a real page with an empty inventory blob as 'nothing listed', not a failure", async () => {
    const html = `<html><body><script id="jd-fp-data-script-app" type="application/json">${JSON.stringify(
      { version: "1.12.0", units: [], floorplans: [] },
    )}</script></body></html>`;
    const logs: string[] = [];
    const ctx: AdapterContext = {
      fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }),
      log: (m) => logs.push(m),
      now: () => CAPTURED,
    };
    // Must return without falling back to a browser (which would time out here).
    await expect(leo.scrape(buildingById("the-leo"), ctx)).resolves.toEqual([]);
    expect(logs.join(" ")).toContain("lists nothing right now");
    expect(parseLeoInventory(html, "https://leochicago.com/", CAPTURED).sawInventory).toBe(true);
    expect(parseLeoInventory("<html></html>", "https://leochicago.com/", CAPTURED).sawInventory).toBe(false);
  });

  it("reports a unit without a price instead of silently dropping it", () => {
    const html = `<script id="jd-fp-data-script-app" type="application/json">${JSON.stringify({
      units: [
        { apartment_number: "1201", bedrooms: "2", bathrooms: "2", square_feet: "1100", rent_min: null, available_display: "Available Now" },
        { apartment_number: "408", bedrooms: "Studio", bathrooms: "1", square_feet: "467", rent_min: "2350", rent_max: "2500", available_date: "1797400800", available_display: "Available Dec 16" },
      ],
    })}</script>`;
    const page = parseLeoInventory(html, "https://leochicago.com/", CAPTURED);
    expect(page.listings).toHaveLength(1);
    expect(page.listings[0]).toMatchObject({
      unitNumber: "408",
      beds: 0,
      price: 2350,
      priceMax: 2500,
      availableDate: "2026-12-16",
      availableNow: false,
    });
    expect(page.alsoListed).toEqual([
      expect.objectContaining({ unitNumber: "1201", beds: 2, note: "No price published", availableNow: true }),
    ]);
  });
});

describe("leo adapter (legacy Aug 2026 capture)", () => {
  const dir = join(ROOT, "scraper", "fixtures", "legacy-2026-09", "the-leo");

  it("parses unit-level cards with sqft, baths and future move-in dates", async () => {
    const { listings } = await run(leo, "the-leo", "legacy-2026-09/the-leo");
    expect(listings.length).toBeGreaterThanOrEqual(8); // page had 9 cards
    expect(listings.filter((l) => l.unitNumber !== null).length).toBeGreaterThanOrEqual(8);
    expect(listings.every((l) => l.sqft !== null && l.baths !== null)).toBe(true);
    const studio408 = listings.find((l) => l.unitNumber === "408");
    expect(studio408).toMatchObject({ beds: 0, sqft: 467, baths: 1, availableDate: "2026-08-27" });
    expect(studio408!.price).toBeGreaterThan(1800);
    expect(studio408!.price).toBeLessThan(3200);
  });

  it("prefers the embedded Jonah JSON over card markup", () => {
    const html = readFileSync(join(dir, "00-floorplans.html"), "utf8");
    const listings = parseLeoPage(html, "https://leochicago.com/");
    expect(listings.length).toBeGreaterThanOrEqual(8);
    expect(listings.every((l) => /^\d{3,4}$/.test(l.unitNumber ?? ""))).toBe(true);
    expect(listings.every((l) => l.availableDate === null || ISO_DAY.test(l.availableDate))).toBe(true);
  });

  it("recognizes Imunify360 WAF bodies so we retry instead of treating them as empty inventory", () => {
    const waf = JSON.stringify({
      message: "Access denied by Imunify360 bot-protection. IPs used for automation should be whitelisted",
    });
    expect(isWafPage(waf)).toBe(true);
    expect(isWafPage("<html><body>floorplans</body></html>")).toBe(false);
    expect(parseLeoPage('{"message":"Access denied by Imunify360 bot-protection."}', "https://leochicago.com/")).toEqual([]);
    // A WAF body carries no inventory blob, so it can never pass for "empty building".
    expect(parseLeoInventory(waf, "https://leochicago.com/", CAPTURED).sawInventory).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stead 220
// ---------------------------------------------------------------------------

describe("stead220 adapter (captured 2026-11-15)", () => {
  it("parses the floorplan catalogue honestly: stacks stay stacks, penthouses are units", async () => {
    const { listings, alsoListed } = await run(stead220, "stead-220");
    expectSaneListings(listings);
    expect(listings).toHaveLength(13);
    // No fabricated unit numbers below the penthouse floor.
    expect(listings.filter((l) => l.unitNumber !== null).map((l) => l.unitNumber).sort()).toEqual([
      "2802",
      "2803",
      "2809",
    ]);
    expect(listings.find((l) => l.floorplanName === "Large Studio - Unit 01")).toMatchObject({
      unitNumber: null,
      beds: 0,
      baths: 1,
      price: 2475,
      availableDate: "2026-11-15",
      availableNow: true,
      url: "https://stead220.com/floorplans/1",
    });
    expect(listings.find((l) => l.floorplanName === "Medium 2BR - Unit 09")).toMatchObject({
      beds: 2,
      baths: 2,
      price: 4670,
    });
    // "Contact for Pricing" plans are reported, not dropped.
    expect(alsoListed.map((a) => [a.floorplanName, a.note, a.beds])).toEqual([
      ["Medium Studio - Unit 05", "Contact for Pricing", 0],
      ["Large Studio - Unit 13", "Contact for Pricing", 0],
    ]);
  });

  it("records when the building last edited each price (its catalogue is hand-maintained)", async () => {
    const { listings } = await run(stead220, "stead-220");
    expect(listings.every((l) => typeof l.sourceUpdatedAt === "string")).toBe(true);
    expect(listings.find((l) => l.unitNumber === "2802")!.sourceUpdatedAt).toBe("2026-07-09T21:40:11.000Z");
  });

  it("makes exactly one request (the plan pages carry no extra data)", async () => {
    let requests = 0;
    const base = makeFixtureFetch(join(ROOT, "scraper", "fixtures", "stead-220"));
    const ctx: AdapterContext = {
      fetch: (async (input: string | URL | Request) => {
        requests++;
        return base(input);
      }) as typeof fetch,
      log: () => {},
      now: () => CAPTURED,
    };
    await stead220.scrape(buildingById("stead-220"), ctx);
    expect(requests).toBe(1);
  });

  it("falls back to card markup when the embedded data is missing, and vice versa", () => {
    const html = readFileSync(join(ROOT, "scraper/fixtures/stead-220/00-floorplans.html"), "utf8");
    expect(extractSsrData(html)).not.toBeNull();
    const cardsOnly = html.replace("window.__SSR_DATA__=", "window.__NOPE__=");
    expect(extractSsrData(cardsOnly)).toBeNull();
    const a = parseSteadFloorplans(cardsOnly, "https://stead220.com/", CAPTURED);
    expect(a.listings).toHaveLength(13);
    expect(a.alsoListed).toHaveLength(2);
    expect(a.listings.every((l) => l.sourceUpdatedAt === undefined)).toBe(true);
    const full = parseSteadFloorplans(html, "https://stead220.com/", CAPTURED);
    expect(a.listings.map((l) => [l.floorplanName, l.price, l.beds])).toEqual(
      full.listings.map((l) => [l.floorplanName, l.price, l.beds]),
    );
    expect(parseSteadFloorplans("<html></html>", "https://stead220.com/", CAPTURED).planCount).toBe(0);
  });

  it("reports waitlist plans as not available instead of listing them", () => {
    const html = `<div class="floorplan-card"><div class="fp-card-carousel" aria-label="Large Studio - Unit 01 preview gallery"></div>
      <span class="fp-availability-label">Join Waitlist</span><h3 class="fp-card-name">STUDIO</h3>
      <p class="fp-card-meta">LARGE · UNIT 01 · 1 BATH</p><span class="fp-card-price-amount">$2,475</span>
      <a href="/floorplans/1">View</a></div>`;
    const page = parseSteadFloorplans(html, "https://stead220.com/", CAPTURED);
    expect(page.listings).toEqual([]);
    expect(page.alsoListed).toEqual([
      expect.objectContaining({ floorplanName: "Large Studio - Unit 01", note: "Join Waitlist", price: 2475 }),
    ]);
  });
});

describe("stead220 adapter (legacy Aug 2026 capture)", () => {
  it("still parses the old floorplan cards", async () => {
    const { listings } = await run(stead220, "stead-220", "legacy-2026-09/stead-220");
    expect(listings.length).toBeGreaterThanOrEqual(10);
    expect(listings.every((l) => l.unitNumber === null || /^\d{3,4}[A-Z]?$/i.test(l.unitNumber))).toBe(true);
    expect(listings.some((l) => /unit\s*\d+/i.test(l.floorplanName))).toBe(true);
    const studio = listings.find((l) => l.beds === 0);
    expect(studio).toBeDefined();
    expect(studio!.price).toBeGreaterThanOrEqual(2000);
  });
});

describe("sightmap adapter (legacy Sep 2026 capture)", () => {
  it("still maps the old payload, now without dropping its 18-month units", async () => {
    const { listings } = await run(sightmap, "1225-old-town", "legacy-2026-09/1225-old-town");
    expect(listings.length).toBeGreaterThanOrEqual(4);
    expect(listings.every((l) => /^\d{3,4}$/.test(l.unitNumber ?? ""))).toBe(true);
    expect(listings.every((l) => !l.floorplanName.includes("{"))).toBe(true);
    expect(listings.every((l) => l.leaseTermMonths != null)).toBe(true);
    const known = listings.find((l) => l.unitNumber === "0624");
    expect(known).toMatchObject({ beds: 0, sqft: 546 });
    // Unit 1308 was one of the over-cap teasers the cap used to throw away.
    expect(listings.find((l) => l.unitNumber === "1308")).toBeDefined();
  });
});
