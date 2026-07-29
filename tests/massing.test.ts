import { describe, expect, it } from "vitest";
import { inferBuilding, type InferUnitInput } from "@/lib/massing/infer";
import { buildingHeightM, floorSlabHeight, physicalFloorIndex } from "@/lib/massing/spec";
import { resolveUnitPlacement } from "@/lib/units/placement";
import { polygonArea } from "@/lib/geo";

/** Eight lines, floors 4-38, skipping 13 — a conventional Chicago tower. */
function towerUnits(): InferUnitInput[] {
  const sqftByLine: Record<string, number> = {
    "01": 512, "02": 706, "03": 742, "04": 1148,
    "05": 698, "06": 498, "07": 1102, "08": 1215,
  };
  const units: InferUnitInput[] = [];
  for (let floor = 4; floor <= 38; floor++) {
    if (floor === 13) continue;
    for (const [line, sqft] of Object.entries(sqftByLine)) {
      units.push({ unitCode: `${floor}${line}`, floor, line, sqft, bedrooms: 1 });
    }
  }
  return units;
}

describe("inferBuilding", () => {
  const result = inferBuilding({ slug: "t", name: "Tower", units: towerUnits() });

  it("recovers the floor range from the unit labels", () => {
    expect(result.spec.baseFloor).toBe(4);
    expect(result.spec.topFloor).toBe(38);
  });

  it("detects that the building skips 13", () => {
    expect(result.spec.skippedFloors).toContain(13);
    // A skipped floor must not consume height.
    expect(physicalFloorIndex(result.spec, 14)).toBe(physicalFloorIndex(result.spec, 12) + 1);
  });

  it("produces one stack per observed line", () => {
    expect(result.plate.stacks.map((s) => s.line).sort()).toEqual([
      "01", "02", "03", "04", "05", "06", "07", "08",
    ]);
  });

  it("solves a plate whose area is consistent with the units on it", () => {
    const plateArea = polygonArea(result.plate.outline.map((p) => ({ x: p.x, y: p.y })));
    const unitAreaSqm = Object.values({
      "01": 512, "02": 706, "03": 742, "04": 1148,
      "05": 698, "06": 498, "07": 1102, "08": 1215,
    }).reduce((a, b) => a + b, 0) / 10.7639;

    // The gross plate must exceed the net unit area (corridors, core, walls)
    // but not absurdly so — real residential efficiency is roughly 70-85%.
    expect(plateArea).toBeGreaterThan(unitAreaSqm);
    expect(plateArea).toBeLessThan(unitAreaSqm * 2);
  });

  it("gives every stack a footprint and never a degenerate one", () => {
    for (const stack of result.plate.stacks) {
      const area = polygonArea(stack.polygon.map((p) => ({ x: p.x, y: p.y })));
      expect(area).toBeGreaterThan(10);
    }
  });

  it("reports its assumptions rather than presenting them as fact", () => {
    expect(result.confidence).toBe("estimated");
    expect(result.spec.provenance.notes.length).toBeGreaterThan(0);
    expect(result.spec.provenance.source).toBe("inferred-from-listings");
  });

  it("refuses to invent geometry with no placeable units", () => {
    expect(() =>
      inferBuilding({
        slug: "x",
        name: "X",
        units: [{ unitCode: "Garden A", floor: null, line: null }],
      }),
    ).toThrow(/floor and a line/);
  });
});

describe("floor heights", () => {
  const result = inferBuilding({ slug: "t", name: "Tower", units: towerUnits() });

  it("stacks floors monotonically", () => {
    let prev = -1;
    for (let f = 4; f <= 38; f++) {
      if (f === 13) continue;
      const h = floorSlabHeight(result.spec, f);
      expect(h).toBeGreaterThan(prev);
      prev = h;
    }
  });

  it("produces a plausible overall height for a 38-storey tower", () => {
    const h = buildingHeightM(result.spec);
    expect(h).toBeGreaterThan(90);
    expect(h).toBeLessThan(200);
  });
});

describe("resolveUnitPlacement", () => {
  const { spec, plate } = inferBuilding({
    slug: "t",
    name: "Tower",
    units: towerUnits(),
  });

  it("places a unit on the right floor at the right height", () => {
    const p = resolveUnitPlacement(spec, plate, {
      unitCode: "3208",
      floor: 32,
      line: "08",
    })!;
    expect(p.floor).toBe(32);
    expect(p.slabHeightM).toBeCloseTo(floorSlabHeight(spec, 32), 5);
    expect(p.eyeHeightM).toBeGreaterThan(p.slabHeightM);
  });

  it("gives every unit at least one compass exposure", () => {
    for (const stack of plate.stacks) {
      const p = resolveUnitPlacement(spec, plate, {
        unitCode: `20${stack.line}`,
        floor: 20,
        line: stack.line,
      })!;
      expect(p.exposures.length).toBeGreaterThan(0);
      expect(p.facing).toMatch(/^[NSEW]/);
    }
  });

  it("assigns different lines to different sides of the building", () => {
    const facings = plate.stacks.map(
      (s) =>
        resolveUnitPlacement(spec, plate, {
          unitCode: `20${s.line}`,
          floor: 20,
          line: s.line,
        })!.facing,
    );
    // Eight lines around a rectangular plate must not all face one way.
    expect(new Set(facings).size).toBeGreaterThan(1);
  });

  it("flags corner units as having two exposures", () => {
    const corners = plate.stacks
      .map(
        (s) =>
          resolveUnitPlacement(spec, plate, {
            unitCode: `20${s.line}`,
            floor: 20,
            line: s.line,
          })!,
      )
      .filter((p) => p.isCorner);
    expect(corners.length).toBeGreaterThan(0);
    for (const c of corners) expect(c.exposureLabel).toMatch(/corner/);
  });

  it("prefers the advertised square footage over the derived polygon area", () => {
    const p = resolveUnitPlacement(
      spec,
      plate,
      { unitCode: "3208", floor: 32, line: "08" },
      { sqft: 1215 },
    )!;
    expect(p.areaSqft).toBe(1215);
  });

  it("returns null for a line the plate does not have", () => {
    expect(
      resolveUnitPlacement(spec, plate, { unitCode: "3299", floor: 32, line: "99" }),
    ).toBeNull();
  });
});
