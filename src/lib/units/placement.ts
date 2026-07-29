import {
  bearingToVec,
  centroid as ringCentroid,
  compassPoint,
  ensureCCW,
  normalizeDeg,
  polygonArea,
  type CompassPoint,
  type Vec2,
} from "../geo";
import type { FloorPlate, Point, Stack } from "../floorplan/schema";
import {
  floorSlabHeight,
  segmentForFloor,
  type BuildingSpec,
} from "../massing/spec";

/**
 * Resolve a listing into its physical place in the building.
 *
 * This is the answer to the actual question — for unit 3208, which floor is it
 * on, which way does it face, how big is it, and how high off the ground. The
 * 3D model exists to show this; the numbers here are the product.
 */

const SQFT_PER_SQM = 10.7639;
/** Eye height above the slab, metres. */
const EYE_HEIGHT_M = 1.6;
/** How close a unit edge must be to the plate boundary to count as exterior. */
const EXTERIOR_TOLERANCE_M = 0.75;

export interface Exposure {
  /** Compass bearing the wall faces, degrees from north. */
  bearingDeg: number;
  /** N/NNE/NE/… */
  point: CompassPoint;
  /** Length of exterior wall on this bearing, metres. */
  lengthM: number;
}

export interface UnitPlacement {
  unitCode: string;
  floor: number;
  line: string;

  /** Height of the unit's floor slab above ground, metres. */
  slabHeightM: number;
  /** Camera height for the view simulation. */
  eyeHeightM: number;
  /** Floors above this one in the building. */
  floorsAbove: number;

  /** Unit footprint in the building's world frame (heading applied), metres. */
  polygon: Vec2[];
  /** Centroid of that footprint. */
  center: Vec2;

  /** Dominant window direction. */
  facingDeg: number;
  facing: CompassPoint;
  /** Every exterior wall, longest first. Corner units have two or more. */
  exposures: Exposure[];
  /** Short label like "S" or "SE corner (S + E)". */
  exposureLabel: string;
  isCorner: boolean;

  areaSqm: number;
  areaSqft: number;

  /** Fraction of the way up the building, 0 at the base and 1 at the top. */
  heightFraction: number;
}

export interface PlacementOptions {
  /** Advertised square footage, preferred over the derived polygon area. */
  sqft?: number | null;
}

/**
 * Place a single unit. Returns null when the building has no stack matching
 * the unit's line — which happens when a listing appears for a line that has
 * never been seen before and the plate hasn't been re-inferred yet.
 */
export function resolveUnitPlacement(
  spec: BuildingSpec,
  plate: FloorPlate,
  unit: { unitCode: string; floor: number; line: string },
  opts: PlacementOptions = {},
): UnitPlacement | null {
  const stack = plate.stacks.find((s) => s.line === unit.line);
  if (!stack) return null;

  const segment = segmentForFloor(spec, unit.floor);
  // Setbacks shrink the plate, so a unit's footprint at floor 40 is not the
  // same polygon as at floor 5.
  const local = applyInset(stack.polygon, plate.outline, segment.inset);
  const rotation = spec.headingDeg + segment.rotationDeg;
  const polygon = ensureCCW(local.map((p) => rotate(p, rotation)));

  const outline = ensureCCW(
    applyInset(plate.outline, plate.outline, segment.inset).map((p) =>
      rotate(p, rotation),
    ),
  );

  const exposures = computeExposures(polygon, outline, stack);
  const primary = exposures[0];

  const slabHeightM = floorSlabHeight(spec, unit.floor);
  const topSlab = floorSlabHeight(spec, spec.topFloor);
  const areaSqm = polygonArea(polygon);

  return {
    unitCode: unit.unitCode,
    floor: unit.floor,
    line: unit.line,
    slabHeightM,
    eyeHeightM: slabHeightM + EYE_HEIGHT_M,
    floorsAbove: Math.max(0, spec.topFloor - unit.floor),
    polygon,
    center: ringCentroid(polygon),
    facingDeg: primary?.bearingDeg ?? 0,
    facing: primary?.point ?? "N",
    exposures,
    exposureLabel: describeExposure(exposures),
    isCorner: exposures.length >= 2,
    areaSqm: opts.sqft ? opts.sqft / SQFT_PER_SQM : areaSqm,
    areaSqft: opts.sqft ?? Math.round(areaSqm * SQFT_PER_SQM),
    heightFraction: topSlab > 0 ? Math.min(1, slabHeightM / topSlab) : 0,
  };
}

/**
 * Which walls of the unit are on the building's exterior, and where they face.
 *
 * An edge counts as exterior when both endpoints sit on the plate boundary.
 * Bearings are then bucketed so that the two halves of a bay window read as
 * one exposure rather than two.
 */
function computeExposures(
  polygon: Vec2[],
  outline: Vec2[],
  stack: Stack,
): Exposure[] {
  const buckets = new Map<number, { weightedSin: number; weightedCos: number; length: number }>();

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];

    const isExterior = stack.exteriorEdges
      ? stack.exteriorEdges.includes(i)
      : onBoundary(a, outline) && onBoundary(b, outline);
    if (!isExterior) continue;

    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 0.4) continue;

    const bearing = outwardBearing(a, b);
    // 45° buckets keep N/NE/E/… distinct while merging near-parallel walls.
    const bucket = Math.round(bearing / 45) % 8;
    const entry = buckets.get(bucket) ?? { weightedSin: 0, weightedCos: 0, length: 0 };
    const rad = (bearing * Math.PI) / 180;
    entry.weightedSin += Math.sin(rad) * length;
    entry.weightedCos += Math.cos(rad) * length;
    entry.length += length;
    buckets.set(bucket, entry);
  }

  const exposures: Exposure[] = [...buckets.values()].map((e) => {
    const bearing = normalizeDeg((Math.atan2(e.weightedSin, e.weightedCos) * 180) / Math.PI);
    return { bearingDeg: bearing, point: compassPoint(bearing), lengthM: e.length };
  });

  // Drop slivers: a 0.6 m return wall is not an exposure a renter cares about.
  const longest = Math.max(...exposures.map((e) => e.lengthM), 0);
  return exposures
    .filter((e) => e.lengthM >= Math.max(1.5, longest * 0.25))
    .sort((a, b) => b.lengthM - a.lengthM);
}

/** Outward normal bearing of edge a→b on a counter-clockwise ring. */
function outwardBearing(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return normalizeDeg((Math.atan2(dy, -dx) * 180) / Math.PI);
}

function onBoundary(p: Vec2, ring: Vec2[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    if (distanceToSegment(p, ring[i], ring[(i + 1) % ring.length]) <= EXTERIOR_TOLERANCE_M) {
      return true;
    }
  }
  return false;
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function describeExposure(exposures: Exposure[]): string {
  if (exposures.length === 0) return "interior";
  if (exposures.length === 1) return `${exposures[0].point}-facing`;
  const points = exposures.map((e) => e.point);
  return `${points.join(" + ")} corner`;
}

/**
 * Shrink a polygon toward the plate centre by the segment's setback. Applied to
 * the unit and the outline together so exposure detection stays consistent.
 */
function applyInset(polygon: Point[], outline: Point[], inset: number): Vec2[] {
  if (inset <= 0) return polygon.map((p) => ({ x: p.x, y: p.y }));
  const c = ringCentroid(outline.map((p) => ({ x: p.x, y: p.y })));
  // Scale about the plate centre by the ratio that removes `inset` metres from
  // the plate's half-width — uniform scaling keeps every unit's share intact.
  const halfSpan = Math.max(
    ...outline.map((p) => Math.max(Math.abs(p.x - c.x), Math.abs(p.y - c.y))),
  );
  const k = halfSpan > inset ? (halfSpan - inset) / halfSpan : 0.5;
  return polygon.map((p) => ({
    x: c.x + (p.x - c.x) * k,
    y: c.y + (p.y - c.y) * k,
  }));
}

function rotate(p: Point, deg: number): Vec2 {
  if (!deg) return { x: p.x, y: p.y };
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // Clockwise rotation, since headings are measured clockwise from north.
  return { x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos };
}

/**
 * A compact summary of how good the outlook is, from height and exposure
 * alone. Deliberately not a simulation — it is the rule of thumb a broker
 * would give you, made explicit.
 */
export function describeOutlook(placement: UnitPlacement): string {
  const parts: string[] = [];
  const storeys = placement.floor;

  if (placement.slabHeightM >= 120) parts.push("above most of the surrounding rooflines");
  else if (placement.slabHeightM >= 60) parts.push("clear of low-rise neighbours");
  else if (placement.slabHeightM >= 25) parts.push("mid-level, likely facing nearby buildings");
  else parts.push("low floor, street-level outlook");

  // East is the lake in essentially all of Chicago's north-side and Loop stock.
  const facesEast = placement.exposures.some((e) => /E/.test(e.point) && !/W/.test(e.point));
  const facesWest = placement.exposures.some((e) => /W/.test(e.point));
  if (facesEast && placement.slabHeightM >= 40) parts.push("lake side");
  if (facesWest) parts.push("sunset side");
  if (placement.isCorner) parts.push("corner exposure on two sides");

  return `Floor ${storeys}, ${placement.exposureLabel} — ${parts.join(", ")}.`;
}

/** Direction the view camera should look, as a unit vector in world metres. */
export function viewDirection(placement: UnitPlacement): Vec2 {
  return bearingToVec(placement.facingDeg);
}
