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
import { leo, isWafPage, parseLeoCards, parseLeoInventory, parseLeoPage } from "../src/adapters/leo";
import { oldtownpark, parseOldTownParkPage } from "../src/adapters/oldtownpark";
import { leasingUrlForDate, parseLeaseTable, sightmap } from "../src/adapters/sightmap";
import { extractSsrData, parseSteadFloorplans, stead220 } from "../src/adapters/stead220";
import { SiteBlockedError, type AdapterContext } from "../src/adapters/types";
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

/** When the legacy fixtures were captured (early August 2026). */
const LEGACY_CAPTURED = new Date("2026-08-04T15:00:00Z");

async function run(
  adapter: { scrape: (typeof sightmap)["scrape"] },
  buildingId: string,
  dir = buildingId,
  now: Date = dir.startsWith("legacy-") ? LEGACY_CAPTURED : CAPTURED,
): Promise<Run> {
  const out: Run = { listings: [], alsoListed: [], notices: [], logs: [] };
  out.listings = await adapter.scrape(buildingById(buildingId), ctxFor(dir, out, now));
  for (const l of out.listings) UnitListingSchema.parse(l);
  for (const a of out.alsoListed) AlsoListedSchema.parse(a);
  return out;
}

/** Invariants every adapter's output must satisfy, whatever the site. */
function expectSaneListings(listings: UnitListing[], today = "2026-11-15"): void {
  const seen = new Set<string>();
  for (const l of listings) {
    expect(l.price).toBeGreaterThanOrEqual(400);
    expect(l.price).toBeLessThanOrEqual(25000);
    if (l.priceMax !== undefined) expect(l.priceMax).toBeGreaterThan(l.price);
    if (l.availableDate !== null) expect(l.availableDate).toMatch(ISO_DAY);
    // The flag and the date may never contradict each other.
    if (l.availableNow === false) expect(l.availableDate! > today).toBe(true);
    if (l.availableNow === true) expect(l.availableDate).toBe(today);
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

  it("records the mandatory monthly fees the site adds on top of base rent", async () => {
    const { listings } = await run(sightmap, "1225-old-town");
    // The site headlines "$2,482 – $2,612" for 0812: $2,382 base + $100–$230.
    expect(listings.every((l) => l.monthlyFees?.min === 100 && l.monthlyFees?.max === 230)).toBe(true);
  });

  it("picks up the site-wide special and real vacancy dates from the marketing page", async () => {
    const { listings, notices } = await run(sightmap, "1225-old-town");
    expect(notices).toEqual([
      "Limited-Time Offer: Now Offering $1,500 Off Base Rent on Select Units! — Contact us today to schedule a tour.",
    ]);
    // SightMap only says "today" for a vacant unit; the marketing page knows
    // 1308 has been sitting empty since September 1st.
    expect(listings.find((l) => l.unitNumber === "1308")).toMatchObject({
      availableDate: "2026-11-15",
      availableNow: true,
      vacantSince: "2026-09-01",
    });
    // Units that are not vacant yet have no vacancy date.
    expect(listings.filter((l) => l.availableNow === false).every((l) => l.vacantSince === undefined)).toBe(true);
    expect(listings.filter((l) => l.availableNow === true).every((l) => typeof l.vacantSince === "string")).toBe(true);
  });
});

describe("sightmap adapter (marketing page is optional)", () => {
  it("lists every unit even when the marketing page is refused or missing", async () => {
    const base = makeFixtureFetch(join(ROOT, "scraper", "fixtures", "1225-old-town"));
    for (const body of [
      new Response('{"message":"Access denied by Imunify360 bot-protection."}', { status: 200 }),
      new Response("nope", { status: 403 }),
    ]) {
      const logs: string[] = [];
      const notices: string[] = [];
      const ctx: AdapterContext = {
        fetch: (async (input: string | URL | Request) =>
          String(input).includes("1225oldtown.com/floorplans") ? body.clone() : base(input)) as typeof fetch,
        log: (m) => logs.push(m),
        now: () => CAPTURED,
        reportNotice: (t) => notices.push(t),
      };
      const listings = await sightmap.scrape(buildingById("1225-old-town"), ctx);
      expect(listings).toHaveLength(15);
      expect(listings.every((l) => (l.leaseTerms?.length ?? 0) === 17)).toBe(true);
      expect(listings.every((l) => l.vacantSince === undefined)).toBe(true);
      expect(notices).toEqual([]);
      expect(logs.some((m) => m.includes("specials and vacancy dates skipped"))).toBe(true);
    }
  });

  it("parses announcements and vacancy dates out of a marketing page", async () => {
    const { parseMarketingPage } = await import("../src/adapters/sightmap");
    const html = `<html><head>
      <script type="application/ld+json">{"@graph":[{"@type":"ApartmentComplex","jonah:announcements":[
        {"jonah:name":"Two Months Free","jonah:description":"On 14-month leases."},
        {"jonah:name":"Two Months Free","jonah:description":"On 14-month leases."}]}]}</script>
      <script type="application/ld+json">{ not json</script></head><body>
      <script id="jd-fp-data-script-app" type="application/json">${JSON.stringify({
        units: [
          { id_value: "10028890", available_date: 1788238800 },
          { id_value: "10028757", available_date: "1798264800" },
          { id_value: "x", available_date: null },
        ],
      })}</script></body></html>`;
    const extras = parseMarketingPage(html);
    expect(extras.notices).toEqual(["Two Months Free — On 14-month leases."]);
    expect(extras.vacantSince.get("10028890")).toBe("2026-09-01");
    expect(extras.vacantSince.get("10028757")).toBe("2026-12-26");
    expect(extras.vacantSince.has("x")).toBe(false);
    expect(parseMarketingPage("<html></html>")).toEqual({ notices: [], vacantSince: new Map() });
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

describe("sightmap adapter (rows that are not ordinary units)", () => {
  const plans = [
    { id: "p1", name: "S1", bedroom_count: 0, bathroom_count: 1, bedroom_label: "Studio" },
    // The real payload carries this placeholder: no label, no bathrooms.
    { id: "tmp", name: "TEMP", bedroom_count: 0, bathroom_count: 0, bedroom_label: null, filter_label: "Coming Soon" },
    { id: "cv", name: '{"name":"bhre1.1 Convertible ","provider_id":"28"}', bedroom_count: 0, bathroom_count: 1, bedroom_label: "Studio", filter_label: "bhre1.1 Convertible" },
  ];
  const u = (over: object) => ({
    id: "u1",
    unit_number: "0901",
    floor_id: "f",
    floor_plan_id: "p1",
    price: 2200,
    area: 500,
    available_on: "2026-11-15",
    display_available_on: "Available Now",
    display_lease_term: "12 Months",
    leasing_price_url: null,
    ...over,
  });
  const scrape = async (units: object[]) => {
    const alsoListed: AlsoListed[] = [];
    const logs: string[] = [];
    const ctx: AdapterContext = {
      fetch: (async (input: string | URL | Request) =>
        String(input).includes("sightmaps/")
          ? new Response(JSON.stringify({ data: { floors: [], floor_plans: plans, units } }))
          : new Response("", { status: 404 })) as typeof fetch,
      log: (m) => logs.push(m),
      now: () => CAPTURED,
      reportAlsoListed: (row) => alsoListed.push(row),
    };
    const listings = await sightmap.scrape({ ...buildingById("1225-old-town") }, ctx);
    return { listings, alsoListed, logs };
  };

  it("does not file a 'Coming Soon' placeholder plan as a studio", async () => {
    const { listings, alsoListed } = await scrape([
      u({}),
      u({ id: "u2", unit_number: "0902", floor_plan_id: "tmp" }),
    ]);
    expect(listings.map((l) => l.unitNumber)).toEqual(["0901"]);
    expect(alsoListed).toEqual([
      expect.objectContaining({
        unitNumber: "0902",
        beds: null,
        price: 2200,
        note: "Coming Soon — bed count not published",
      }),
    ]);
  });

  it("keeps unpriced and plan-less rows on the record instead of skipping them silently", async () => {
    const { listings, alsoListed, logs } = await scrape([
      u({ price: 0 }),
      u({ id: "u2", unit_number: "0902", floor_plan_id: "missing" }),
    ]);
    expect(listings).toEqual([]);
    expect(alsoListed.map((a) => [a.unitNumber, a.note, a.beds])).toEqual([
      ["0901", "No price published", 0],
      ["0902", "Floor plan not published", null],
    ]);
    expect(logs.filter((m) => m.includes("also-listed"))).toHaveLength(2);
  });

  it("labels convertible plans, which the site files under studios", async () => {
    const { listings } = await scrape([u({ floor_plan_id: "cv" }), u({ id: "u2", unit_number: "0902" })]);
    expect(listings.map((l) => [l.unitNumber, l.beds, l.planType])).toEqual([
      ["0901", 0, "Convertible"],
      ["0902", 0, undefined],
    ]);
  });

  it("asks the start-dates endpoint when the payload's date gets an empty table", async () => {
    const asked: string[] = [];
    const ctx: AdapterContext = {
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("sightmaps/")) {
          return new Response(
            JSON.stringify({
              data: {
                floors: [],
                floor_plans: plans,
                units: [
                  u({
                    available_on: "2026-12-01",
                    display_available_on: "Available Dec 1st",
                    leasing_price_url: "https://sightmap.com/app/api/v1/leasing/x/unit/u1?sightmap_id=1",
                    leasing_start_dates_url: "https://sightmap.com/app/api/v1/leasing/x/unit/u1/start-dates",
                  }),
                ],
              },
            }),
          );
        }
        if (!url.includes("/leasing/")) return new Response("", { status: 404 }); // marketing page
        asked.push(url);
        if (url.includes("start-dates")) {
          return new Response(JSON.stringify({ data: ["2026-12-04", "2026-12-03", "garbage"] }));
        }
        const options =
          new URL(url).searchParams.get("date") === "2026-12-03" ? [{ lease_term: 12, price: 2200 }] : [];
        return new Response(JSON.stringify({ data: { default_option: 0, options } }));
      }) as typeof fetch,
      log: () => {},
      now: () => CAPTURED,
    };
    const [l] = await sightmap.scrape({ ...buildingById("1225-old-town") }, ctx);
    expect(asked.map((a) => new URL(a).searchParams.get("date") ?? "start-dates")).toEqual([
      "2026-12-01",
      "start-dates",
      "2026-12-03",
    ]);
    expect(l!.leaseTerms).toEqual([{ months: 12, price: 2200 }]);
    // The listing still says what the site says about move-in.
    expect(l!.availableDate).toBe("2026-12-01");
  });

  it("keeps lease-term rows above the ordinary rent ceiling (short leases are quoted that high)", () => {
    const t = parseLeaseTable({
      data: { options: [{ lease_term: 2, price: 28174 }, { lease_term: 12, price: 5095 }] },
    });
    expect(t.terms).toEqual([
      { months: 2, price: 28174 },
      { months: 12, price: 5095 },
    ]);
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

describe("oldtownpark adapter (plan types and integrity checks)", () => {
  const page = (rows: string, bodyClass = "page-availability-tower-3") => `<html>
    <body class="en-US template-availability ${bodyClass}"><div class="yard__availability">${rows}</div></body></html>`;
  const group = (cat: string, feature: string, inner: string) =>
    `<div class="js-plan-group" data-cat="${cat}" data-plan-slug="x"><p class="feature">${feature}</p>${inner}</div>`;
  const row = (unit: string, attrs: string, head: string) =>
    `<div class="yard__unit" data-unit="${unit}" ${attrs}><div class="yard__unit__col yard__unit__col--1">${head}</div>
       <div class="yard__unit__col--2">Total SQFT: 915 Indoor: 858 Outdoor: 57</div></div>`;
  const ctx = (html: string, logs: string[] = []): AdapterContext => ({
    fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }),
    log: (m) => logs.push(m),
    now: () => CAPTURED,
  });

  it("keeps the site's unit-type label where it says more than the bed count", async () => {
    const { listings } = await run(oldtownpark, "old-town-park-3");
    const by = (n: string) => listings.find((l) => l.unitNumber === n)!;
    // Plan B is a JUNIOR two-bed; it used to pass for a regular 2 BR.
    expect(by("2410")).toMatchObject({ beds: 2, planType: "Jr. 2 Bed", price: 3938 });
    expect(by("0801")).toMatchObject({ beds: 2 });
    expect(by("0801").planType).toBeUndefined(); // a plain "2 Bed"
    expect(by("2605")).toMatchObject({ beds: 0, planType: "Convertible" });
    const t1 = await run(oldtownpark, "old-town-park-1");
    expect(t1.listings.find((l) => l.unitNumber === "0203")).toMatchObject({
      beds: 1,
      planType: "1 Bed + Flex",
    });
  });

  it("trusts the printed price over the data attribute and says so", async () => {
    const logs: string[] = [];
    const html = page(
      group(
        "2-br",
        "2 Bed",
        row("0801", 'data-rent-min="4,096" data-rent-max="4462"', "#801 $4,096 - $4,462 <span class=\"label\">Available</span>") +
          row("0901", 'data-rent-min="4000" data-rent-max="4000"', "#901 $4,512 - $4,904 <span class=\"label\">11/26/2026</span>"),
      ),
    );
    const listings = await oldtownpark.scrape(buildingById("old-town-park-3"), ctx(html, logs));
    expect(listings.map((l) => [l.unitNumber, l.price, l.priceMax, l.availableDate])).toEqual([
      ["0801", 4096, 4462, "2026-11-15"], // "4,096" in the attribute is still 4096
      ["0901", 4512, 4904, "2026-11-26"],
    ]);
    expect(logs.some((m) => m.includes("unit 0901: page prints $4512 but its data attribute says $4000"))).toBe(true);
    expect(logs.some((m) => m.includes("2 rows on the page → 2 units"))).toBe(true);
  });

  it("publishes a printed price above the ordinary rent ceiling instead of dropping the row", async () => {
    const html = page(
      group("penthouse", "Penthouse", row("4001", 'data-rent-min="28000" data-rent-max="28000"', "#4001 $28,000 <span class=\"label\">Available</span>")),
    );
    const alsoListed: AlsoListed[] = [];
    const c = ctx(html);
    c.reportAlsoListed = (r) => alsoListed.push(r);
    await expect(oldtownpark.scrape(buildingById("old-town-park-3"), c)).resolves.toEqual([]);
    expect(alsoListed).toEqual([
      expect.objectContaining({
        unitNumber: "4001",
        beds: null,
        price: 28000,
        sqft: 858,
        outdoorSqft: 57,
        note: "Penthouse — bed count not published",
      }),
    ]);
  });

  it("refuses a page that belongs to another tower, and a building without a towerPath", async () => {
    const html = page(
      group("2-br", "2 Bed", row("0801", 'data-rent-min="4096" data-rent-max="4462"', "#801 $4,096 <span class=\"label\">Available</span>")),
      "page-availability-tower-1",
    );
    await expect(oldtownpark.scrape(buildingById("old-town-park-3"), ctx(html))).rejects.toThrow(
      /served the page for availability-tower-1, not availability-tower-3/,
    );
    const { adapterOptions: _dropped, ...noTower } = buildingById("old-town-park-3");
    await expect(oldtownpark.scrape(noTower, ctx(html))).rejects.toThrow(/needs adapterOptions\.towerPath/);
  });

  it("reports duplicate unit rows instead of silently merging them", async () => {
    const logs: string[] = [];
    const html = page(
      group(
        "2-br",
        "2 Bed",
        row("0801", 'data-rent-min="4096" data-rent-max="4462"', "#801 $4,096 <span class=\"label\">Available</span>") +
          row("0801", 'data-rent-min="4200" data-rent-max="4200"', "#801 $4,200 <span class=\"label\">Available</span>"),
      ),
    );
    const listings = await oldtownpark.scrape(buildingById("old-town-park-3"), ctx(html, logs));
    expect(listings).toHaveLength(1);
    expect(logs.join("\n")).toContain("1 duplicate unit row(s)");
    expect(logs.join("\n")).toContain("1 NOT accounted for");
  });
});

describe("oldtownpark adapter (legacy Aug 2026 markup)", () => {
  it("reads the August dates the old parser dropped, and the old special", async () => {
    const out = await run(oldtownpark, "old-town-park-1", "legacy-2026-09/old-town-park-1");
    const dated = out.listings.filter((l) => l.availableNow === false);
    // 19 of the 28 rows on that capture were future-dated ("8/22/2026" …).
    expect(out.listings).toHaveLength(28);
    expect(dated).toHaveLength(19);
    expect(out.listings.filter((l) => l.availableDate === null)).toEqual([]);
    expect(out.listings.find((l) => l.unitNumber === "2313")!.availableDate).toBe("2026-08-22");
    expect(out.notices[0]).toContain("Summer Savings");
  });

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
    const { listings, alsoListed, notices, logs } = await run(leo, "the-leo");
    expectSaneListings(listings);
    expect(alsoListed).toEqual([]);
    expect(listings).toHaveLength(2);
    expect(listings.find((l) => l.unitNumber === "705")).toMatchObject({
      beds: 1,
      baths: 1,
      sqft: 712,
      price: 3093,
      floorplanName: "1 BR",
      // The site says "Available Now"; its date (Sep 22) is when the unit
      // became vacant, not when you could move in.
      availableDate: "2026-11-15",
      availableNow: true,
      vacantSince: "2026-09-22",
    });
    expect(listings.find((l) => l.unitNumber === "705")!.planType).toBeUndefined();
    // The junior one-bed is filed by the site under its own type, and the
    // site's structured data counts it as 0 bedrooms — so it is studio-class
    // here too, under its own name, not a "1 BR".
    expect(listings.find((l) => l.unitNumber === "602")).toMatchObject({
      beds: 0,
      sqft: 508,
      price: 2635,
      floorplanName: "Jr 1 Bedroom",
      planType: "Jr 1 Bedroom",
      availableNow: true,
      vacantSince: "2026-11-10",
    });
    // The JSON path, specifically: unit permalinks only exist there.
    expect(listings.every((l) => /^https:\/\/leochicago\.com\/floorplans\/unit-/.test(l.url ?? ""))).toBe(true);
    // What the site says about its prices is recorded with them.
    expect(notices).toEqual([
      "Receive a 1/2 month free on our final availability for 2026! — Ask about limited-time incentives! Schedule a tour with our leasing team to explore The Leo today.",
      "Prices listed may include concessions (free rent) and/or special offers.",
    ]);
    expect(logs.join("\n")).toContain("2 unit(s) in the site's list → 2 priced");
  });

  it("asks for the page's real address (no redirect) and makes one request", async () => {
    const urls: string[] = [];
    const base = makeFixtureFetch(join(ROOT, "scraper", "fixtures", "the-leo"));
    const ctx: AdapterContext = {
      fetch: (async (input: string | URL | Request) => {
        urls.push(String(input));
        return base(input);
      }) as typeof fetch,
      log: () => {},
      now: () => CAPTURED,
    };
    await leo.scrape(buildingById("the-leo"), ctx);
    expect(urls).toEqual(["https://leochicago.com/floorplans/"]);
  });

  const blobPage = (units: unknown[], extra = ""): string =>
    `<html><head><title>Floor plans</title></head><body>${extra}<script id="jd-fp-data-script-app" type="application/json">${JSON.stringify(
      { version: "1.12.0", units, floorplans: [] },
    )}</script></body></html>`;
  const catalogue = (plans: { name: string; beds: number; available: number }[]): string =>
    `<script type="application/ld+json">${JSON.stringify({
      "@graph": [
        {
          "@type": "ApartmentComplex",
          accommodationFloorPlan: plans.map((p) => ({
            "@type": "FloorPlan",
            name: p.name,
            numberOfBedrooms: p.beds,
            numberOfAvailableAccommodationUnits: p.available,
          })),
        },
      ],
    })}</script>`;
  const serve = (body: string, status = 200, logs: string[] = [], notices: string[] = []): AdapterContext => ({
    fetch: async () => new Response(body, { status, headers: { "content-type": "text/html" } }),
    log: (m) => logs.push(m),
    now: () => CAPTURED,
    reportNotice: (t) => notices.push(t),
  });

  it("treats a real page with an empty inventory as 'nothing listed', not a failure", async () => {
    const html = blobPage([], catalogue([{ name: "408", beds: 0, available: 0 }, { name: "705", beds: 1, available: 0 }]));
    const logs: string[] = [];
    const notices: string[] = [];
    await expect(leo.scrape(buildingById("the-leo"), serve(html, 200, logs, notices))).resolves.toEqual([]);
    expect(logs.join(" ")).toContain("lists nothing right now");
    expect(notices).toEqual([
      "The site lists no available apartments right now (2 floor plans in its catalogue, none marked available).",
    ]);
    expect(parseLeoInventory(html, "https://leochicago.com/", CAPTURED).sawInventory).toBe(true);
    expect(parseLeoInventory("<html></html>", "https://leochicago.com/", CAPTURED).sawInventory).toBe(false);
  });

  it("does not record an empty building when the page's own catalogue contradicts it", async () => {
    const html = blobPage([], catalogue([{ name: "705", beds: 1, available: 1 }]));
    await expect(leo.scrape(buildingById("the-leo"), serve(html))).rejects.toThrow(/contradictory evidence/);
  });

  it("records a bot-protection refusal as blocked — no browser, no second request", async () => {
    const waf = JSON.stringify({
      message: "Access denied by Imunify360 bot-protection. IPs used for automation should be whitelisted",
    });
    let requests = 0;
    const ctx: AdapterContext = {
      fetch: async () => {
        requests++;
        return new Response(waf, { status: 200, headers: { "content-type": "application/json" } });
      },
      log: () => {},
      now: () => CAPTURED,
    };
    const err = await leo.scrape(buildingById("the-leo"), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteBlockedError);
    expect((err as Error).message).toMatch(/bot protection refused the request \(HTTP 200, application\/json, \d+ bytes\)/);
    expect(requests).toBe(1);

    // A flat 403 and an HTML challenge page are refusals too.
    await expect(leo.scrape(buildingById("the-leo"), serve("<html><body>403 Forbidden</body></html>", 403))).rejects.toBeInstanceOf(SiteBlockedError);
    await expect(
      leo.scrape(buildingById("the-leo"), serve("<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>")),
    ).rejects.toBeInstanceOf(SiteBlockedError);
    // A server error or an unrecognised page is an ordinary failure, with what was seen.
    const plain = await leo.scrape(buildingById("the-leo"), serve("<html><head><title>Oops</title></head><body>maintenance</body></html>", 200)).catch((e: unknown) => e);
    expect(plain).not.toBeInstanceOf(SiteBlockedError);
    expect((plain as Error).message).toMatch(/no unit data found .*HTTP 200, text\/html, \d+ bytes, title "Oops"/);
    const down = await leo.scrape(buildingById("the-leo"), serve("Bad gateway", 502)).catch((e: unknown) => e);
    expect(down).not.toBeInstanceOf(SiteBlockedError);
    expect((down as Error).message).toContain("HTTP 502");
  });

  it("never mistakes the real page for a challenge page, whatever words it contains", () => {
    const real = blobPage([], "<!-- protected by imunify360 --><p>captcha</p>");
    expect(isWafPage(real)).toBe(false);
    expect(isWafPage(real, 403)).toBe(false);
    // A full-size real page mentioning a captcha (contact form) is not a challenge either.
    expect(isWafPage(`<html>${"x".repeat(30_000)} recaptcha</html>`)).toBe(false);
    expect(isWafPage("<html><title>One moment, please...</title></html>")).toBe(true);
    expect(isWafPage("")).toBe(false);
  });

  it("reports a unit without a price or bed count instead of silently dropping it", async () => {
    const html = blobPage([
      { apartment_number: "1201", bedrooms: "2", bathrooms: "2", square_feet: "1100", rent_min: "", price_display: "Contact Us", available_display: "Available Now" },
      { apartment_number: "408", bedrooms: "Studio", bathrooms: "1", square_feet: "467", rent_min: "2350", rent_max: "2500", available_date: "1797400800", available_display: "Available Dec 16" },
      { apartment_number: "PH1", bedrooms: "Penthouse", bathrooms: "2", square_feet: "1500", rent_min: "6100", available_display: "Available Now" },
      { apartment_number: "PH2", bedrooms: "", bedrooms_display: "1 bed", bathrooms: "1", square_feet: "700", rent_min: "3100", available_display: "Available Now" },
    ]);
    const page = parseLeoInventory(html, "https://leochicago.com/", CAPTURED);
    expect(page.unitCount).toBe(4);
    expect(page.listings.map((l) => [l.unitNumber, l.beds, l.price])).toEqual([
      ["408", 0, 2350],
      // An empty bedroom field falls back to the display label; odd unit
      // names are kept as the unit's identity.
      ["PH2", 1, 3100],
    ]);
    expect(page.listings[0]).toMatchObject({
      priceMax: 2500,
      availableDate: "2026-12-16",
      availableNow: false,
    });
    expect(page.alsoListed).toEqual([
      expect.objectContaining({ unitNumber: "1201", beds: 2, note: "Contact Us", availableNow: true }),
      expect.objectContaining({ unitNumber: "PH1", beds: null, price: 6100, note: "Bed count not published" }),
    ]);
    const logs: string[] = [];
    await leo.scrape(buildingById("the-leo"), serve(html, 200, logs));
    expect(logs.join("\n")).toContain("4 unit(s) in the site's list → 2 priced, 2 listed without a price or bed count");
  });

  it("classifies a non-numeric bedroom label the way the site's catalogue does", () => {
    const junior = { apartment_number: "602", floorplan_title: "602", bedrooms: "JR 1 Bedroom", bedrooms_display: "JR 1 Bedroom", bathrooms: "1", square_feet: "508", rent_min: "2635", available_display: "Available Now" };
    // With the catalogue: 0 bedrooms, as the site says.
    const withCatalogue = parseLeoInventory(
      blobPage([junior], catalogue([{ name: "602", beds: 0, available: 1 }])),
      "https://leochicago.com/",
      CAPTURED,
    );
    expect(withCatalogue.listings[0]).toMatchObject({ beds: 0, floorplanName: "JR 1 Bedroom", planType: "JR 1 Bedroom" });
    expect(withCatalogue.catalogueAvailable).toBe(1);
    // Without one, the digit in the label is the only clue left.
    const without = parseLeoInventory(blobPage([junior]), "https://leochicago.com/", CAPTURED);
    expect(without.listings[0]).toMatchObject({ beds: 1, planType: "JR 1 Bedroom" });
    expect(without.catalogueAvailable).toBeNull();
  });

  it("rejects timestamps that are not a plausible day", () => {
    const unit = (available_date: unknown) => ({ apartment_number: "705", bedrooms: "1", rent_min: "3093", available_date });
    const day = (v: unknown) =>
      parseLeoInventory(blobPage([unit(v)]), "https://leochicago.com/", CAPTURED).listings[0]!.availableDate;
    expect(day("1797400800")).toBe("2026-12-16");
    expect(day(1797400800)).toBe("2026-12-16");
    // Milliseconds, zero, garbage: no date rather than a wrong one.
    expect(day(1797400800000)).toBeNull();
    expect(day("0")).toBeNull();
    expect(day("soon")).toBeNull();
  });
});

describe("leo adapter (legacy Aug 2026 capture)", () => {
  const dir = join(ROOT, "scraper", "fixtures", "legacy-2026-09", "the-leo");

  it("parses unit-level data with sqft, baths and future move-in dates", async () => {
    const { listings } = await run(leo, "the-leo", "legacy-2026-09/the-leo");
    expectSaneListings(listings, "2026-08-04");
    expect(listings.map((l) => l.unitNumber).sort()).toEqual(
      ["1309", "1310", "1401", "1801", "408", "501", "603", "707", "910"].sort(),
    );
    expect(listings.every((l) => l.sqft !== null && l.baths !== null)).toBe(true);
    // Seen from early August, Aug 27 is a future move-in day.
    expect(listings.find((l) => l.unitNumber === "408")).toMatchObject({
      beds: 0,
      sqft: 467,
      baths: 1,
      price: 2350,
      floorplanName: "Studio",
      availableDate: "2026-08-27",
      availableNow: false,
    });
    // 1401 was already vacant then ("Available Now", since Jun 29).
    expect(listings.find((l) => l.unitNumber === "1401")).toMatchObject({
      availableDate: "2026-08-04",
      availableNow: true,
      vacantSince: "2026-06-29",
    });
    // One-beds with a den are their own product on the site, and here.
    for (const unit of ["910", "1310"]) {
      expect(listings.find((l) => l.unitNumber === unit)).toMatchObject({
        beds: 1,
        floorplanName: "1 Bedroom + Den",
        planType: "1 Bedroom + Den",
      });
    }
    expect(listings.find((l) => l.unitNumber === "603")).toMatchObject({ beds: 1, floorplanName: "1 BR" });
    expect(listings.find((l) => l.unitNumber === "603")!.planType).toBeUndefined();
    expect(listings.find((l) => l.unitNumber === "707")).toMatchObject({ beds: 2, floorplanName: "2 BR" });
  });

  it("prefers the embedded Jonah JSON over card markup", () => {
    const html = readFileSync(join(dir, "00-floorplans.html"), "utf8");
    const listings = parseLeoPage(html, "https://leochicago.com/");
    expect(listings).toHaveLength(9);
    // Dates and unit permalinks exist only in the JSON.
    expect(listings.every((l) => l.availableDate !== null && ISO_DAY.test(l.availableDate))).toBe(true);
    expect(listings.every((l) => /\/floorplans\/unit-/.test(l.url ?? ""))).toBe(true);
  });

  it("reads the cards of a page that lost its data script — a degraded reading, and says so", async () => {
    // The rendered capture: the site's own script has removed the data node.
    const html = readFileSync(join(dir, "05-floorplans.html"), "utf8");
    expect(html.includes("jd-fp-data-script-app")).toBe(false);
    const cards = parseLeoCards(html, "https://leochicago.com/");
    expect(cards).toHaveLength(9);
    expect(cards.every((l) => l.availableDate === null)).toBe(true);
    expect(cards.find((l) => l.unitNumber === "408")).toMatchObject({ beds: 0, sqft: 467, baths: 1, price: 2350 });
    for (const l of cards) UnitListingSchema.parse(l);

    const notices: string[] = [];
    const logs: string[] = [];
    const ctx: AdapterContext = {
      fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }),
      log: (m) => logs.push(m),
      now: () => LEGACY_CAPTURED,
      reportNotice: (t) => notices.push(t),
    };
    await expect(leo.scrape(buildingById("the-leo"), ctx)).resolves.toHaveLength(9);
    expect(notices[0]).toMatch(/move-in dates are not available for this run/);
  });

  it("card prices: the first dollar amount only, within sane bounds", () => {
    const card = (price: string): string =>
      `<a data-jd-fp-selector="floorplan-item" href="/floorplans/602/"><p class="jd-fp-card-info__title">602</p>
       <p class="jd-fp-card-info__text"><span>JR 1 Bedroom</span><span>1 bath</span><span>508 sq. ft.</span></p>
       <span data-jd-fp-adp="display">${price}</span></a>`;
    expect(parseLeoCards(card("Starting at $2,635 - $2,900"), "https://leochicago.com/")).toEqual([
      expect.objectContaining({ unitNumber: "602", price: 2635, planType: "JR 1 Bedroom" }),
    ]);
    expect(parseLeoCards(card("Contact Us"), "https://leochicago.com/")).toEqual([]);
    expect(parseLeoCards(card("$26,352,900"), "https://leochicago.com/")).toEqual([]);
  });

  it("recognizes Imunify360 bodies, which never pass for an empty building", () => {
    const waf = readFileSync(join(dir, "00-root.html"), "utf8");
    expect(isWafPage(waf)).toBe(true);
    expect(isWafPage("<html><body>floorplans</body></html>")).toBe(false);
    expect(parseLeoPage(waf, "https://leochicago.com/")).toEqual([]);
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
