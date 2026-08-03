import { describe, expect, it } from "vitest";
import { coerceBeds, coercePrice, findUnitListings, parseHtmlListings } from "../src/normalize";

describe("coercion", () => {
  it("parses price strings", () => {
    expect(coercePrice("$2,305")).toBe(2305);
    expect(coercePrice(3080)).toBe(3080);
    expect(coercePrice("from $4,490/mo")).toBe(4490);
    expect(coercePrice("call for pricing")).toBeNull();
  });

  it("parses bed descriptions", () => {
    expect(coerceBeds("Studio")).toBe(0);
    expect(coerceBeds("2 Bedroom")).toBe(2);
    expect(coerceBeds(1)).toBe(1);
    expect(coerceBeds("penthouse")).toBeNull();
  });
});

describe("findUnitListings", () => {
  it("harvests RENTCafe-style nested payloads", () => {
    const payload = {
      d: {
        model: {
          floorplans: [
            {
              FloorplanName: "A4",
              Units: [
                {
                  UnitNumber: "1204",
                  Beds: 1,
                  Baths: 1,
                  SQFT: "720",
                  MinRent: "$2,850",
                  AvailableDate: "8/15/2026",
                },
                { UnitNumber: "2204", Beds: 1, Baths: 1, SQFT: 720, MinRent: 2990 },
              ],
            },
          ],
        },
      },
    };
    const listings = findUnitListings(payload);
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({ unitNumber: "1204", beds: 1, price: 2850, sqft: 720 });
  });

  it("ignores arrays that don't look like listings", () => {
    expect(findUnitListings({ nav: ["home", "about"], ids: [1, 2, 3] })).toHaveLength(0);
  });

  it("rejects implausible rents", () => {
    const listings = findUnitListings({
      units: [{ unitNumber: "101", beds: 1, rent: 25 }],
    });
    expect(listings).toHaveLength(0);
  });

  it("dedupes by unit number", () => {
    const listings = findUnitListings({
      a: [{ unitNumber: "101", beds: 1, rent: 2000 }],
      b: [{ unitNumber: "101", beds: 1, rent: 2000 }],
    });
    expect(listings).toHaveLength(1);
  });
});

describe("parseHtmlListings", () => {
  it("extracts listing cards from markup", () => {
    const html = `
      <div class="cards">
        <div class="card"><h3>A1</h3><span>1 Bed / 1 Bath</span><span>705 sq ft</span><span>From $2,750</span></div>
        <div class="card"><h3>S2</h3><span>Studio</span><span>520 sq ft</span><span>$2,195</span></div>
        <div class="footer">Call us today! Prices from $99</div>
      </div>`;
    const listings = parseHtmlListings(html);
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({ floorplanName: "A1", beds: 1, price: 2750, sqft: 705 });
    expect(listings[1]).toMatchObject({ beds: 0, price: 2195 });
  });
});
