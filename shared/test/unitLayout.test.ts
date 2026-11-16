import { describe, expect, it } from "vitest";
import { makeBoxRing, type Vec2 } from "../src/placement";
import { BuildingGeometrySchema, UnitMappingSchema } from "../src/types";
import {
  BED_WIDTH_M,
  layoutListings,
  nearestFacade,
  ringFacades,
  type LayoutListing,
  type UnitMark,
} from "../src/unitLayout";

// A 40 m × 40 m tower centred on the origin: faces at x = ±20, y = ±20.
const ring = makeBoxRing(0, 0, 40, 40);
const geometry = BuildingGeometrySchema.parse({ floors: 10, floorHeightM: 3, groundFloorOffsetM: 6 });
const mapping = UnitMappingSchema.parse({
  stackDigits: 2,
  stackFromPlanRegex: "Unit\\s*(\\d+)",
  stacks: {
    "01": { facing: "N", u: 0.5 },
    "02": { facing: "E", u: 0.5 },
    "03": { facing: "N", u: 0.5 },
    "04": { facing: "N", u: 0.5 },
  },
});

const unit = (unitNumber: string | null, beds: number | null = 1, floorplanName = "A1"): LayoutListing => ({
  unitNumber,
  floorplanName,
  beds,
});
const layout = (listings: LayoutListing[], exactFor?: (u: string) => Vec2 | undefined): UnitMark[] =>
  layoutListings({ listings, mapping, geometry, ring, ...(exactFor ? { exactFor } : {}) });

describe("layoutListings", () => {
  it("puts a unit on its floor and on the face its stack is mapped to (approximate)", () => {
    const [m] = layout([unit("0501", 0)]);
    expect(m).toMatchObject({
      key: "u:0501",
      kind: "plate",
      confidence: "stack",
      floor: 5,
      zMin: 18, // 6 m podium + four 3 m floors below
      zMax: 21,
      facing: "N",
      widthM: BED_WIDTH_M[0],
    });
    expect(m!.center![0]).toBeCloseTo(0);
    expect(m!.center![1]).toBeCloseTo(20);
    expect(m!.normal![1]).toBeCloseTo(1);
    // The tangent runs along the facade.
    expect(Math.abs(m!.tangent![0])).toBeCloseTo(1);
    expect(m!.tangent![1]).toBeCloseTo(0);
  });

  it("claims only a floor when the stack is not mapped to a side", () => {
    const [m] = layout([unit("0709")]);
    expect(m).toMatchObject({ kind: "belt", confidence: "floor-only", floor: 7, facing: null, center: null });
    expect(m!.note).toBe("stack 09 is not mapped to a side of the building");
    expect(m!.beltSlot).toEqual([0, 1]);
  });

  it("shares a floor's band between several floor-only listings", () => {
    const marks = layout([unit("0709"), unit("0710"), unit("0811")]);
    expect(marks.map((m) => m.beltSlot)).toEqual([
      [0, 2],
      [1, 2],
      [0, 1],
    ]);
  });

  it("draws a floor-plan stack as a riser up its face, floor unknown", () => {
    const [m] = layout([unit(null, 0, "Large Studio - Unit 02")]);
    expect(m).toMatchObject({
      key: "fp:0:Large Studio - Unit 02",
      kind: "riser",
      confidence: "stack",
      floor: null,
      zMin: 6,
      zMax: 36,
      facing: "E",
    });
    expect(m!.center![0]).toBeCloseTo(20);
  });

  it("never invents a position: unknown floors and unmapped plans stay unplaced, with the reason", () => {
    const marks = layout([unit("1501"), unit(null, 2, "Penthouse"), unit("PH")]);
    expect(marks.map((m) => [m.kind, m.confidence])).toEqual([
      ["unplaced", "none"],
      ["unplaced", "none"],
      ["unplaced", "none"],
    ]);
    expect(marks[0]!.note).toBe("floor 15 is outside this 10-floor model");
    expect(marks[1]!.note).toMatch(/publishes no unit number or floor/);
    expect(marks.every((m) => m.center === null && m.zMin === null)).toBe(true);
    // Without a unit-number scheme nothing can be placed at all.
    const bare = layoutListings({ listings: [unit("0501")], mapping: undefined, geometry, ring });
    expect(bare[0]).toMatchObject({ kind: "unplaced", note: "no unit-number scheme is configured for this building" });
  });

  it("uses an exact floor-plan position when there is one, on the nearest face", () => {
    // 3 m inside the east face, a little north of centre.
    const [m] = layout([unit("0609", 2)], () => [17, 5]);
    expect(m).toMatchObject({ kind: "plate", confidence: "exact", floor: 6, facing: "E" });
    expect(m!.center![0]).toBeCloseTo(20);
    expect(m!.center![1]).toBeCloseTo(5);
    expect(m!.setbackM).toBeCloseTo(3);
  });

  it("does not claim a side for a floor-plan point deep inside a large outline", () => {
    const big = makeBoxRing(0, 0, 100, 100);
    const [m] = layoutListings({
      listings: [unit("0609")],
      mapping,
      geometry,
      ring: big,
      exactFor: () => [0, 0],
    });
    expect(m).toMatchObject({ kind: "belt", confidence: "floor-only", floor: 6 });
    expect(m!.note).toMatch(/50 m inside the building outline/);
  });

  it("keeps a key for rows whose bed count the site does not publish", () => {
    const [m] = layout([unit(null, null, "Townhome")]);
    expect(m!.key).toBe("fp:null:Townhome");
    expect(m!.widthM).toBe(BED_WIDTH_M[1]);
  });
});

describe("layoutListings: marks that would overlap", () => {
  const span = (m: UnitMark): [number, number] => [m.center![0] - m.widthM / 2, m.center![0] + m.widthM / 2];

  it("spreads approximate marks that share a floor and a spot, inside the facade", () => {
    // Stacks 01, 03 and 04 are all mapped to the middle of the north face.
    const marks = layout([unit("0501", 2), unit("0503", 2), unit("0504", 2)]);
    const spans = marks.map(span).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1] + 1 - 1e-6); // 1 m gap
    }
    for (const [lo, hi] of spans) {
      expect(lo).toBeGreaterThanOrEqual(-20);
      expect(hi).toBeLessThanOrEqual(20);
    }
    // Still on the north face, on their own floor.
    expect(marks.every((m) => m.facing === "N" && Math.abs(m.center![1] - 20) < 1e-6 && m.floor === 5)).toBe(true);
  });

  it("does not disturb marks on different floors", () => {
    const marks = layout([unit("0501", 2), unit("0603", 2)]);
    expect(marks.every((m) => Math.abs(m.center![0]) < 1e-6)).toBe(true);
    expect(marks.every((m) => m.widthM === BED_WIDTH_M[2])).toBe(true);
  });

  it("never moves an exact mark; the approximate one gives way", () => {
    const marks = layout([unit("0501", 1), unit("0503", 1)], (u) => (u === "0501" ? [0, 18] : undefined));
    const exact = marks.find((m) => m.confidence === "exact")!;
    const approx = marks.find((m) => m.confidence === "stack")!;
    expect(exact.center![0]).toBeCloseTo(0);
    expect(Math.abs(approx.center![0])).toBeGreaterThanOrEqual(BED_WIDTH_M[1] + 1 - 1e-6);
  });

  it("keeps an exact mark on its face when the unit sits at the very end of it", () => {
    // A corner unit: 1 m inside the north face, 2.5 m from its east end. Centred on
    // its floor-plan position the 7 m glyph would stick 1 m out past the corner.
    const [corner] = layout([unit("0501", 1)], () => [17.5, 19]);
    expect(corner).toMatchObject({ kind: "plate", confidence: "exact", facing: "N", widthM: BED_WIDTH_M[1] });
    expect(corner!.center![1]).toBeCloseTo(20);
    expect(span(corner!)[1]).toBeLessThanOrEqual(20);
    // ...flush with that end, not pushed further along the face than it has to be.
    expect(span(corner!)[1]).toBeGreaterThan(19);

    // The same at the west end of the face; a mark that fits where it is does not move.
    const [west, mid] = layout([unit("0601", 1), unit("0701", 1)], (u) => (u === "0601" ? [-18, 19] : [11, 18]));
    expect(west!.facing).toBe("N");
    expect(span(west!)[0]).toBeGreaterThanOrEqual(-20);
    expect(span(west!)[0]).toBeLessThan(-19);
    expect(mid!.center![0]).toBeCloseTo(11);
    expect(mid!.widthM).toBe(BED_WIDTH_M[1]);
  });

  it("shrinks marks rather than letting them leave a facade that is too short", () => {
    // A slim 12 m face cannot hold four 10 m marks.
    const slim = makeBoxRing(0, 0, 12, 40);
    const marks = layoutListings({
      listings: [unit("0501", 2), unit("0503", 2), unit("0504", 2)],
      mapping,
      geometry,
      ring: slim,
    });
    for (const m of marks) {
      expect(m.widthM).toBeGreaterThanOrEqual(3);
      expect(m.widthM).toBeLessThan(BED_WIDTH_M[2]);
      expect(m.center![0] - m.widthM / 2).toBeGreaterThanOrEqual(-6 - 1e-6);
      expect(m.center![0] + m.widthM / 2).toBeLessThanOrEqual(6 + 1e-6);
    }
  });
});

describe("facade helpers", () => {
  // A 40 × 40 box with a 3 m notch cut into its north-east corner.
  const notched: Vec2[] = [
    [-20, -20],
    [20, -20],
    [20, 17],
    [17, 17],
    [17, 20],
    [-20, 20],
  ];

  it("measures real facades and ignores notches", () => {
    const facades = Object.fromEntries(ringFacades(notched).map((f) => [f.facing, f.lengthM]));
    expect(facades).toEqual({ S: 40, E: 37, N: 37, W: 40 });
  });

  it("attributes a point to the nearest real facade, not to a notch edge", () => {
    // Right at the notch: the 3 m edges are closer, but they are not facades.
    const hit = nearestFacade(notched, [18, 18])!;
    expect(["N", "E"]).toContain(hit.facing);
    expect(hit.edgeLengthM).toBe(37);
    expect(nearestFacade([[0, 0], [2, 0], [2, 2], [0, 2]], [1, 1])).toBeNull();
  });
});
