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

  it("flags empty runs, price jumps, and count drops", () => {
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
    expect(codes).toContain("price-jump"); // 2000 → 2600 median = 30%
    expect(codes).toContain("count-drop"); // 4 → 1

    writeSnapshot("2026-07-15T12:00:00Z", "ok", []);
    buildData(ROOT);
    expect(readHistory().warnings.map((w) => w.code)).toContain("empty-run");
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
