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
