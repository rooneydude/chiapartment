import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BuildingHistory, CompiledConfig, WeekdayBrief } from "../../shared/src/types";
import { buildData } from "../src/build-data";

const ROOT = join(tmpdir(), `chiapartment-builddata-${process.pid}`);

function writeSnapshot(
  ts: string,
  status: "ok" | "error",
  units: object[],
  error?: string,
  omitted?: object[],
) {
  const snap = {
    schemaVersion: 1,
    timestamp: ts,
    buildings: [
      {
        buildingId: "test-bldg",
        status,
        ...(error ? { error } : {}),
        source: { adapter: "generic", fetchedUrl: "https://example.com/" },
        units,
        ...(omitted && omitted.length > 0 ? { omitted } : {}),
      },
    ],
  };
  writeFileSync(
    join(ROOT, "data", "snapshots", `${ts.replaceAll(":", "-")}.json`),
    JSON.stringify(snap),
  );
}

// Old-shape unit (pre-`specials` schema) — must keep compiling.
const unit = (unitNumber: string, price: number) => ({
  unitNumber,
  floorplanName: "A1",
  beds: 1,
  baths: 1,
  sqft: 700,
  price,
  availableDate: null,
});

function setup() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, "data", "snapshots"), { recursive: true });
  writeFileSync(
    join(ROOT, "buildings.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildings: [
        {
          id: "test-bldg",
          name: "Test",
          address: "x",
          lat: 41.9,
          lon: -87.63,
          url: "https://example.com/",
          adapter: "generic",
          geometry: { floors: 10 },
        },
      ],
    }),
  );
}

function readHistory(): BuildingHistory {
  return JSON.parse(
    readFileSync(join(ROOT, "web", "public", "data", "buildings", "test-bldg.json"), "utf8"),
  ) as BuildingHistory;
}

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("buildData metrics and warnings", () => {
  it("tracks first-seen metadata across runs", () => {
    setup();
    writeSnapshot("2026-07-01T12:00:00Z", "ok", [unit("101", 2000)]);
    writeSnapshot("2026-07-08T12:00:00Z", "ok", [unit("101", 1900), unit("202", 2500)]);
    buildData(ROOT);
    const h = readHistory();
    expect(h.perUnitMeta["101"]).toEqual({ firstSeen: "2026-07-01T12:00:00Z", firstPrice: 2000 });
    expect(h.perUnitMeta["202"]).toEqual({ firstSeen: "2026-07-08T12:00:00Z", firstPrice: 2500 });
    expect(h.warnings).toEqual([]);
    expect(h.lastAttempt).toEqual({ timestamp: "2026-07-08T12:00:00Z", status: "ok" });
    expect(h.focusDelta).toMatchObject({ chicagoTo: "2026-07-08", focusBeds: [] });
    expect(h.omitted).toEqual([]);
  });

  it("flags a failed latest scrape", () => {
    setup();
    writeSnapshot("2026-07-01T12:00:00Z", "ok", [unit("101", 2000)]);
    writeSnapshot("2026-07-08T12:00:00Z", "error", [], "HTTP 503");
    buildData(ROOT);
    const h = readHistory();
    expect(h.warnings.map((w) => w.code)).toContain("scrape-error");
    expect(h.warnings[0]!.message).toContain("HTTP 503");
    expect(h.warnings[0]!.message).toContain("2026-07-01");
    expect(h.lastAttempt).toEqual({
      timestamp: "2026-07-08T12:00:00Z",
      status: "error",
      error: "HTTP 503",
      failedRuns: 1,
    });
    // Latest good data still served.
    expect(h.latest?.units).toHaveLength(1);
  });

  it("flags empty runs and count drops", () => {
    setup();
    writeSnapshot("2026-07-01T12:00:00Z", "ok", [
      unit("101", 2000),
      unit("102", 2000),
      unit("103", 2000),
      unit("104", 2000),
    ]);
    writeSnapshot("2026-07-08T12:00:00Z", "ok", [unit("101", 2600)]);
    buildData(ROOT);
    const codes = readHistory().warnings.map((w) => w.code);
    expect(codes).toContain("count-drop"); // 4 → 1
    // One surviving unit is not evidence of a building-wide price jump.
    expect(codes).not.toContain("price-jump");

    writeSnapshot("2026-07-15T12:00:00Z", "ok", []);
    buildData(ROOT);
    expect(readHistory().warnings.map((w) => w.code)).toContain("empty-run");
  });

  it("flags a price jump only when the SAME units moved, like for like", () => {
    setup();
    const four = (price: number, extra: object = {}) =>
      ["101", "102", "103", "104"].map((n) => ({ ...unit(n, price), ...extra }));
    writeSnapshot("2026-07-01T12:00:00Z", "ok", four(2000));
    writeSnapshot("2026-07-08T12:00:00Z", "ok", four(2600));
    buildData(ROOT);
    const jump = readHistory().warnings.find((w) => w.code === "price-jump");
    expect(jump?.message).toContain("+30%");

    // Cheap inventory leaving and expensive inventory arriving moves the
    // building median 60% — but no unit's price changed. Not a jump.
    setup();
    writeSnapshot("2026-07-01T12:00:00Z", "ok", four(2000));
    writeSnapshot("2026-07-08T12:00:00Z", "ok", [
      ...four(2000),
      ...["201", "202", "203", "204", "205", "206"].map((n) => unit(n, 5200)),
    ]);
    buildData(ROOT);
    expect(readHistory().warnings.map((w) => w.code)).not.toContain("price-jump");

    // The site switching its headline from a 14- to an 18-month lease is not
    // a jump either when the lease table shows the 14-month price unchanged.
    setup();
    writeSnapshot("2026-07-01T12:00:00Z", "ok", four(3000, { leaseTermMonths: 14 }));
    writeSnapshot(
      "2026-07-08T12:00:00Z",
      "ok",
      four(2400, {
        leaseTermMonths: 18,
        leaseTerms: [
          { months: 14, price: 3000 },
          { months: 18, price: 2400 },
        ],
      }),
    );
    buildData(ROOT);
    const h = readHistory();
    expect(h.warnings.map((w) => w.code)).not.toContain("price-jump");
    expect(h.delta?.priceChanges).toEqual([]);
  });

  it("warns when lease tables or move-in dates that were there yesterday go missing", () => {
    setup();
    const rich = (n: string) => ({
      ...unit(n, 3000),
      availableDate: "2026-12-01",
      leaseTermMonths: 18,
      leaseTerms: [{ months: 12, price: 3300 }, { months: 18, price: 3000 }],
    });
    writeSnapshot("2026-11-14T18:00:00Z", "ok", [rich("101"), rich("102"), rich("103")]);
    writeSnapshot("2026-11-15T18:00:00Z", "ok", [
      { ...rich("101"), leaseTerms: undefined },
      { ...rich("102"), leaseTerms: undefined },
      rich("103"),
    ]);
    buildData(ROOT);
    const partial = readHistory().warnings.filter((w) => w.code === "partial-data");
    expect(partial).toHaveLength(1);
    expect(partial[0]!.message).toContain("Only 1 of 3 units have lease-term price tables");
  });

  it("carries lease terms, also-listed rows and notices through to the compiled history", () => {
    setup();
    const snapDir = join(ROOT, "data", "snapshots");
    const write = (ts: string, building: object) =>
      writeFileSync(
        join(snapDir, `${ts.replaceAll(":", "-")}.json`),
        JSON.stringify({
          schemaVersion: 1,
          timestamp: ts,
          buildings: [
            {
              buildingId: "test-bldg",
              status: "ok",
              source: { adapter: "generic", fetchedUrl: "https://example.com/" },
              ...building,
            },
          ],
        }),
      );
    // Day 1: the old lease cap hid unit 102 (recorded as omitted).
    write("2026-11-14T18:00:00Z", {
      units: [{ ...unit("101", 2409), leaseTermMonths: 14 }],
      omitted: [
        { unitNumber: "102", floorplanName: "A1", beds: 1, advertisedPrice: 3529, leaseTermMonths: 18, reason: "over-cap" },
      ],
    });
    // Day 2: everything is listed.
    write("2026-11-15T18:00:00Z", {
      units: [
        {
          ...unit("101", 2382),
          leaseTermMonths: 18,
          leaseTerms: [{ months: 14, price: 2409 }, { months: 18, price: 2382 }],
          availableDate: "2026-11-15",
          availableNow: true,
        },
        { ...unit("102", 3529), leaseTermMonths: 18, availableDate: "2026-12-26", availableNow: false },
        { ...unit("103", 4100), leaseTermMonths: 18, availableDate: "2026-12-01", availableNow: false },
      ],
      alsoListed: [{ unitNumber: "PH1", floorplanName: "PH", beds: null, note: "Contact for Pricing" }],
      notices: ["Up to a $1,000 rent credit"],
    });
    buildData(ROOT);
    const h = readHistory();
    expect(h.latest?.units).toHaveLength(3);
    expect(h.latest?.units[0]?.leaseTerms).toHaveLength(2);
    expect(h.alsoListed).toEqual([
      { unitNumber: "PH1", floorplanName: "PH", beds: null, note: "Contact for Pricing" },
    ]);
    expect(h.notices).toEqual(["Up to a $1,000 rent credit"]);
    expect(h.omitted).toEqual([]);
    // Per-unit history remembers which lease term each price was quoted for.
    expect(h.perUnit["101"]).toEqual([
      { t: "2026-11-14T18:00:00Z", price: 2409, term: 14 },
      { t: "2026-11-15T18:00:00Z", price: 2382, term: 18 },
    ]);
    // Unit 102 was on the market yesterday too (hidden by the cap): not new —
    // and its history starts the day it was first SEEN, at the price the
    // site advertised then, not the day the cap stopped hiding it.
    expect(h.perUnit["102"]).toEqual([
      { t: "2026-11-14T18:00:00Z", price: 3529, term: 18 },
      { t: "2026-11-15T18:00:00Z", price: 3529, term: 18 },
    ]);
    expect(h.perUnitMeta["102"]).toEqual({
      firstSeen: "2026-11-14T18:00:00Z",
      firstPrice: 3529,
      firstTerm: 18,
    });
    expect(h.perUnitMeta["103"]).toMatchObject({ firstSeen: "2026-11-15T18:00:00Z" });
    expect(h.delta?.newUnits.map((u) => u.unitNumber)).toEqual(["103"]);
    // 101's 14-month price did not move; only the headline term did.
    expect(h.delta?.priceChanges).toEqual([]);
    expect(h.focusDelta?.newUnits.map((u) => u.unitNumber)).toEqual(["103"]);

    const brief = JSON.parse(
      readFileSync(join(ROOT, "web", "public", "data", "brief.json"), "utf8"),
    ) as WeekdayBrief;
    const row = brief.buildings[0]!;
    expect(row.listings?.map((l) => [l.label, l.availableNow, l.leaseTermMonths])).toEqual([
      ["#101", true, 18],
      ["#102", false, 18],
      ["#103", false, 18],
    ]);
    expect(row.alsoListed).toHaveLength(1);
    expect(row.notices).toEqual(["Up to a $1,000 rent credit"]);
    expect(brief.summary).toMatchObject({ focusAvailable: 3, availableNow: 1, omittedOverCap: 0 });
  });

  it("reports snapshot files that fail validation instead of hiding them", () => {
    setup();
    writeSnapshot("2026-07-01T12:00:00Z", "ok", [unit("101", 2000)]);
    writeFileSync(join(ROOT, "data", "snapshots", "2026-07-02T12-00-00Z.json"), '{"schemaVersion":1,"oops":true}');
    buildData(ROOT);
    const cfg = JSON.parse(
      readFileSync(join(ROOT, "web", "public", "data", "config.json"), "utf8"),
    ) as CompiledConfig;
    expect(cfg.health?.snapshots).toBe(1);
    expect(cfg.health?.skippedSnapshots).toEqual(["2026-07-02T12-00-00Z.json"]);
  });

  it("publishes warning counts in config health", () => {
    setup();
    writeSnapshot("2026-07-01T12:00:00Z", "ok", [unit("101", 2000)]);
    writeSnapshot("2026-07-08T12:00:00Z", "error", [], "boom");
    buildData(ROOT);
    const cfg = JSON.parse(
      readFileSync(join(ROOT, "web", "public", "data", "config.json"), "utf8"),
    ) as CompiledConfig;
    expect(cfg.health?.buildings["test-bldg"]).toBe(1);
  });

  it("does not fire count-drop when omitted over-cap units explain the delta", () => {
    setup();
    writeSnapshot("2026-09-07T18:00:00Z", "ok", [
      unit("101", 2000),
      unit("102", 2000),
      unit("103", 2000),
      unit("104", 2000),
    ]);
    writeSnapshot(
      "2026-09-08T18:00:00Z",
      "ok",
      [unit("101", 2000), unit("102", 2000)],
      undefined,
      [
        {
          unitNumber: "103",
          floorplanName: "A1",
          beds: 1,
          advertisedPrice: 1800,
          leaseTermMonths: 18,
          reason: "over-cap",
        },
        {
          unitNumber: "104",
          floorplanName: "A1",
          beds: 1,
          advertisedPrice: 1800,
          leaseTermMonths: 18,
          reason: "over-cap",
        },
      ],
    );
    buildData(ROOT);
    const h = readHistory();
    expect(h.warnings.map((w) => w.code)).not.toContain("count-drop");
    expect(h.omitted).toHaveLength(2);
    expect(h.omitted[0]!.unitNumber).toBe("103");
  });

  it("writes a weekday brief.json a morning bot can consume", () => {
    setup();
    writeSnapshot("2026-09-07T18:00:00Z", "ok", [unit("101", 2000)]);
    writeSnapshot("2026-09-08T18:00:00Z", "ok", [unit("101", 1900), unit("202", 2500)]);
    buildData(ROOT);
    const brief = JSON.parse(
      readFileSync(join(ROOT, "web", "public", "data", "brief.json"), "utf8"),
    ) as WeekdayBrief;
    expect(brief.schemaVersion).toBe(1);
    expect(brief.timezone).toBe("America/Chicago");
    expect(brief.buildings).toHaveLength(1);
    expect(brief.buildings[0]!.id).toBe("test-bldg");
    expect(brief.buildings[0]!.status).toBe("ok");
    expect(brief.chicagoFrom).toBe("2026-09-07");
    expect(brief.chicagoTo).toBe("2026-09-08");
  });
});

describe("buildData: what the two latest unit lists alone cannot say", () => {
  const write = (ts: string, building: object): void =>
    writeFileSync(
      join(ROOT, "data", "snapshots", `${ts.replaceAll(":", "-")}.json`),
      JSON.stringify({
        schemaVersion: 1,
        timestamp: ts,
        buildings: [
          {
            buildingId: "test-bldg",
            status: "ok",
            source: { adapter: "generic", fetchedUrl: "https://example.com/" },
            units: [],
            ...building,
          },
        ],
      }),
    );
  const plan = (name: string, price: number) => ({
    unitNumber: null,
    floorplanName: name,
    beds: 0,
    baths: 1,
    sqft: null,
    price,
    availableDate: null,
  });
  const brief = (): WeekdayBrief =>
    JSON.parse(readFileSync(join(ROOT, "web", "public", "data", "brief.json"), "utf8")) as WeekdayBrief;

  it("a plan whose price is withdrawn is still listed — not removed — and is announced when the price returns", () => {
    setup();
    write("2026-10-27T18:00:00Z", { units: [plan("Studio - Unit 05", 2250), plan("Studio - Unit 01", 2475)] });
    // The site now says "Contact for Pricing" for Unit 05.
    write("2026-10-28T18:00:00Z", {
      units: [plan("Studio - Unit 01", 2475)],
      alsoListed: [{ unitNumber: null, floorplanName: "Studio - Unit 05", beds: 0, note: "Contact for Pricing" }],
    });
    buildData(ROOT);
    let h = readHistory();
    expect(h.delta!.removedUnits).toEqual([]);
    expect(h.focusDelta!.removedUnits).toEqual([]);
    // …and the dashboard can say what it last cost, and when.
    expect(h.alsoListed).toEqual([
      expect.objectContaining({
        floorplanName: "Studio - Unit 05",
        note: "Contact for Pricing",
        lastPrice: 2250,
        lastPricedAt: "2026-10-27T18:00:00Z",
      }),
    ]);

    // The price comes back: that is news, and it can be compared with the old one.
    write("2026-10-29T18:00:00Z", {
      units: [plan("Studio - Unit 01", 2475), plan("Studio - Unit 05", 2300)],
      alsoListed: [],
    });
    buildData(ROOT);
    h = readHistory();
    expect(h.delta!.newUnits.map((u) => u.floorplanName)).toEqual(["Studio - Unit 05"]);
    expect(h.delta!.pricedAgain).toEqual([
      { key: "fp:0:Studio - Unit 05", lastPrice: 2250, lastPricedAt: "2026-10-27T18:00:00Z" },
    ]);
    expect(h.delta!.relistedKeys).toBeUndefined();
    expect(h.alsoListed).toEqual([]);
    expect(brief().buildings[0]!.new).toEqual([
      expect.objectContaining({
        floorplanName: "Studio - Unit 05",
        price: 2300,
        pricedAgain: true,
        lastPrice: 2250,
        lastPricedAt: "2026-10-27T18:00:00Z",
      }),
    ]);
  });

  it("marks a unit that left and came back as a re-listing, not a first appearance", () => {
    setup();
    write("2026-08-25T18:00:00Z", { units: [unit("705", 3275), unit("602", 2790)] });
    write("2026-09-17T18:00:00Z", { units: [unit("602", 2790)] });
    write("2026-09-24T18:00:00Z", { units: [unit("602", 2790), unit("705", 3275), unit("910", 4185)] });
    buildData(ROOT);
    const h = readHistory();
    expect(h.delta!.newUnits.map((u) => u.unitNumber).sort()).toEqual(["705", "910"]);
    // 705 was listed in August; 910 is genuinely new.
    expect(h.delta!.relistedKeys).toEqual(["u:705"]);
    expect(h.focusDelta!.relistedKeys).toEqual(["u:705"]);
    expect(h.perUnitMeta["705"]!.firstSeen).toBe("2026-08-25T18:00:00Z");
    const fresh = brief().buildings[0]!.new;
    expect(fresh.find((l) => l.unitNumber === "705")).toMatchObject({
      relisted: true,
      firstSeen: "2026-08-25T18:00:00Z",
    });
    expect(fresh.find((l) => l.unitNumber === "910")!.relisted).toBeUndefined();
  });

  it("says so when the site's bot protection refused the scrape, and counts the streak", () => {
    setup();
    write("2026-11-09T18:00:00Z", { units: [unit("705", 3275)] });
    const refused = { status: "error", error: "the site's bot protection refused the request (HTTP 403)", blocked: true };
    write("2026-11-10T18:00:00Z", refused);
    write("2026-11-11T18:00:00Z", refused);
    buildData(ROOT);
    const h = readHistory();
    expect(h.lastAttempt).toEqual({
      timestamp: "2026-11-11T18:00:00Z",
      status: "error",
      error: refused.error,
      blocked: true,
      failedRuns: 2,
    });
    expect(h.warnings).toEqual([
      {
        code: "scrape-error",
        message:
          "The leasing site's bot protection refused the last scrape, so nothing new could be read. Showing data from 2026-11-09. The next scheduled run will ask again.",
      },
    ]);
    // The last good inventory is still served, dated.
    expect(h.latest!.timestamp).toBe("2026-11-09T18:00:00Z");
    expect(brief().buildings[0]).toMatchObject({ status: "error", blocked: true, listingsAsOf: "2026-11-09T18:00:00Z" });
  });

  it("explains a same-ratio repricing of every unit as a concession, not a rent cut", () => {
    setup();
    // The Leo, 10 → 12 Nov 2026: both units ×17/18 the day "half a month free" went up.
    write("2026-11-10T18:00:00Z", { units: [unit("705", 3275), unit("602", 2790)] });
    write("2026-11-12T18:00:00Z", { units: [unit("705", 3093), unit("602", 2635)] });
    buildData(ROOT);
    const w = readHistory().warnings;
    expect(w.map((x) => x.code)).toEqual(["uniform-reprice"]);
    expect(w[0]!.message).toContain("All 2 units listed in both runs were repriced by the same −5.6% at once");
    expect(w[0]!.message).toContain("netted into");

    // Ordinary, different moves are just price changes.
    setup();
    write("2026-11-10T18:00:00Z", { units: [unit("705", 3275), unit("602", 2790)] });
    write("2026-11-12T18:00:00Z", { units: [unit("705", 3200), unit("602", 2790)] });
    buildData(ROOT);
    expect(readHistory().warnings).toEqual([]);

    // Two units that shared a price and got the same cut are not "every unit by the same ratio".
    setup();
    write("2026-11-10T18:00:00Z", { units: [unit("705", 3000), unit("602", 3000)] });
    write("2026-11-12T18:00:00Z", { units: [unit("705", 2950), unit("602", 2950)] });
    buildData(ROOT);
    expect(readHistory().warnings).toEqual([]);
  });
});

describe("buildData: warnings and notes that must not vanish", () => {
  const write = (ts: string, building: object, buildingId = "test-bldg"): void =>
    writeFileSync(
      join(ROOT, "data", "snapshots", `${ts.replaceAll(":", "-")}.json`),
      JSON.stringify({
        schemaVersion: 1,
        timestamp: ts,
        buildings: [
          {
            buildingId,
            status: "ok",
            source: { adapter: "generic", fetchedUrl: "https://example.com/" },
            units: [],
            ...building,
          },
        ],
      }),
    );
  const brief = (): WeekdayBrief =>
    JSON.parse(readFileSync(join(ROOT, "web", "public", "data", "brief.json"), "utf8")) as WeekdayBrief;

  it("keeps a warning through a second run on the same day (judged against yesterday, like the brief)", () => {
    setup();
    write("2026-11-10T18:00:00Z", { units: [unit("705", 3275), unit("602", 2790)] });
    write("2026-11-12T15:00:00Z", { units: [unit("705", 3093), unit("602", 2635)] });
    buildData(ROOT);
    expect(readHistory().warnings.map((w) => w.code)).toEqual(["uniform-reprice"]);
    // A second look the same afternoon: nothing new, but the day's story is the same.
    write("2026-11-12T21:00:00Z", { units: [unit("705", 3093), unit("602", 2635)] });
    buildData(ROOT);
    expect(readHistory().warnings.map((w) => w.code)).toEqual(["uniform-reprice"]);
    const row = brief().buildings[0]!;
    expect(row.drops.map((d) => [d.label, d.concessionLikely])).toEqual([
      ["#705", true],
      ["#602", true],
    ]);
    // The next day, with prices unchanged, it is over.
    write("2026-11-13T18:00:00Z", { units: [unit("705", 3093), unit("602", 2635)] });
    buildData(ROOT);
    expect(readHistory().warnings).toEqual([]);
  });

  it("keeps saying lease tables are missing until they are back", () => {
    setup();
    const withTable = (n: string) => ({
      ...unit(n, 2400),
      leaseTermMonths: 18,
      leaseTerms: [{ months: 12, price: 2600 }, { months: 18, price: 2400 }],
    });
    const bare = (n: string) => ({ ...unit(n, 2400), leaseTermMonths: 18 });
    write("2026-11-15T18:00:00Z", { units: [withTable("101"), withTable("102")] });
    write("2026-11-16T18:00:00Z", { units: [bare("101"), bare("102")] });
    buildData(ROOT);
    expect(readHistory().warnings.map((w) => w.code)).toEqual(["partial-data"]);
    expect(readHistory().warnings[0]!.message).toContain("the run of 2026-11-15 had them");
    // Still missing the next day: still flagged.
    write("2026-11-17T18:00:00Z", { units: [bare("101"), bare("102")] });
    buildData(ROOT);
    expect(readHistory().warnings.map((w) => w.code)).toEqual(["partial-data"]);
    // Back: clear.
    write("2026-11-18T18:00:00Z", { units: [withTable("101"), withTable("102")] });
    buildData(ROOT);
    expect(readHistory().warnings).toEqual([]);
  });

  it("marks where the stored prices changed meaning, and records the lease term behind each plan price", () => {
    setup();
    const capped = { unitNumber: "103", floorplanName: "A1", beds: 1, advertisedPrice: 3529, leaseTermMonths: 18, reason: "over-cap" };
    write("2026-09-07T18:00:00Z", { units: [{ ...unit("101", 2283), leaseTermMonths: 18 }] });
    write("2026-09-08T18:00:00Z", { units: [{ ...unit("101", 2409), leaseTermMonths: 14 }], omitted: [capped] });
    write("2026-11-14T18:00:00Z", { units: [{ ...unit("101", 2409), leaseTermMonths: 14 }], omitted: [capped] });
    write("2026-11-15T18:00:00Z", {
      units: [
        { ...unit("101", 2382), leaseTermMonths: 18, leaseTerms: [{ months: 14, price: 2409 }, { months: 18, price: 2382 }] },
        { ...unit("103", 3529), leaseTermMonths: 18 },
      ],
      alsoListed: [],
    });
    buildData(ROOT);
    const h = readHistory();
    expect(h.methodChanges?.map((m) => m.t)).toEqual(["2026-09-08T18:00:00Z", "2026-11-15T18:00:00Z"]);
    expect(h.methodChanges![0]!.note).toMatch(/14 months or less/);
    expect(h.methodChanges![1]!.note).toMatch(/the leasing site itself advertises/);
    // The plan line steps on those days; each point says which lease length it was.
    expect(h.perFloorplan["A1"]!.map((p) => [p.minPrice, p.term])).toEqual([
      [2283, 18],
      [2409, 14],
      [2409, 14],
      [2382, 18],
    ]);
    // …and the like-for-like delta knows nothing really changed.
    expect(h.delta!.priceChanges).toEqual([]);
    expect(h.delta!.newUnits).toEqual([]);
  });

  it("does not replay yesterday's news for a building the newest run did not scrape", () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(join(ROOT, "data", "snapshots"), { recursive: true });
    const b = (id: string) => ({ id, name: id, address: "x", lat: 41.9, lon: -87.63, url: "https://example.com/", adapter: "generic", geometry: { floors: 10 } });
    writeFileSync(join(ROOT, "buildings.json"), JSON.stringify({ schemaVersion: 1, buildings: [b("aaa"), b("bbb")] }));
    const both = (ts: string, a: object[], bUnits: object[]): void =>
      writeFileSync(
        join(ROOT, "data", "snapshots", `${ts.replaceAll(":", "-")}.json`),
        JSON.stringify({
          schemaVersion: 1,
          timestamp: ts,
          buildings: [
            { buildingId: "aaa", status: "ok", source: { adapter: "generic", fetchedUrl: "https://example.com/" }, units: a },
            { buildingId: "bbb", status: "ok", source: { adapter: "generic", fetchedUrl: "https://example.com/" }, units: bUnits },
          ],
        }),
      );
    both("2026-11-13T18:00:00Z", [unit("101", 2000)], [unit("201", 3000)]);
    both("2026-11-14T18:00:00Z", [unit("101", 1900)], [unit("201", 2900), unit("202", 3100)]);
    buildData(ROOT);
    expect(brief().summary).toMatchObject({ drops: 2, newListings: 1 });
    // 15 Nov: only building "aaa" is refreshed.
    write("2026-11-15T18:00:00Z", { units: [unit("101", 1900)] }, "aaa");
    buildData(ROOT);
    const day = brief();
    expect(day.summary).toMatchObject({ drops: 0, newListings: 0 });
    const stale = day.buildings.find((r) => r.id === "bbb")!;
    expect(stale).toMatchObject({ stale: true, drops: [], new: [], listingsAsOf: "2026-11-14T18:00:00Z" });
    expect(stale.listings).toHaveLength(2);
    expect(day.buildings.find((r) => r.id === "aaa")!.stale).toBeUndefined();
  });
});
