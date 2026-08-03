import { describe, expect, it } from "vitest";
import {
  facadeParam,
  facadePoint,
  facingFromNormal,
  makeBoxRing,
  normalizeRing,
  orientedBoxRing,
  placeStackBand,
  placeUnit,
  ringCentroid,
  ringSignedArea,
  type Vec2,
} from "../src/placement";
import { BuildingGeometrySchema, UnitMappingSchema } from "../src/types";

const square: Vec2[] = [
  [0, 0],
  [20, 0],
  [20, 20],
  [0, 20],
];

describe("ring helpers", () => {
  it("computes signed area and centroid", () => {
    expect(ringSignedArea(square)).toBe(400);
    expect(ringCentroid(square)).toEqual([10, 10]);
  });

  it("normalizes clockwise + closed rings to open CCW", () => {
    const closedCW: Vec2[] = [
      [0, 0],
      [0, 20],
      [20, 20],
      [20, 0],
      [0, 0],
    ];
    const n = normalizeRing(closedCW);
    expect(n).toHaveLength(4);
    expect(ringSignedArea(n)).toBeGreaterThan(0);
  });
});

describe("facadePoint", () => {
  it("finds the middle of the east facade", () => {
    const fp = facadePoint(square, "E", 0.5);
    expect(fp).not.toBeNull();
    expect(fp!.point[0]).toBeCloseTo(20);
    expect(fp!.point[1]).toBeCloseTo(10);
    expect(fp!.normal[0]).toBeCloseTo(1);
    expect(fp!.normal[1]).toBeCloseTo(0);
  });

  it("walks u along the south facade", () => {
    const fp = facadePoint(square, "S", 0.25);
    expect(fp!.point[0]).toBeCloseTo(5);
    expect(fp!.point[1]).toBeCloseTo(0);
  });
});

describe("placeUnit", () => {
  const geometry = BuildingGeometrySchema.parse({
    floors: 30,
    floorHeightM: 3,
    groundFloorOffsetM: 6,
  });
  const mapping = UnitMappingSchema.parse({
    scheme: "floor-prefix",
    stacks: { "05": { facing: "E", u: 0.5 } },
  });

  it("places a mapped stack fully: marker, slab, view camera", () => {
    const p = placeUnit("2305", mapping, geometry, square);
    expect(p.confidence).toBe("stack");
    expect(p.floor).toBe(23);
    // z: 6 + 22*3 = 72 .. 75
    expect(p.floorSlab).toEqual({ zMin: 72, zMax: 75 });
    // marker inset 2m from east facade midpoint, mid-floor height
    expect(p.marker![0]).toBeCloseTo(18);
    expect(p.marker![1]).toBeCloseTo(10);
    expect(p.marker![2]).toBeCloseTo(73.5);
    // view camera just outside the facade at eye height, looking east
    expect(p.viewCamera!.position[0]).toBeCloseTo(20.5);
    expect(p.viewCamera!.position[2]).toBeCloseTo(73.5, 0);
    expect(p.viewCamera!.dir).toEqual([1, 0, 0]);
  });

  it("degrades to floor-only for unmapped stacks", () => {
    const p = placeUnit("2399", mapping, geometry, square);
    expect(p.confidence).toBe("floor-only");
    expect(p.floorSlab).not.toBeNull();
    expect(p.marker).toBeNull();
    expect(p.viewCamera).toBeNull();
  });

  it("rejects floors above the building", () => {
    const p = placeUnit("9905", mapping, geometry, square);
    expect(p.confidence).toBe("none");
    expect(p.floorSlab).toBeNull();
  });

  it("handles missing mapping/unit", () => {
    expect(placeUnit("2305", undefined, geometry, square).confidence).toBe("none");
    expect(placeUnit(null, mapping, geometry, square).confidence).toBe("none");
  });

  it("makeBoxRing produces a CCW ring of the right size", () => {
    const ring = makeBoxRing(100, 50, 40, 20);
    expect(ringSignedArea(ring)).toBe(800);
    expect(ringCentroid(ring)).toEqual([100, 50]);
  });

  it("places exactly when a sidecar position is provided", () => {
    const p = placeUnit("2305", mapping, geometry, square, { x: 17, y: 4 });
    expect(p.confidence).toBe("exact");
    expect(p.marker).toEqual([17, 4, 73.5]);
    expect(p.floorSlab).toEqual({ zMin: 72, zMax: 75 });
    // Nearest facade to (17,4) is the east edge (3 m) → camera looks east.
    expect(p.viewCamera!.dir[0]).toBeCloseTo(1);
  });
});

describe("facingFromNormal / facadeParam", () => {
  it("snaps normals to compass facings", () => {
    expect(facingFromNormal([0, 1])).toBe("N");
    expect(facingFromNormal([1, 0.05])).toBe("E");
    expect(facingFromNormal([0.7, -0.7])).toBe("SE");
  });

  it("round-trips facadePoint through facadeParam", () => {
    const fp = facadePoint(square, "E", 0.25)!;
    const back = facadeParam(square, fp.point)!;
    expect(back.facing).toBe("E");
    expect(back.u).toBeCloseTo(0.25, 5);
    expect(back.normal[0]).toBeCloseTo(1);
  });
});

describe("placeStackBand / orientedBoxRing", () => {
  const geometry = BuildingGeometrySchema.parse({
    floors: 10,
    floorHeightM: 3,
    groundFloorOffsetM: 4,
  });

  it("builds a ground-to-roof band on the mapped facade", () => {
    const mapping = UnitMappingSchema.parse({
      stacks: { "03": { facing: "S", u: 0.25 } },
    });
    const band = placeStackBand("03", mapping, geometry, square)!;
    expect(band.facing).toBe("S");
    expect(band.point[0]).toBeCloseTo(5);
    expect(band.point[1]).toBeCloseTo(0);
    expect(band.zMin).toBe(4);
    expect(band.zMax).toBe(34);
  });

  it("returns null with no mapping or facade", () => {
    expect(placeStackBand("99", UnitMappingSchema.parse({}), geometry, square)).toBeNull();
  });

  it("orientedBoxRing is CCW and centered at the point", () => {
    const ring = orientedBoxRing([10, 0], [0, -1], 8, 4);
    expect(ringSignedArea(ring)).toBeCloseTo(32);
    const [cx, cy] = ringCentroid(ring);
    expect(cx).toBeCloseTo(10);
    expect(cy).toBeCloseTo(0);
  });
});
