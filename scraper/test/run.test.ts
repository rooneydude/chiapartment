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
  describeRun,
  flagGroupOutages,
  loadPreviousOk,
  pickStableObservation,
  priceFormFlips,
  quarantineInvalidBuildings,
  sanitizeListings,
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

  it("does not let a partial second look win for having fewer units to flip", () => {
    // 19 units the first time, 1 the second: fewer flips, and most of the page missing.
    const many = Array.from({ length: 19 }, (_, i) => unit(String(1000 + i), 3000 + i));
    const before = many.map((u) => ({ ...u }));
    const first = ok(many.map((u, i) => (i < 2 ? { ...u, price: u.price + 100, priceMax: u.price + 300 } : u)));
    const partial = ok([many[5]!]);
    const pick = pickStableObservation(before, first, partial);
    expect(pick.picked).toBe("first");
    expect(pick.result.units).toHaveLength(19);
    // A second look missing a unit or two is still a full look, judged on what both saw.
    const nearlyAll = ok(many.slice(0, 18));
    expect(pickStableObservation(before, first, nearlyAll).picked).toBe("second");
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

  it("still sees the outage when one tower's request fails outright and the others come back empty", () => {
    const failed: Snapshot["buildings"][number] = {
      buildingId: "otp-1",
      ...ok([]),
      status: "error",
      error: "HTTP 503",
    };
    const results = [failed, entry("otp-2", []), entry("otp-3", [])];
    expect(flagGroupOutages(towers, results)).toEqual(["otp-2", "otp-3"]);
    expect(results.map((r) => r.status)).toEqual(["error", "error", "error"]);
    // The tower that failed on its own keeps its own error.
    expect(results[0]!.error).toBe("HTTP 503");
    // Every tower failing outright is already three errors: nothing to flag.
    const allFailed = [failed, { ...failed, buildingId: "otp-2" }, { ...failed, buildingId: "otp-3" }];
    expect(flagGroupOutages(towers, allFailed)).toEqual([]);
    // One failure next to towers that list units is just one failure.
    const mixed = [failed, entry("otp-2", [unit("0701", 4594)]), entry("otp-3", [])];
    expect(flagGroupOutages(towers, mixed)).toEqual([]);
    expect(mixed[2]!.status).toBe("ok");
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

describe("loadPreviousOk with a damaged file", () => {
  it("skips a snapshot that is not valid JSON instead of aborting the scrape", () => {
    const root = join(ROOT, "damaged");
    const dir = join(root, "data", "snapshots");
    mkdirSync(dir, { recursive: true });
    const good: Snapshot = {
      schemaVersion: 1,
      timestamp: "2026-11-14T18:00:00Z",
      buildings: [{ buildingId: "a", ...ok([unit("101", 2000)]) }],
    };
    writeFileSync(join(dir, "2026-11-14T18-00-00Z.json"), JSON.stringify(good));
    writeFileSync(join(dir, "2026-11-15T18-00-00Z.json"), "");
    writeFileSync(join(dir, "2026-11-16T18-00-00Z.json"), '{"schemaVersion": 1, "timest');
    expect(loadPreviousOk(root, ["a"]).get("a")).toHaveLength(1);
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

describe("describeRun (the CI summary and health check)", () => {
  const snap = (buildings: Snapshot["buildings"]): Snapshot => ({
    schemaVersion: 1,
    timestamp: "2026-11-16T14:20:00Z",
    buildings,
  });

  it("counts what worked and names what did not, refusals apart from failures", () => {
    const run = describeRun(
      snap([
        { buildingId: "a", ...ok([unit("101", 2000)], { source: { adapter: "x", fetchedUrl: "https://a/", requests: 17 } }) },
        {
          buildingId: "b",
          status: "error",
          error: "the site's bot protection refused the request (HTTP 403)",
          blocked: true,
          source: { adapter: "x", fetchedUrl: "https://b/", requests: 1 },
          units: [],
        },
        {
          buildingId: "c",
          status: "error",
          error: "no unit data | found\non the page",
          source: { adapter: "x", fetchedUrl: "https://c/" },
          units: [],
        },
      ]),
    );
    expect(run).toMatchObject({ ok: 1, total: 3, failed: ["b", "c"] });
    expect(run.markdown).toContain("### Scrape 2026-11-16T14:20:00Z: 1/3 buildings ok");
    expect(run.markdown).toContain("| a | ok | 1 listed | 17 |");
    expect(run.markdown).toContain("| b | refused by the site |");
    // A pipe or line break in an error must not break the table.
    expect(run.markdown).toContain("| c | FAILED | no unit data \\| found on the page | ? |");
  });

  it("reports a run in which nothing could be read", () => {
    const run = describeRun(
      snap([
        { buildingId: "a", status: "error", error: "fetch failed", source: { adapter: "x", fetchedUrl: "https://a/" }, units: [] },
      ]),
    );
    expect(run.ok).toBe(0);
    expect(run.failed).toEqual(["a"]);
  });
});

describe("one bad row must not cost the whole run", () => {
  it("keeps the good listings and moves a malformed one to the also-listed list", () => {
    const logs: string[] = [];
    const out = sanitizeListings(
      [unit("0901", 2200), { ...unit("0509", 3774), beds: null }, { ...unit("0510", 0) }, { floorplanName: "A", beds: 1 }],
      [{ unitNumber: "4003", floorplanName: "PH", beds: null, note: "Contact for Pricing" }, { unitNumber: "x" }],
      (m) => logs.push(m),
    );
    expect(out.units.map((u) => u.unitNumber)).toEqual(["0901"]);
    expect(out.alsoListed.map((a) => [a.unitNumber, a.floorplanName, a.note])).toEqual([
      ["4003", "PH", "Contact for Pricing"],
      ["0509", "A", "Listed, but its details could not be read"],
      ["0510", "A", "Listed, but its details could not be read"],
      [null, "A", "Listed, but its details could not be read"],
    ]);
    expect(logs.join("\n")).toContain("unit 0509: the scraper produced a row that does not fit the format (beds:");
    expect(logs.join("\n")).toContain("dropped a malformed also-listed row");
  });

  it("turns a building whose entry still does not fit into that building's error, and keeps the rest", () => {
    const snap = {
      schemaVersion: 1 as const,
      timestamp: "2026-11-16T14:20:00Z",
      buildings: [
        { buildingId: "a", ...ok([unit("101", 2000)]) },
        { buildingId: "b", ...ok([{ ...unit("201", 3000), price: -5 }]) },
      ],
    } as Snapshot;
    expect(quarantineInvalidBuildings(snap)).toEqual(["b"]);
    expect(snap.buildings.map((b) => [b.buildingId, b.status, b.units.length])).toEqual([
      ["a", "ok", 1],
      ["b", "error", 0],
    ]);
    expect(snap.buildings[1]!.error).toMatch(/does not fit the snapshot format \(units\.0\.price/);
  });
});
