import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { asUnit, harvestPlans, harvestUnits, looksLikeUnitCode } from "@/lib/scrape/shape";
import { extractJsonBlobs, scanBalancedJson } from "@/lib/scrape/json-blobs";
import { isAllowedByRobots, parseRobots } from "@/lib/scrape/http";
import { detectAdapter } from "@/lib/scrape/registry";
import { detectPlatform } from "@/lib/scrape/fingerprint";
import { extractUnitsFromDom } from "@/lib/scrape/adapters/dom-heuristic";

describe("looksLikeUnitCode", () => {
  it("accepts real unit labels", () => {
    for (const s of ["3208", "PH02", "#1104", "12A", "Unit 905"]) {
      expect(looksLikeUnitCode(s)).toBe(true);
    }
  });

  it("rejects plan names, prices and dates", () => {
    for (const s of ["The Wells", "$2,395", "2026-08-15", "Two Bedroom"]) {
      expect(looksLikeUnitCode(s)).toBe(false);
    }
  });
});

describe("asUnit", () => {
  it("recognises a unit regardless of the platform's field names", () => {
    expect(
      asUnit({ UnitNumber: "3208", MarketRent: 2395, SquareFeet: 742 }),
    ).toMatchObject({ unitCode: "3208", rent: 2395, sqft: 742 });

    expect(
      asUnit({ apartment_name: "3208", min_rent: "$2,395", square_footage: "742 sq ft" }),
    ).toMatchObject({ unitCode: "3208", rent: 2395, sqft: 742 });
  });

  it("unwraps the value objects platforms wrap numbers in", () => {
    expect(asUnit({ unit: "1104", rent: { amount: 2150 }, beds: [1] })).toMatchObject({
      unitCode: "1104",
      rent: 2150,
      bedrooms: 1,
    });
  });

  it("requires corroboration beyond a bare unit code", () => {
    expect(asUnit({ unitNumber: "3208" })).toBeNull();
    expect(asUnit({ name: "The Wells", sqft: 742 })).toBeNull();
  });

  it("only reports a market rent when it is genuinely higher", () => {
    expect(asUnit({ unit: "12", rent: 2000, marketRent: 2000, sqft: 700 })?.marketRent)
      .toBeUndefined();
    expect(asUnit({ unit: "12", rent: 2000, marketRent: 2200, sqft: 700 })?.marketRent)
      .toBe(2200);
  });
});

describe("harvestUnits", () => {
  it("finds units nested anywhere in a payload", () => {
    const payload = {
      props: {
        pageProps: {
          data: {
            floorPlans: [
              {
                name: "One Bed A",
                beds: 1,
                sqft: 706,
                units: [
                  { unitNumber: "1802", rent: 2295, availableDate: "2026-09-01" },
                  { unitNumber: "2402", rent: 2415, availableDate: "2026-08-15" },
                ],
              },
            ],
          },
        },
      },
    };
    const units = harvestUnits(payload);
    expect(units.map((u) => u.unitCode).sort()).toEqual(["1802", "2402"]);
    expect(units.find((u) => u.unitCode === "2402")?.rent).toBe(2415);
  });

  it("separates plans from units in the same payload", () => {
    const payload = {
      floorPlans: [
        {
          id: "one-bed-a",
          name: "One Bed A",
          beds: 1,
          baths: 1,
          sqft: 706,
          image: "/media/plans/one-bed-a.png",
          units: [{ unitNumber: "1802", rent: 2295 }],
        },
      ],
    };
    const plans = harvestPlans(payload, { baseUrl: "https://example.com/floorplans" });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ name: "One Bed A", sqft: 706, bedrooms: 1 });
    expect(plans[0].imageUrl).toBe("https://example.com/media/plans/one-bed-a.png");
  });
});

describe("scanBalancedJson", () => {
  it("extracts embedded objects and skips surrounding noise", () => {
    const text = `garbage {"a":1,"b":[1,2,3],"c":"}"} trailing`;
    const found = scanBalancedJson(text, { minLength: 2 });
    expect(found).toContainEqual({ a: 1, b: [1, 2, 3], c: "}" });
  });

  it("is not confused by braces inside strings", () => {
    const found = scanBalancedJson(`{"s":"a{b}c","n":2}`, { minLength: 2 });
    expect(found[0]).toEqual({ s: "a{b}c", n: 2 });
  });
});

describe("extractJsonBlobs", () => {
  it("reads __NEXT_DATA__ and JSON-LD", () => {
    const html = `
      <script id="__NEXT_DATA__" type="application/json">
        {"props":{"units":[{"unitNumber":"3208","rent":2395,"sqft":742}]}}
      </script>
      <script type="application/ld+json">
        {"@type":"ApartmentComplex","name":"Demo","address":{"streetAddress":"1 Main St","addressLocality":"Chicago","addressRegion":"IL"}}
      </script>`;
    const blobs = extractJsonBlobs(html);
    expect(harvestUnits(blobs).map((u) => u.unitCode)).toContain("3208");
  });

  it("reconstitutes Next.js App Router flight chunks", () => {
    const inner = JSON.stringify({ units: [{ unit: "1104", rent: 2150, sqft: 700 }] });
    const html = `<script>self.__next_f.push([1,${JSON.stringify(inner)}])</script>`;
    const blobs = extractJsonBlobs(html);
    expect(harvestUnits(blobs).map((u) => u.unitCode)).toContain("1104");
  });
});

describe("robots.txt", () => {
  const txt = `
User-agent: *
Disallow: /admin
Allow: /admin/public
Crawl-delay: 5

User-agent: badbot
Disallow: /
`;

  it("selects the wildcard group and applies longest-match-wins", () => {
    const rules = parseRobots(txt, "chiapartment/0.1");
    expect(rules.crawlDelay).toBe(5);
    expect(isAllowedByRobots(rules, "/floorplans")).toBe(true);
    expect(isAllowedByRobots(rules, "/admin/settings")).toBe(false);
    expect(isAllowedByRobots(rules, "/admin/public/list")).toBe(true);
  });

  it("selects a named group when the user-agent matches", () => {
    const rules = parseRobots(txt, "badbot/1.0");
    expect(isAllowedByRobots(rules, "/anything")).toBe(false);
  });

  it("treats an empty Disallow as permission", () => {
    const rules = parseRobots("User-agent: *\nDisallow:", "chiapartment/0.1");
    expect(isAllowedByRobots(rules, "/anything")).toBe(true);
  });

  it("supports wildcards and end anchors", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$", "x");
    expect(isAllowedByRobots(rules, "/a/b/plan.pdf")).toBe(false);
    expect(isAllowedByRobots(rules, "/a/b/plan.pdf?x=1")).toBe(true);
  });
});

describe("DOM extraction", () => {
  const html = `
    <table>
      <thead><tr><th>Unit</th><th>Floor Plan</th><th>Beds</th><th>Sq Ft</th><th>Rent</th><th>Available</th></tr></thead>
      <tbody>
        <tr><td>3208</td><td>Two Bed Corner</td><td>2</td><td>1,215</td><td>$3,480</td><td>Now</td></tr>
        <tr><td>1802</td><td>One Bed A</td><td>1</td><td>706</td><td>$2,295</td><td>9/1/26</td></tr>
      </tbody>
    </table>`;

  it("reads an availability table using its header row", () => {
    const $ = cheerio.load(html);
    const units = extractUnitsFromDom($, "https://example.com/floorplans");
    expect(units).toHaveLength(2);
    expect(units.find((u) => u.unitCode === "3208")).toMatchObject({
      rent: 3480,
      sqft: 1215,
      bedrooms: 2,
    });
    expect(units.find((u) => u.unitCode === "1802")?.availableOn).toBe("2026-09-01");
  });

  it("ignores tables that are not availability tables", () => {
    const $ = cheerio.load(
      `<table><thead><tr><th>Amenity</th><th>Floor</th></tr></thead>
       <tbody><tr><td>Gym</td><td>3</td></tr></tbody></table>`,
    );
    expect(extractUnitsFromDom($, "https://example.com")).toHaveLength(0);
  });

  it("falls back to card parsing when there is no table", () => {
    const $ = cheerio.load(`
      <div class="grid">
        <div class="card"><h3>Unit 2104</h3><p>1 Bed · 706 sq ft</p><span>$2,250</span></div>
        <div class="card"><h3>Unit 2105</h3><p>2 Bed · 1,102 sq ft</p><span>$3,240</span></div>
      </div>`);
    const units = extractUnitsFromDom($, "https://example.com");
    expect(units.map((u) => u.unitCode).sort()).toEqual(["2104", "2105"]);
    expect(units.find((u) => u.unitCode === "2105")?.rent).toBe(3240);
  });
});

describe("detection", () => {
  it("routes an embedded-JSON page to the embedded-json adapter", () => {
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">
      {"units":[{"unitNumber":"3208","rent":2395,"sqft":742},{"unitNumber":"1802","rent":2295,"sqft":706}]}
    </script></body></html>`;
    expect(detectAdapter(html, "https://example.com/").adapter.id).toBe("embedded-json");
  });

  it("routes a RENTCafé page to the rentcafe adapter", () => {
    const html = `<html><body>
      <iframe src="https://www.rentcafe.com/rentcafeapi.aspx?requestType=apartmentavailability&propertyId=123456"></iframe>
      <script>var RENTCafe = {propertyId: 123456};</script>
    </body></html>`;
    expect(detectAdapter(html, "https://example.com/").adapter.id).toBe("rentcafe");
  });

  it("falls through to crawling when the entry page has no units", () => {
    const html = `<html><body><nav><a href="/floorplans">Floor Plans</a></nav></body></html>`;
    expect(detectAdapter(html, "https://example.com/").adapter.id).toBe("site-crawl");
  });

  it("fingerprints the leasing platform independently of the adapter", () => {
    expect(detectPlatform('<script src="https://cdn.entrata.com/x.js"></script>')?.id)
      .toBe("entrata");
    expect(detectPlatform("<div>__NEXT_DATA__</div>")?.id).toBe("next");
    expect(detectPlatform("<html><body>nothing</body></html>")).toBeNull();
  });
});
