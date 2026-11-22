import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The program that puts two versions of a unit map together when two refresh
 * runs overlap (.github/scripts/merge-unitmap.mjs), run the way git runs it:
 * `node merge-unitmap.mjs <base> <landed> <mine> <name>`, result left in
 * <landed>. scraper/test/ci-commit.test.ts runs it through a real rebase;
 * here each rule is checked on its own.
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
function merge(base: string, landed: string, mine: string): { code: number | null; said: string; complained: string; result: string; others: string[] } {
  const paths = ["base", "landed", "mine"].map((name) => join(DIR, `${++n}-${name}.json`));
  [base, landed, mine].forEach((text, i) => writeFileSync(paths[i]!, text));
  const ran = spawnSync("node", [PROGRAM, ...paths, NAME], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
  return {
    code: ran.status,
    said: ran.stdout,
    complained: ran.stderr,
    result: readFileSync(paths[1]!, "utf8"),
    // the two files the program must never write to
    others: [readFileSync(paths[0]!, "utf8"), readFileSync(paths[2]!, "utf8")],
  };
}
const NAME = "data/unitmaps/1225-old-town.json";

describe("two versions of a unit map, put together", () => {
  const BASE = file("2026-11-18T22:00:13.000Z", { "1014": at("N"), "2203": at("E", 20), "0704": at("S", 5), "0905": at("W", 7) });

  it("keeps what both runs learned, and says it was captured when this run captured it", () => {
    const landed = file("2026-11-19T22:05:00.000Z", { "1014": at("N"), "2203": at("W", 20), "0704": at("SE", 5), "0905": at("W", 7), "0812": at("N", 6) });
    const mine = file(
      "2026-11-19T22:11:27.000Z",
      { "0611": at("S", 4), "1014": at("N"), "2203": at("SW", 20), "0704": at("S", 5), "0905": at("NW", 7), "1503": at("E", 13) },
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
      "0611": at("S", 4), // so too
    });
    // In the order the generator leaves a file in: plain numbers first (that
    // is JavaScript's doing), then the names the branch already had, in its
    // order, then this run's new ones — wherever this run's own file had them.
    expect(Object.keys(merged.units)).toEqual(["1014", "1503", "2203", "0704", "0905", "0812", "0611"]);
    expect(merged.source.capturedAt).toBe("2026-11-19T22:11:27.000Z");
    expect(merged.fit).toEqual({ metersPerPixel: 0.085, residualM: 5.1 });
  });

  it("writes the file the way the generator does, so the next run changes nothing but what it learns", () => {
    // What scraper/src/unitmap.ts does with a file it is handed: keep its
    // units, add or replace the ones it saw, stamp it, write two-space JSON.
    const generate = (prior: string, time: string, seen: Record<string, Entry>): string => {
      const map = JSON.parse(prior) as { source: { capturedAt: string }; units: Record<string, Entry> };
      map.source.capturedAt = time;
      Object.assign(map.units, seen);
      return `${JSON.stringify(map, null, 2)}\n`;
    };
    // The committed map where there is one (real names, real numbers), as the generator writes it.
    const real = join(REPO, "data", "unitmaps", "1225-old-town.json");
    const start = generate(existsSync(real) ? readFileSync(real, "utf8") : BASE, "2026-11-19T22:12:17.518Z", {});

    // Two runs that learned nothing new: the result is this run's file, byte for byte.
    const mine = generate(start, "2026-11-20T22:11:27.000Z", {});
    expect(merge(start, generate(start, "2026-11-20T22:05:00.000Z", {}), mine).result).toBe(mine);

    // Two runs that each learned units no building has — names with a
    // leading zero, with letters, and plain numbers, which JavaScript orders
    // differently. The result is, byte for byte, what the generator would
    // have written had this run started from the file that landed.
    const landed = generate(start, "2026-11-20T22:05:00.000Z", { "00-B": at("N", 6), "99901": at("S", 40), "ZZ-2": at("E", 41) });
    const learned = { "00-A": at("W", 7), "99902": at("E", 40), "ZZ-1": at("W", 41) };
    const { code, result } = merge(start, landed, generate(start, "2026-11-20T22:11:27.000Z", learned));
    expect(code).toBe(0);
    expect(result).toBe(generate(landed, "2026-11-20T22:11:27.000Z", learned));
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

  it("treats any name as a unit's name", () => {
    // JSON.parse makes these ordinary entries; writing them back must too.
    const odd = (names: string[]): string =>
      `{"schemaVersion":1,"buildingId":"1225-old-town","units":{${names.map((n) => `"${n}":{"facing":"N"}`).join(",")}}}\n`;
    const { code, result } = merge(odd(["1014"]), odd(["1014", "__proto__"]), odd(["1014", "constructor", "toString"]));
    expect(code).toBe(0);
    expect(result).toContain('"__proto__": {');
    expect(Object.keys((JSON.parse(result) as { units: object }).units).sort()).toEqual(["1014", "__proto__", "constructor", "toString"]);
  });

  it("gives the same file whichever of two identical changes is “this run’s”", () => {
    const changed = file("2026-11-19T22:05:00.000Z", { "1014": at("N"), "2203": at("E", 20), "0704": at("S", 5), "0905": at("W", 7), "0812": at("N", 6) });
    expect(merge(BASE, changed, changed).result).toBe(changed);
  });

  it("leaves what landed exactly as it is, and says why, when the two cannot be merged — without failing", () => {
    // To git a failing merge program is a conflict, and a conflict stops the
    // commit that carries the day's prices. So: succeed, change nothing, say so.
    const good = file("2026-11-19T22:11:27.000Z", { "1014": at("N") });
    const cases: [base: string, landed: string, mine: string, why: string][] = [
      [BASE, '{"units": {"1014": \n', good, "the file on the branch is not JSON"],
      [BASE, good, "<<<<<<< HEAD\n", "this run's file is not JSON"],
      [BASE, good, '{"schemaVersion":1,"units":[]}\n', `this run's file is not a unit map (it has no "units")`],
      [BASE, '"units"\n', good, `the file on the branch is not a unit map (it has no "units")`],
      ["not json at all", good, good, "the file both sides started from is not JSON"],
      [BASE, file("2026-11-19T22:05:00.000Z", { "1014": at("N") }, { buildingId: "the-leo" }), good, `the two files are for different buildings ("the-leo", "1225-old-town")`],
      // a pull request changed the format while this run, on the old code, was under way
      [BASE, file("2026-11-19T22:05:00.000Z", { "1014": at("N") }, { schemaVersion: 2, levels: [1, 2] }), good, "the two files are in different versions of the format (2, 1)"],
    ];
    for (const [base, landed, mine, why] of cases) {
      const ran = merge(base, landed, mine);
      expect(ran.code, why).toBe(0);
      expect(ran.result, why).toBe(landed);
      expect(ran.others, why).toEqual([base, mine]);
      // one line, in the form GitHub shows on the run's page — and about what
      // this program did, not about the prices, whose push is still to come
      expect(ran.said).toBe(`::warning::The unit map ${NAME} was left as it landed; this run's version of it is dropped: ${why}.\n`);
      expect(ran.complained).toBe("");
    }
  });

  it("keeps its warning to one line whatever the files hold", () => {
    // A file that landed must not be able to write a line of its own into
    // the run's log: GitHub would read one starting with "::" as a command.
    const hostile = `${JSON.stringify({ schemaVersion: 1, buildingId: "a\n::error::made up\r\n::set-output name=x::y", units: {} }, null, 2)}\n`;
    const ran = merge("", hostile, file("2026-11-19T22:11:27.000Z", { "1014": at("N") }));
    expect(ran.code).toBe(0);
    expect(ran.result).toBe(hostile);
    expect(ran.said.endsWith(".\n")).toBe(true);
    expect(ran.said.trimEnd().split(/[\r\n]/)).toHaveLength(1);
    expect(ran.said.startsWith(`::warning::The unit map ${NAME} was left as it landed;`)).toBe(true);

    // …nor a file's name: git allows a line break in one.
    const paths = ["name-base", "name-landed", "name-mine"].map((name) => join(DIR, `${name}.json`));
    ["", "not a unit map\n", file("2026-11-19T22:11:27.000Z", { "1014": at("N") })].forEach((text, i) => writeFileSync(paths[i]!, text));
    const named = spawnSync("node", [PROGRAM, ...paths, "data/unitmaps/odd\n::error::made up.json"], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    expect(named.status).toBe(0);
    expect(named.stdout.trimEnd().split(/[\r\n]/)).toHaveLength(1);
    expect(named.stdout).toContain("data/unitmaps/odd ::error::made up.json");
  });

  it("says nothing when it merges", () => {
    const ran = merge(BASE, file("2026-11-19T22:05:00.000Z", { "1014": at("N") }), file("2026-11-19T22:11:27.000Z", { "1014": at("N"), "1503": at("E", 13) }));
    expect(ran.code).toBe(0);
    expect(ran.said).toBe("");
    expect(ran.complained).toBe("");
  });

  it("fails only when it is called wrongly, or a file is not there to read", () => {
    const env = { PATH: process.env["PATH"] ?? "" };
    const few = spawnSync("node", [PROGRAM, join(DIR, "only-one.json")], { encoding: "utf8", env });
    expect(few.status).toBe(1);
    expect(few.stderr).toContain("usage: merge-unitmap.mjs <base> <landed> <mine>");
    const landed = join(DIR, "there.json");
    writeFileSync(landed, BASE);
    const missing = spawnSync("node", [PROGRAM, join(DIR, "nowhere-a.json"), landed, join(DIR, "nowhere-b.json")], { encoding: "utf8", env });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/^merge-unitmap: ENOENT/);
    expect(readFileSync(landed, "utf8")).toBe(BASE);
  });
});
