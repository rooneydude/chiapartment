import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The program that puts two versions of a unit map together when two refresh
 * runs overlap (.github/scripts/merge-unitmap.mjs), run the way git runs it:
 * `node merge-unitmap.mjs <base> <landed> <mine>`, result left in <landed>.
 * scraper/test/ci-commit.test.ts runs it through a real rebase; here each
 * rule is checked on its own.
 */
const REPO = join(__dirname, "..", "..");
const PROGRAM = join(REPO, ".github", "scripts", "merge-unitmap.mjs");
const DIR = mkdtempSync(join(tmpdir(), "chiapartment-unitmap-merge-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

type Entry = { lon: number; lat: number; facing: string; levelIndex: number };
const at = (facing: string, levelIndex = 7): Entry => ({ lon: -87.6340911, lat: 41.9055604, facing, levelIndex });
const file = (capturedAt: string, units: Record<string, Entry>, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify(
    {
      schemaVersion: 1,
      buildingId: "1225-old-town",
      source: { sightmapId: "87594", assetUrl: "https://example.com/a.umap", capturedAt },
      fit: { metersPerPixel: 0.0842, residualM: 5.7 },
      ...extra,
      units,
    },
    null,
    2,
  )}\n`;

let n = 0;
/** Run the program on three file contents; base "" = neither side started from a file. */
function merge(base: string, landed: string, mine: string): { code: number | null; message: string; result: string; landedPath: string } {
  const paths = ["base", "landed", "mine"].map((name) => join(DIR, `${++n}-${name}.json`));
  [base, landed, mine].forEach((text, i) => writeFileSync(paths[i]!, text));
  const ran = spawnSync("node", [PROGRAM, ...paths], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
  return { code: ran.status, message: ran.stderr, result: readFileSync(paths[1]!, "utf8"), landedPath: paths[1]! };
}

describe("two versions of a unit map, put together", () => {
  const BASE = file("2026-11-18T22:00:13.000Z", { "1014": at("N"), "2203": at("E", 20), "0704": at("S", 5), "0905": at("W", 7) });

  it("keeps what both runs learned, and says it was captured when this run captured it", () => {
    const landed = file("2026-11-19T22:05:00.000Z", { "1014": at("N"), "2203": at("W", 20), "0704": at("SE", 5), "0905": at("W", 7), "0812": at("N", 6) });
    const mine = file(
      "2026-11-19T22:11:27.000Z",
      { "1014": at("N"), "2203": at("SW", 20), "0704": at("S", 5), "0905": at("NW", 7), "1503": at("E", 13) },
      { fit: { metersPerPixel: 0.085, residualM: 5.1 } },
    );
    const { code, result } = merge(BASE, landed, mine);
    expect(code).toBe(0);
    const merged = JSON.parse(result) as { source: { capturedAt: string }; fit: unknown; units: Record<string, Entry> };
    expect(merged.units).toEqual({
      "1014": at("N"), // nobody touched it
      "2203": at("SW", 20), // both placed it afresh: this run's, the later capture
      "0704": at("SE", 5), // only the other run changed it
      "0905": at("NW", 7), // only this run changed it
      "0812": at("N", 6), // only the other run saw it listed — not lost
      "1503": at("E", 13), // only this run saw it listed
    });
    expect(merged.source.capturedAt).toBe("2026-11-19T22:11:27.000Z");
    expect(merged.fit).toEqual({ metersPerPixel: 0.085, residualM: 5.1 });
  });

  it("writes the file the way the generator does, so the next run changes nothing but what it learns", () => {
    // The committed map, stamped by two runs that learned nothing new: the
    // result has to be this run's file, byte for byte.
    const real = join(REPO, "data", "unitmaps", "1225-old-town.json");
    const committed = existsSync(real) ? readFileSync(real, "utf8") : BASE;
    const stamped = (time: string): string => {
      const map = JSON.parse(committed) as { source: { capturedAt: string } };
      map.source.capturedAt = time;
      return `${JSON.stringify(map, null, 2)}\n`;
    };
    expect(stamped((JSON.parse(committed) as { source: { capturedAt: string } }).source.capturedAt)).toBe(committed);
    const mine = stamped("2026-11-20T22:11:27.000Z");
    const { code, result } = merge(committed, stamped("2026-11-20T22:05:00.000Z"), mine);
    expect(code).toBe(0);
    expect(result).toBe(mine);
  });

  it("honours a removal: no run removes a unit, so one that is gone was taken out on purpose", () => {
    const without0905 = { "1014": at("N"), "2203": at("E", 20), "0704": at("S", 5) };
    // taken out by a pull request that landed; this run still carries it, unchanged
    const a = merge(BASE, file("2026-11-18T22:00:13.000Z", without0905), file("2026-11-19T22:11:27.000Z", { ...without0905, "0905": at("W", 7) }));
    expect(a.code).toBe(0);
    expect(Object.keys((JSON.parse(a.result) as { units: object }).units).sort()).toEqual(["0704", "1014", "2203"]);
    // …unless this run learned that unit afresh: then it is listed again, and stays
    const b = merge(BASE, file("2026-11-18T22:00:13.000Z", without0905), file("2026-11-19T22:11:27.000Z", { ...without0905, "0905": at("NW", 7) }));
    expect((JSON.parse(b.result) as { units: Record<string, Entry> }).units["0905"]).toEqual(at("NW", 7));
  });

  it("joins two first maps when neither run started from one", () => {
    const { code, result } = merge(
      "",
      file("2026-11-19T22:05:00.000Z", { "1014": at("N"), "0812": at("N", 6) }),
      file("2026-11-19T22:11:27.000Z", { "1014": at("NE"), "1503": at("E", 13) }),
    );
    expect(code).toBe(0);
    expect((JSON.parse(result) as { units: unknown }).units).toEqual({ "1014": at("NE"), "0812": at("N", 6), "1503": at("E", 13) });
    expect(result.endsWith("}\n")).toBe(true);
    expect(result).toContain('\n  "units": {\n    "1014": {\n      "lon": ');
  });

  it("gives the same file whichever of two identical changes is “this run’s”", () => {
    const changed = file("2026-11-19T22:05:00.000Z", { "1014": at("N"), "2203": at("E", 20), "0704": at("S", 5), "0905": at("W", 7), "0812": at("N", 6) });
    expect(merge(BASE, changed, changed).result).toBe(changed);
  });

  it("refuses, and leaves the files alone, when one of them is not a unit map", () => {
    const good = file("2026-11-19T22:11:27.000Z", { "1014": at("N") });
    const cases: [string, string, string, RegExp][] = [
      [BASE, '{"units": {"1014": \n', good, /^merge-unitmap: the file on the branch is not JSON$/m],
      [BASE, good, "<<<<<<< HEAD\n", /^merge-unitmap: this run's file is not JSON$/m],
      [BASE, good, '{"schemaVersion":1,"units":[]}\n', /^merge-unitmap: this run's file is not a unit map/m],
      [BASE, '"units"\n', good, /^merge-unitmap: the file on the branch is not a unit map/m],
      ["not json at all", good, good, /^merge-unitmap: the file both sides started from is not JSON$/m],
      [BASE, file("2026-11-19T22:05:00.000Z", { "1014": at("N") }, { buildingId: "the-leo" }), good, /^merge-unitmap: the two files are for different buildings/m],
    ];
    for (const [base, landed, mine, message] of cases) {
      const ran = merge(base, landed, mine);
      expect(ran.code, String(message)).toBe(1);
      expect(ran.message).toMatch(message);
      expect(ran.result).toBe(landed); // untouched: git reports a conflict, the commit step stops
    }
  });

  it("refuses to run without its three files", () => {
    const ran = spawnSync("node", [PROGRAM, join(DIR, "only-one.json")], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("usage: merge-unitmap.mjs <base> <landed> <mine>");
  });
});
