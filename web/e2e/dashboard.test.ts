import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAvailableNow } from "../../shared/src/listing";
import {
  builtScripts,
  comparePictures,
  compiledConfig,
  compiledHistory,
  compileWorld,
  DAY1,
  DAY2,
  DAY3,
  launch,
  nowUnit,
  openApp,
  overflowX,
  removeWorlds,
  say,
  scenePicture,
  scenePictureAtRest,
  serveDist,
  setSlider,
  TODAY,
  unit,
  type Run,
} from "./helpers";

/**
 * The dashboard, in a real browser, against data compiled for the purpose.
 *
 * What is checked is what the owner asked the tracker for and what a review
 * of the dashboard found it getting wrong: every listed apartment is there
 * with its rent, lease length and move-in date; nothing is hidden or
 * asserted from a gap; one broken part does not take the page down; it
 * works from the keyboard and on a phone.
 */

const IDS = ["1225-old-town", "old-town-park-1", "old-town-park-2", "old-town-park-3", "the-leo", "stead-220"];
const GAP =
  "The building’s own website refused the tracker this run (HTTP 403). Its special offers and “vacant since” dates come from that page, so they are missing from this snapshot — the building has not necessarily withdrawn them.";
const TABLE = [
  { months: 12, price: 3846 },
  { months: 14, price: 2409 },
  { months: 18, price: 2382 },
];
const UNPRICED = ["Utility Billing Bundle: Varies", "Renters Liability Insurance - Third Party: Varies"];

// ---- an ordinary three days -------------------------------------------------
const ordinary: [string, Run][] = [
  [
    DAY1,
    {
      "old-town-park-1": {
        units: [
          nowUnit("2026-11-17", "2313", 0, 2457, { priceMax: 2478, floorplanName: "S2" }),
          unit("2002", 2, 4381, { priceMax: 4500, availableDate: "2026-12-07" }),
        ],
      },
    },
  ],
  [
    DAY2,
    {
      "1225-old-town": {
        units: [
          nowUnit("2026-11-18", "0812", 0, 2400, { leaseTermMonths: 18, leaseTerms: [{ months: 12, price: 3900 }, { months: 18, price: 2400 }] }),
          unit("0704", 2, 4874, { leaseTermMonths: 18, leaseTerms: [{ months: 12, price: 5058 }, { months: 18, price: 4874 }], availableDate: "2027-01-19" }),
          nowUnit("2026-11-18", "1503", 2, 5007, { leaseTermMonths: 18, leaseTerms: [{ months: 12, price: 5095 }, { months: 18, price: 5007 }] }),
        ],
      },
      "old-town-park-1": {
        units: [
          nowUnit("2026-11-18", "2313", 0, 2457, { priceMax: 2478, floorplanName: "S2" }),
          unit("1004", 1, 3602, { priceMax: 3623, availableDate: "2026-11-26" }),
          unit("1906", 1, 3668, { priceMax: 3689, availableDate: "2026-12-10" }),
        ],
      },
    },
  ],
  [
    DAY3,
    {
      "1225-old-town": {
        gaps: [GAP],
        units: [
          nowUnit(TODAY, "0812", 0, 2382, {
            floorplanName: "bhre3.1 Studio",
            leaseTermMonths: 18,
            leaseTerms: TABLE,
            vacantSince: "2026-10-08",
            monthlyFeesUnpriced: UNPRICED,
            url: "https://www.1225oldtown.com/OnlineLeasing.aspx?UnitId=12",
          }),
          unit("0704", 2, 4874, { leaseTermMonths: 18, leaseTerms: [{ months: 12, price: 5058 }, { months: 18, price: 4874 }], availableDate: "2027-01-19", monthlyFeesUnpriced: UNPRICED }),
          nowUnit(TODAY, "1503", 2, 5007, { leaseTermMonths: 18, leaseTerms: [{ months: 12, price: 5095 }, { months: 18, price: 5007 }], monthlyFees: { min: 100, max: 230 } }),
          unit("0509", 1, 3774, { leaseTermMonths: 13, leaseTerms: [{ months: 13, price: 3774 }, { months: 18, price: 3800 }], availableDate: "2026-12-01" }),
        ],
      },
      "old-town-park-1": {
        units: [
          nowUnit(TODAY, "2313", 0, 2457, { priceMax: 2478, floorplanName: "S2" }),
          unit("1004", 1, 3602, { priceMax: 3623, availableDate: "2026-12-03" }), // its move-in date moved
          unit("2002", 2, 4381, { priceMax: 4500, availableDate: "2026-12-07" }), // gone on day 2, back today
          unit("1906", 1, 3700, { availableDate: "2026-12-10" }), // a range yesterday, a single price today
        ],
      },
      "old-town-park-2": { units: [nowUnit(TODAY, "0701", 2, 4501, { priceMax: 4891 }), unit("2604", 0, 2449)] },
      "old-town-park-3": {
        units: [unit("1703", 0, 2330, { priceMax: 2369, availableDate: "2026-11-26", planType: "Convertible" })],
        alsoListed: [{ unitNumber: "4003", floorplanName: "PH3-1", beds: null, note: "Penthouse — Contact for Pricing" }],
      },
      "the-leo": {
        notices: ["Receive a 1/2 month free on our final availability for 2026!"],
        units: [
          nowUnit(TODAY, "705", 1, 3093, { vacantSince: "2026-09-22" }),
          nowUnit(TODAY, "602", 0, 2635, { planType: "Jr 1 Bedroom", floorplanName: "Jr 1 Bedroom" }),
        ],
      },
      "stead-220": {
        units: [
          nowUnit(TODAY, null, 0, 2475, { floorplanName: "Large Studio - Unit 01", sqft: null, sourceUpdatedAt: "2026-09-17T20:57:40.000Z" }),
          nowUnit(TODAY, null, 2, 4525, { floorplanName: "Medium 2BR - Unit 09", sqft: null }),
          nowUnit(TODAY, "2809", 0, 3410, { floorplanName: "PH Medium Studio - Unit 2809", sqft: null }),
        ],
        alsoListed: [{ unitNumber: null, floorplanName: "Medium Studio - Unit 05", beds: 0, note: "Contact for Pricing" }],
      },
    },
  ],
];

// ---- a rough day ------------------------------------------------------------
// 1225's newest snapshot comes from the previous scraper; one building has
// never been read; one lists nothing; one was refused by the site.
const rough: [string, Run][] = [
  [
    DAY2,
    {
      "1225-old-town": { units: [nowUnit("2026-11-18", "0812", 0, 2382, { leaseTermMonths: 18, leaseTerms: TABLE })] },
      "the-leo": { units: [nowUnit("2026-11-18", "705", 1, 3093), nowUnit("2026-11-18", "602", 0, 2635, { planType: "Jr 1 Bedroom" })] },
    },
  ],
  [
    DAY3,
    {
      "1225-old-town": {
        units: [
          { ...unit("0812", 0, 2409, { leaseTermMonths: 14 }), availableDate: TODAY },
          { ...unit("1503", 2, 5071, { leaseTermMonths: 14 }), availableDate: TODAY },
        ],
        omitted: [
          { unitNumber: "0704", floorplanName: "bhrb3.2", beds: 2, baths: 2, sqft: 1134, advertisedPrice: 4874, leaseTermMonths: 18, reason: "over-cap" },
          { unitNumber: "0701", floorplanName: "bhrb4.2", beds: 2, baths: 2, sqft: 1166, advertisedPrice: 4944, leaseTermMonths: 18, reason: "over-cap" },
        ],
      },
      "old-town-park-1": { units: [nowUnit(TODAY, "2313", 0, 2457, { priceMax: 2478 })] },
      "old-town-park-3": { units: [] },
      "the-leo": { error: "the site's bot protection refused the request (HTTP 403)", blocked: true },
      "stead-220": { units: [nowUnit(TODAY, null, 0, 2475, { floorplanName: "Large Studio - Unit 01", sqft: null })] },
    },
  ],
];

let site: Awaited<ReturnType<typeof serveDist>>;
let noWebgl: Browser;
let ordinaryData: string;
let roughData: string;

beforeAll(async () => {
  site = await serveDist();
  noWebgl = await launch(false);
  ordinaryData = compileWorld("ordinary", ordinary);
  roughData = compileWorld("rough", rough);
});
afterAll(async () => {
  await noWebgl?.close();
  await site?.close();
  removeWorlds();
});

describe("the dashboard", () => {
  it("counts what is listed, in three move-in buckets that add up", async () => {
    const { page, context, errors } = await openApp(noWebgl, site.origin, ordinaryData);
    expect(await page.locator(".cards a.card").count()).toBe(6);

    // Recomputed here from the compiled data, not read back from the page.
    const focus = compiledConfig(ordinaryData).focus?.beds ?? [];
    let now = 0;
    let later = 0;
    let undated = 0;
    let allSizes = 0;
    for (const id of IDS) {
      const latest = compiledHistory(ordinaryData, id).latest!;
      allSizes += latest.units.length;
      for (const u of latest.units.filter((x) => focus.includes(x.beds))) {
        const state = isAvailableNow(u, latest.timestamp);
        if (state === true) now++;
        else if (u.availableDate) later++;
        else undated++;
      }
    }
    expect([now, later, undated].every((n) => n > 0)).toBe(true); // the world exercises all three
    const tile = await say(page, ".stat-tile");
    expect(tile).toContain(
      `${now} move-in now · ${later} later · ${undated} with no move-in date on record · ${allSizes} listings of all sizes`,
    );
    expect(tile).toMatch(new RegExp(`on market ${now + later + undated} `, "i"));
    expect(errors).toEqual([]);
    await context.close();
  });

  it("starts without the 3D and chart libraries", async () => {
    const { page, context, requested } = await openApp(noWebgl, site.origin, ordinaryData);
    expect(await page.locator(".cards a.card").count()).toBe(6);
    const scripts = requested.filter((p) => p.endsWith(".js")).map((p) => p.split("/").pop()!);
    expect(scripts.length).toBeGreaterThan(0);
    // The heavy parts are files of their own in the built site…
    const built = builtScripts();
    for (const part of ["Scene3D", "PriceHistoryChart", "BuildingPage"]) {
      expect(built.filter((f) => f.name.startsWith(`${part}-`)), `${part} as a file of its own`).toHaveLength(1);
    }
    // …none of which the dashboard asked for…
    expect(scripts.filter((s) => /^(Scene3D|PriceHistoryChart|BuildingPage)-/.test(s))).toEqual([]);
    // …and what it did ask for is small. Without this a library folded into
    // the start-up file, or into a file shared with it, would pass the lines
    // above: the 3D library alone is about 900 kB, the chart library 400 kB.
    const startUp = scripts.reduce((sum, s) => sum + (built.find((f) => f.name === s)?.bytes ?? Number.POSITIVE_INFINITY), 0);
    expect(startUp).toBeLessThan(300_000);
    await context.close();
  });

  it("keeps five buildings on screen when the sixth cannot be loaded, and recovers on Try again", async () => {
    const { page, context, override } = await openApp(noWebgl, site.origin, ordinaryData, {
      overrides: { "buildings/the-leo.json": { status: 404, body: "not found" } },
    });
    expect(await page.locator(".cards a.card").count()).toBe(5);
    expect(await say(page, ".cards .card-problem")).toMatch(/The Leo .*Could not load this building’s data\..*HTTP 404/);
    expect(await page.locator(".stat-tile").count()).toBeGreaterThanOrEqual(3);
    expect(await say(page, ".warning-banner")).toContain("The Leo could not be loaded");
    // the file is back: one click, no reload
    override("buildings/the-leo.json", null);
    await page.locator(".card-problem .retry-btn").click();
    await expect.poll(() => page.locator(".cards a.card").count()).toBe(6);
    expect(await page.locator(".card-problem").count()).toBe(0);
    await context.close();
  });

  it("says what kind of nothing each building has", async () => {
    const { page, context } = await openApp(noWebgl, site.origin, roughData);
    const card = (name: string) => say(page, `.cards a.card:has(h2:text-is("${name}"))`);
    // never read at all
    expect(await card("Old Town Park II")).toContain("Not read successfully yet — no data");
    // read, and the site lists nothing
    expect(await card("Old Town Park III")).toMatch(/The last scrape \(Nov 19, 2026\) found no listings/);
    // refused by the site: yesterday's listing, said to be yesterday's
    const leo = await card("The Leo");
    expect(leo).toContain("site refused");
    expect(leo).toContain("last good Nov 18, 2026");
    // a snapshot from the previous scraper: flagged, and its left-out units counted
    const old = await card("1225 Old Town");
    expect(old).toContain("old-method snapshot");
    expect(old).toContain("4 listed"); // a studio and three two-bedrooms — two of those from the left-out list
    expect(old).toContain("2 BR $4,874"); // the cheapest two-bedroom is one the old scraper left out
    await context.close();
  });
});

describe("a building's page", () => {
  it("shows every listed unit with rent, lease length and move-in date, and the lease table in a row", async () => {
    const { page, context, errors } = await openApp(noWebgl, site.origin, ordinaryData, { route: "/b/1225-old-town" });
    const units = compiledHistory(ordinaryData, "1225-old-town").latest!.units;
    await page.locator(".chip", { hasText: "All beds" }).click();
    expect(await page.locator("table.units tbody tr:not(.detail-row)").count()).toBe(units.length);
    expect(await say(page, ".panel-title .hint")).toContain(`all ${units.length}`);

    const row = await say(page, 'table.units tbody tr:has-text("0812")');
    expect(row).toContain("$2,382");
    expect(row).toContain("18 mo");
    expect(row).toContain("12 mo $3,846"); // the owner's 12-month comparison, next to the advertised lease
    expect(row).toContain("Now");
    expect(await say(page, 'table.units tbody tr:has-text("0704")')).toContain("Jan 19, 2027");

    await page.locator('table.units tbody tr:has-text("0812")').first().click();
    expect(await page.locator(".lease-grid .lease-cell").count()).toBe(TABLE.length);
    const detail = await say(page, ".unit-detail");
    expect(detail).toContain("vacant since Oct 8, 2026");
    expect(detail).toContain(
      "$2,382 is base rent. Also required every month, but the site publishes no amount for them: Utility Billing Bundle: Varies; Renters Liability Insurance - Third Party: Varies.",
    );
    expect(await page.locator(".unit-detail a.unit-link").getAttribute("href")).toBe(
      "https://www.1225oldtown.com/OnlineLeasing.aspx?UnitId=12",
    );
    // a unit whose fees do carry numbers gets the sum instead
    await page.locator('table.units tbody tr:has-text("1503")').first().click();
    expect(await say(page, ".unit-detail")).toContain("Base rent $5,007 + required monthly fees $100–$230 = $5,107–$5,237 a month");

    // what the run could not read is said on the page; what changed is named for what it is
    expect(await say(page, ".info-banner")).toContain(GAP);
    const summary = await say(page, ".bldg-head .meta");
    expect(summary).toContain("1 new");
    expect(summary).toContain("1 price drop");
    expect(await say(page, 'table.units tbody tr:has-text("0509")')).toContain("NEW");
    expect(errors).toEqual([]);
    await context.close();
  });

  it("keeps working where WebGL cannot start: the 3D panel says so, the table and chart stay", async () => {
    const { page, context } = await openApp(noWebgl, site.origin, ordinaryData, { route: "/b/1225-old-town" });
    expect(await say(page, ".panel-fallback")).toContain("The 3D view could not be shown. Everything else on this page still works.");
    expect(await page.locator("table.units tbody tr").count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator(".recharts-wrapper").count()).toBe(1);
    expect(await page.locator("header.topbar").count()).toBe(1);
    expect(await page.title()).toBe("1225 Old Town — Chicago Apartment Tracker");
    await context.close();
  });

  it("says “the site does not publish this” only where that is true, and names each kind of change", async () => {
    const { page, context } = await openApp(noWebgl, site.origin, ordinaryData, { route: "/b/old-town-park-1" });
    await page.locator(".chip", { hasText: "All beds" }).click();
    const delta = compiledHistory(ordinaryData, "old-town-park-1").delta!;
    // the world really contains each kind of change the page has a word for
    expect(delta.relistedKeys?.length).toBe(1);
    expect(delta.dateChanges?.length).toBe(1);
    expect(delta.priceChanges.filter((c) => c.notComparable === "price-form")).toHaveLength(1);

    expect(await say(page, ".table-footnote")).toContain("Lease “—”: this leasing site does not publish lease lengths.");
    const summary = await say(page, ".bldg-head .meta");
    expect(summary).toContain("1 back on the site");
    expect(summary).toContain("1 move-in date change");
    expect(summary).toContain("1 switch between a rent range and a single price (not a price change)");
    expect(summary).not.toContain("lease-term switch");
    expect(await say(page, 'table.units tbody tr:has-text("2002")')).toContain("BACK");
    const moved = await say(page, 'table.units tbody tr:has-text("1004")');
    expect(moved).toContain("Dec 3");
    expect(moved).toContain("was Nov 26");
    expect(await say(page, 'table.units tbody tr:has-text("2313")')).toContain("$2,457–");
    await context.close();
  });

  it("lists a site's floor plans, what it gives no number for, and what it lists without a price", async () => {
    const { page, context } = await openApp(noWebgl, site.origin, ordinaryData, { route: "/b/stead-220" });
    await page.locator(".chip", { hasText: "All beds" }).click();
    expect(await page.locator("table.units tbody tr:not(.detail-row)").count()).toBe(3);
    await page.locator('table.units tbody tr:has-text("Large Studio - Unit 01")').first().click();
    const detail = await say(page, ".unit-detail");
    expect(detail).toContain("The site publishes no square footage");
    expect(detail).toContain("The building last edited this price on Sep 17, 2026");
    expect(await say(page, ".also-listed")).toContain("Medium Studio - Unit 05");
    expect(await say(page, ".also-listed")).toContain("Contact for Pricing");
    await context.close();
  });

  it("opens rows and sorts from the keyboard", async () => {
    const { page, context } = await openApp(noWebgl, site.origin, ordinaryData, { route: "/b/1225-old-town" });
    const toggle = page.locator("table.units td .row-toggle").first();
    await toggle.focus();
    await page.keyboard.press("Enter");
    expect(await page.locator("tr.detail-row").count()).toBe(1);
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    await page.keyboard.press("Space");
    expect(await page.locator("tr.detail-row").count()).toBe(0);

    await page.locator("table.units th .sort-btn", { hasText: "SqFt" }).focus();
    await page.keyboard.press("Enter");
    expect(await page.locator("table.units th", { hasText: "SqFt" }).getAttribute("aria-sort")).toBe("ascending");
    expect(await page.locator('.chip[aria-pressed="true"]').count()).toBeGreaterThan(0);
    await context.close();
  });

  it("fits a phone: nothing runs off the side, lease and move-in stay on screen", async () => {
    for (const route of ["/", "/b/1225-old-town", "/b/old-town-park-1", "/b/stead-220"]) {
      const { page, context } = await openApp(noWebgl, site.origin, ordinaryData, { route, width: 390, height: 844 });
      expect(await overflowX(page), route).toBe(0);
      if (route !== "/") {
        const table = await page.locator(".tbl-wrap").evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(table, `${route}: the unit table`).toBe(0);
        expect(await say(page, "table.units thead")).toMatch(/move-in/i);
      }
      await context.close();
    }
  });

  it("says so when the address names no building, and recovers when it names one", async () => {
    const { page, context } = await openApp(noWebgl, site.origin, ordinaryData, { route: "/b/no-such-building" });
    expect(await say(page, ".error-box")).toContain("There is no building “no-such-building” in this tracker.");
    await page.evaluate(() => {
      location.hash = "#/b/the-leo";
    });
    await expect.poll(() => say(page, ".bldg-head h2")).toBe("The Leo");
    expect(await page.locator(".error-box").count()).toBe(0);
    expect(await say(page, ".info-banner")).toContain("1/2 month free");
    await context.close();
  });

  it("lists what a previous-scraper snapshot left out, and says how each row was recorded", async () => {
    const { page, context } = await openApp(noWebgl, site.origin, roughData, { route: "/b/1225-old-town" });
    expect(await say(page, ".warning-banner")).toContain("was taken by the tracker’s previous scraper");
    await page.locator(".chip", { hasText: "All beds" }).click();
    expect(await page.locator("table.units tbody tr:not(.detail-row)").count()).toBe(4); // 2 recorded + 2 left out
    expect(await say(page, ".panel-title .hint")).toContain("all 4");
    await page.locator('table.units tbody tr:has-text("0704")').first().click();
    expect(await say(page, ".unit-detail")).toContain(
      "left this apartment out of its list, because the site offered it for no lease of 14 months or less. $4,874 is the rent the site advertised, for an 18-month lease.",
    );
    await page.locator('table.units tbody tr:has-text("1503")').first().click();
    expect(await say(page, ".unit-detail")).toContain(
      "This snapshot was taken the old way: $5,071 is the cheapest rent the site offered for a lease of 14 months or less (here 14 months)",
    );
    await context.close();
  });

  it("tells “never read”, “lists nothing” and “refused” apart", async () => {
    const never = await openApp(noWebgl, site.origin, roughData, { route: "/b/old-town-park-2" });
    expect(await say(never.page, "table.units tbody")).toContain("This building has not been read successfully yet — there is nothing to show.");
    expect(await never.page.locator(".filters").count()).toBe(0); // nothing listed: nothing to filter
    await never.context.close();

    const empty = await openApp(noWebgl, site.origin, roughData, { route: "/b/old-town-park-3" });
    expect(await say(empty.page, "table.units tbody")).toContain("The last scrape found no listings on the leasing site.");
    await empty.context.close();

    const refused = await openApp(noWebgl, site.origin, roughData, { route: "/b/the-leo" });
    expect(await say(refused.page, ".bldg-head")).toMatch(/site refused the scrape Nov 19, 2026 · last good Nov 18, 2026/);
    await refused.page.locator(".chip", { hasText: "All beds" }).click();
    expect(await refused.page.locator("table.units tbody tr:not(.detail-row)").count()).toBe(2); // yesterday's two, still shown
    await refused.context.close();
  });
});

describe("the 3D view", () => {
  // Judged by the picture, not by what the page says about it: a legend that
  // counts four units proves nothing about what was drawn on the tower.
  it("draws a mark on the tower for every listed unit, and relights the scene for another hour", async () => {
    const webgl = await launch(true);
    try {
      // tall enough that the table is on screen with the scene: pointing at a row must not scroll the page
      const { page, context, errors, consoleErrors } = await openApp(webgl, site.origin, ordinaryData, {
        route: "/b/1225-old-town",
        height: 2400,
      });
      await expect.poll(() => page.locator(".scene-wrap canvas").count(), { timeout: 60_000 }).toBe(1);
      const units = compiledHistory(ordinaryData, "1225-old-town").latest!.units;
      await expect.poll(() => say(page, ".scene-legend-head .scene-legend-n"), { timeout: 60_000 }).toBe(String(units.length));
      expect(await page.locator(".panel-fallback").count()).toBe(0);

      // Every listed unit has a mark: pointing at its row in the table lights
      // that mark up, wherever on the tower it is — the picture changes.
      await page.locator(".chip", { hasText: "All beds" }).click();
      const rows = page.locator("table.units tbody tr:not(.detail-row)");
      expect(await rows.count()).toBe(units.length);
      await page.mouse.move(4, 4);
      const calm = await scenePictureAtRest(page);
      const changedFromCalm = async (): Promise<number> => (await comparePictures(page, calm, await scenePicture(page))).changed;
      const lit = new Map<string, string>();
      for (const u of units) {
        const unitNumber = u.unitNumber!;
        await rows.filter({ hasText: unitNumber }).hover();
        // about a hundred pixels at the least (a small mark seen through the tower); none if the unit has no mark
        await expect.poll(changedFromCalm, { timeout: 20_000, message: `the mark of unit ${unitNumber}` }).toBeGreaterThan(20);
        lit.set(unitNumber, await scenePictureAtRest(page));
        await page.mouse.move(4, 4);
        await expect.poll(changedFromCalm, { timeout: 20_000, message: `back to the calm picture after unit ${unitNumber}` }).toBe(0);
      }
      // …and each unit's mark is its own: no two rows light up the same place.
      const numbers = [...lit.keys()];
      for (let i = 0; i < numbers.length; i++) {
        for (let j = i + 1; j < numbers.length; j++) {
          const { changed } = await comparePictures(page, lit.get(numbers[i]!)!, lit.get(numbers[j]!)!);
          expect(changed, `the marks of units ${numbers[i]} and ${numbers[j]}`).toBeGreaterThan(20);
        }
      }

      // The slider relights the scene: much darker late in the evening, bright again at noon.
      // (Measured: about 128 of 255 at the default 1 PM, 46 at 11 PM, 122 at noon.)
      expect(await say(page, ".scene-time-value")).toBe("1 PM");
      const afternoon = (await comparePictures(page, calm, calm)).brightnessA;
      await setSlider(page, ".scene-time input", 23);
      await expect.poll(() => say(page, ".scene-time-value")).toBe("11 PM");
      const night = await scenePictureAtRest(page);
      await setSlider(page, ".scene-time input", 12);
      await expect.poll(() => say(page, ".scene-time-value")).toBe("12 PM");
      const noon = await scenePictureAtRest(page);
      const relit = await comparePictures(page, night, noon);
      expect(afternoon).toBeGreaterThan(relit.brightnessA * 1.5);
      expect(relit.brightnessB).toBeGreaterThan(relit.brightnessA * 1.5);
      expect(errors).toEqual([]);
      expect(consoleErrors).toEqual([]);
      await context.close();
    } finally {
      await webgl.close();
    }
  });
});
