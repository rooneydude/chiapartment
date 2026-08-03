import { describe, expect, it } from "vitest";
import {
  facadePoint,
  makeBoxRing,
  normalizeRing,
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
});
