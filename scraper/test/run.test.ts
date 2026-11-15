import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BuildingConfigSchema,
  type BuildingConfig,
  type Snapshot,
  type UnitListing,
} from "../../shared/src/types";
import { makeRecorder } from "../src/fixtures";
import {
  flagGroupOutages,
  loadPreviousOk,
  pickStableObservation,
  priceFormFlips,
  type ScrapeResult,
} from "../src/run";

const ROOT = join(tmpdir(), `chiapartment-run-${process.pid}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const unit = (unitNumber: string, price: number, priceMax?: number): UnitListing => ({
  unitNumber,
  floorplanName: "A",
  beds: 1,
  baths: null,
  sqft: 700,
  price,
  ...(priceMax !== undefined ? { priceMax } : {}),
  availableDate: null,
});

const ok = (units: UnitListing[], extra: Partial<ScrapeResult> = {}): ScrapeResult => ({
  status: "ok",
  source: { adapter: "oldtownpark", fetchedUrl: "https://oldtownpark.com/" },
  units,
  ...extra,
});

describe("priceFormFlips (Old Town Park's two pricing states)", () => {
  // Observed live on 2026-11-15, six minutes apart, on the same URL.
  const yesterday = [unit("1207", 3096), unit("3907", 3546), unit("2410", 3938, 4081)];

  it("spots units that switched between a range and a different single price", () => {
    const today = [unit("1207", 3225, 3342), unit("3907", 3587, 3728), unit("2410", 3938, 4081)];
    expect(priceFormFlips(yesterday, today)).toEqual(["#1207", "#3907"]);
  });

  it("ignores ordinary price moves and new units", () => {
    const today = [unit("1207", 3050), unit("2410", 3900, 4050), unit("9999", 2000, 2100)];
    expect(priceFormFlips(yesterday, today)).toEqual([]);
    expect(priceFormFlips(null, today)).toEqual([]);
  });

  it("ignores a range appearing at an unchanged minimum", () => {
    expect(priceFormFlips([unit("1207", 3096)], [unit("1207", 3096, 3200)])).toEqual([]);
  });
});

describe("pickStableObservation", () => {
  const yesterday = [unit("1207", 3096), unit("3907", 3546)];
  const flipped = ok([unit("1207", 3225, 3342), unit("3907", 3587, 3728)]);
  const steady = ok([unit("1207", 3096), unit("3907", 3546)]);

  it("keeps the second look when it agrees with yesterday (the first caught a flip)", () => {
    const pick = pickStableObservation(yesterday, flipped, steady);
    expect(pick.picked).toBe("second");
    expect(pick.result).toBe(steady);
    expect(pick.flips).toEqual([2, 0]);
  });

  it("keeps the later look when both show the same new state (the change is real)", () => {
    const again = ok([unit("1207", 3225, 3342), unit("3907", 3587, 3728)]);
    expect(pickStableObservation(yesterday, flipped, again).result).toBe(again);
  });

  it("never trades a good first look for a failed or empty second one", () => {
    const failed: ScrapeResult = { ...ok([]), status: "error", error: "HTTP 503" };
    expect(pickStableObservation(yesterday, flipped, failed).result).toBe(flipped);
    expect(pickStableObservation(yesterday, flipped, ok([])).result).toBe(flipped);
  });

  it("keeps the first look when the second is worse", () => {
    const oneFlip = ok([unit("1207", 3225, 3342), unit("3907", 3546)]);
    expect(pickStableObservation(yesterday, oneFlip, flipped).result).toBe(oneFlip);
  });
});

describe("flagGroupOutages", () => {
  const building = (id: string, group?: string): BuildingConfig =>
    BuildingConfigSchema.parse({
      id,
      name: id,
      address: "x",
      lat: 41.9,
      lon: -87.63,
      url: "https://example.com/",
      adapter: "oldtownpark",
      ...(group ? { group } : {}),
      geometry: { floors: 10 },
    });
  const towers = [building("otp-1", "otp"), building("otp-2", "otp"), building("otp-3", "otp"), building("leo")];
  const entry = (buildingId: string, units: UnitListing[]): Snapshot["buildings"][number] => ({
    buildingId,
    ...ok(units),
  });

  it("turns 'every tower empty in one run' into scrape errors (the 2026-10-01 feed outage)", () => {
    const results = [entry("otp-1", []), entry("otp-2", []), entry("otp-3", []), entry("leo", [])];
    expect(flagGroupOutages(towers, results)).toEqual(["otp-1", "otp-2", "otp-3"]);
    expect(results.slice(0, 3).every((r) => r.status === "error" && /feed is probably down/.test(r.error!))).toBe(true);
    // A single small building with nothing listed is just an empty building.
    expect(results[3]).toMatchObject({ buildingId: "leo", status: "ok" });
  });

  it("accepts one fully-leased tower while its neighbours still list units", () => {
    const results = [entry("otp-1", []), entry("otp-2", [unit("0701", 4594)]), entry("otp-3", [unit("0801", 4096)])];
    expect(flagGroupOutages(towers, results)).toEqual([]);
    expect(results[0]!.status).toBe("ok");
  });

  it("does not judge a complex from a partial run", () => {
    const results = [entry("otp-1", [])];
    expect(flagGroupOutages(towers, results)).toEqual([]);
  });

  it("does not call it an outage when a tower still lists unpriced rows", () => {
    const results = [
      entry("otp-1", []),
      entry("otp-2", []),
      {
        buildingId: "otp-3",
        ...ok([], { alsoListed: [{ unitNumber: "4003", floorplanName: "PH3-1", beds: null, note: "Contact for Pricing" }] }),
      },
    ];
    expect(flagGroupOutages(towers, results)).toEqual([]);
  });
});

describe("loadPreviousOk", () => {
  it("finds each building's most recent successful scrape, skipping failures and junk files", () => {
    const dir = join(ROOT, "prev", "data", "snapshots");
    mkdirSync(dir, { recursive: true });
    const write = (ts: string, buildings: object[]) =>
      writeFileSync(
        join(dir, `${ts.replaceAll(":", "-")}.json`),
        JSON.stringify({ schemaVersion: 1, timestamp: ts, buildings }),
      );
    const src = { adapter: "x", fetchedUrl: "https://example.com/" };
    write("2026-11-13T18:00:00Z", [
      { buildingId: "a", status: "ok", source: src, units: [unit("101", 2000)] },
      { buildingId: "b", status: "ok", source: src, units: [unit("201", 3000)] },
    ]);
    write("2026-11-14T18:00:00Z", [
      { buildingId: "a", status: "ok", source: src, units: [unit("101", 1950)] },
      { buildingId: "b", status: "error", error: "WAF", source: src, units: [] },
    ]);
    writeFileSync(join(dir, "2026-11-15T18-00-00Z.json"), '{"schemaVersion":1,"nope":true}');
    const prev = loadPreviousOk(join(ROOT, "prev"), ["a", "b", "c"]);
    expect(prev.get("a")![0]!.price).toBe(1950);
    expect(prev.get("b")![0]!.price).toBe(3000);
    expect(prev.has("c")).toBe(false);
    expect(loadPreviousOk(join(ROOT, "nowhere"), ["a"]).size).toBe(0);
  });
});

describe("fixture recorder", () => {
  it("drops payloads an earlier capture left behind, and nothing else", () => {
    const dir = join(ROOT, "fixtures");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "00-old.json"), "{}");
    writeFileSync(join(dir, "07-stale-leasing.json"), "{}");
    writeFileSync(join(dir, "README.md"), "hand-written notes stay");
    const rec = makeRecorder(dir);
    rec.record("https://example.com/api/units", '{"a":1}', "application/json");
    rec.record("https://example.com/floorplans/", "<html></html>", "text/html");
    rec.flush();
    expect(readdirSync(dir).sort()).toEqual(["00-api-units.json", "01-floorplans.html", "README.md", "manifest.json"]);
  });

  it("leaves an existing capture alone when nothing was recorded", () => {
    const dir = join(ROOT, "fixtures-untouched");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "00-old.json"), "{}");
    makeRecorder(dir).flush();
    expect(readdirSync(dir)).toEqual(["00-old.json"]);
  });
});
