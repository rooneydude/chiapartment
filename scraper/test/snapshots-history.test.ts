import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SnapshotSchema } from "../../shared/src/types";

/**
 * Tripwire: build-data skips files that fail SnapshotSchema.parse, which would
 * drop historical prices from the dashboard while the JSON still sits in git.
 * Every committed snapshot must keep compiling. Never delete or rewrite these
 * files to make a test pass.
 */
const SNAP_DIR = join(import.meta.dirname, "..", "..", "data", "snapshots");
const BUILDINGS = [
  "1225-old-town",
  "old-town-park-1",
  "old-town-park-2",
  "old-town-park-3",
  "the-leo",
  "stead-220",
] as const;

describe("committed snapshot history", () => {
  const files = readdirSync(SNAP_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  it("keeps a non-trivial append-only archive", () => {
    // Floor is the count as of the 8 Sep 2026 audit. New scrapes may add files;
    // deleting history must fail this test.
    expect(files.length).toBeGreaterThanOrEqual(47);
  });

  it("parses every snapshot with the current schema (no silent skips)", () => {
    const parsed: string[] = [];
    const failed: string[] = [];
    for (const f of files) {
      try {
        SnapshotSchema.parse(JSON.parse(readFileSync(join(SNAP_DIR, f), "utf8")));
        parsed.push(f);
      } catch (err) {
        failed.push(`${f}: ${err instanceof Error ? err.message : err}`);
      }
    }
    expect(failed, failed.join("\n")).toEqual([]);
    expect(parsed).toHaveLength(files.length);
  });

  it("latest full snapshot includes every tracked building", () => {
    const full = [...files].reverse().find((f) => {
      const snap = SnapshotSchema.parse(JSON.parse(readFileSync(join(SNAP_DIR, f), "utf8")));
      return snap.buildings.length === BUILDINGS.length;
    });
    expect(full).toBeDefined();
    const snap = SnapshotSchema.parse(JSON.parse(readFileSync(join(SNAP_DIR, full!), "utf8")));
    expect(snap.buildings.map((b) => b.buildingId).sort()).toEqual([...BUILDINGS].sort());
  });

  it("does not require omitted[] on historical files (no back-fill)", () => {
    const sep7 = files.find((f) => f.startsWith("2026-09-07"));
    expect(sep7).toBeDefined();
    const snap = SnapshotSchema.parse(JSON.parse(readFileSync(join(SNAP_DIR, sep7!), "utf8")));
    const ot = snap.buildings.find((b) => b.buildingId === "1225-old-town");
    expect(ot?.omitted).toBeUndefined();
    expect(ot?.units.length).toBeGreaterThan(6);
  });
});
