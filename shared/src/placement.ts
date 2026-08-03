import { parseUnitNumber } from "./parse";
import type { BuildingGeometry, Facing, UnitMapping } from "./types";

/**
 * All coordinates here are scene-local meters: x east, y north, z up.
 * (The web layer converts to three.js's y-up when rendering.)
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface UnitPlacement {
  floor: number | null;
  confidence: "exact" | "stack" | "floor-only" | "none";
  /** Point just inside the facade, mid-floor height. */
  marker: Vec3 | null;
  /** Vertical extent of the unit's floor. */
  floorSlab: { zMin: number; zMax: number } | null;
  /** Camera on the facade at eye height, looking along the outward normal. */
  viewCamera: { position: Vec3; dir: Vec3 } | null;
}

// ---------------------------------------------------------------------------
// Polygon helpers
// ---------------------------------------------------------------------------

/** Signed area; positive = counter-clockwise. */
export function ringSignedArea(ring: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** Drop a duplicated closing point and force counter-clockwise winding. */
export function normalizeRing(ring: Vec2[]): Vec2[] {
  let r = ring;
  const first = r[0]!;
  const last = r[r.length - 1]!;
  if (r.length > 1 && first[0] === last[0] && first[1] === last[1]) {
    r = r.slice(0, -1);
  }
  return ringSignedArea(r) < 0 ? [...r].reverse() : r;
}

export function ringCentroid(ring: Vec2[]): Vec2 {
  const r = normalizeRing(ring);
  const area = ringSignedArea(r);
  if (Math.abs(area) < 1e-9) {
    // Degenerate: fall back to vertex average.
    let sx = 0;
    let sy = 0;
    for (const p of r) {
      sx += p[0];
      sy += p[1];
    }
    return [sx / r.length, sy / r.length];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    const cross = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

/** Axis-aligned box ring (CCW) centered at [cx, cy]. */
export function makeBoxRing(cx: number, cy: number, width: number, depth: number): Vec2[] {
  const hw = width / 2;
  const hd = depth / 2;
  return [
    [cx - hw, cy - hd],
    [cx + hw, cy - hd],
    [cx + hw, cy + hd],
    [cx - hw, cy + hd],
  ];
}

const SQ = Math.SQRT1_2;
export const FACING_VECTORS: Record<Facing, Vec2> = {
  N: [0, 1],
  NE: [SQ, SQ],
  E: [1, 0],
  SE: [SQ, -SQ],
  S: [0, -1],
  SW: [-SQ, -SQ],
  W: [-1, 0],
  NW: [-SQ, SQ],
};

const FACING_ORDER: Facing[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Snap a direction vector to the nearest 8-way compass facing. */
export function facingFromNormal(n: Vec2): Facing {
  // atan2(east, north) = compass bearing; 45° sectors.
  const bearing = ((Math.atan2(n[0], n[1]) * 180) / Math.PI + 360) % 360;
  return FACING_ORDER[Math.round(bearing / 45) % 8]!;
}

/** Compass bearing (0=N, 90=E) of a facing. */
export function facingBearingDeg(facing: Facing): number {
  return FACING_ORDER.indexOf(facing) * 45;
}

/** Axis-aligned-in-local-frame box ring centered at `point`, rotated so its
 * width runs along the facade (perpendicular to `normal`). */
export function orientedBoxRing(point: Vec2, normal: Vec2, width: number, depth: number): Vec2[] {
  const len = Math.hypot(normal[0], normal[1]) || 1;
  const n: Vec2 = [normal[0] / len, normal[1] / len];
  const t: Vec2 = [-n[1], n[0]]; // tangent along the facade
  const hw = width / 2;
  const hd = depth / 2;
  const corner = (a: number, b: number): Vec2 => [
    point[0] + t[0] * a + n[0] * b,
    point[1] + t[1] * a + n[1] * b,
  ];
  return normalizeRing([corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)]);
}

interface Edge {
  a: Vec2;
  b: Vec2;
  length: number;
  /** Unit outward normal (ring must be CCW). */
  normal: Vec2;
}

function ringEdges(ring: Vec2[]): Edge[] {
  const r = normalizeRing(ring);
  const edges: Edge[] = [];
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    // For CCW winding the interior lies left of travel, so outward is right.
    // `|| 0` normalizes -0 to 0.
    edges.push({ a, b, length, normal: [dy / length || 0, -dx / length || 0] });
  }
  return edges;
}

const COS_45 = Math.cos((45.5 * Math.PI) / 180);

export interface FacadePoint {
  point: Vec2;
  normal: Vec2;
}

/**
 * Point at fraction u (0..1) along the facade of the ring facing `facing`
 * (edges whose outward normal is within ~45° of that bearing), walking edges
 * in ring order. Null when no edge faces that way.
 */
export function facadePoint(ring: Vec2[], facing: Facing, u: number): FacadePoint | null {
  const target = FACING_VECTORS[facing];
  const edges = ringEdges(ring).filter(
    (e) => e.normal[0] * target[0] + e.normal[1] * target[1] >= COS_45,
  );
  if (edges.length === 0) return null;
  const total = edges.reduce((s, e) => s + e.length, 0);
  let walk = Math.min(Math.max(u, 0), 1) * total;
  for (const e of edges) {
    if (walk <= e.length || e === edges[edges.length - 1]) {
      const t = Math.min(walk / e.length, 1);
      return {
        point: [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t],
        normal: e.normal,
      };
    }
    walk -= e.length;
  }
  return null;
}

/**
 * Inverse of facadePoint: for a point at/near the ring, find which facade it
 * sits on and the fraction u along that facade. Used by tune mode and exact
 * placement.
 */
export function facadeParam(
  ring: Vec2[],
  point: Vec2,
): { facing: Facing; u: number; normal: Vec2; point: Vec2 } | null {
  const edges = ringEdges(ring);
  if (edges.length === 0) return null;

  // Nearest edge by perpendicular distance to the segment.
  let best: { edge: Edge; t: number; dist: number } | null = null;
  for (const e of edges) {
    const dx = e.b[0] - e.a[0];
    const dy = e.b[1] - e.a[1];
    const len2 = dx * dx + dy * dy;
    const t = Math.max(
      0,
      Math.min(1, ((point[0] - e.a[0]) * dx + (point[1] - e.a[1]) * dy) / len2),
    );
    const px = e.a[0] + dx * t;
    const py = e.a[1] + dy * t;
    const dist = Math.hypot(point[0] - px, point[1] - py);
    if (!best || dist < best.dist) best = { edge: e, t, dist };
  }
  if (!best) return null;

  const facing = facingFromNormal(best.edge.normal);
  const target = FACING_VECTORS[facing];
  const facadeEdges = edges.filter(
    (e) => e.normal[0] * target[0] + e.normal[1] * target[1] >= COS_45,
  );
  let walked = 0;
  let total = 0;
  for (const e of facadeEdges) {
    if (e === best.edge) walked = total + best.t * e.length;
    total += e.length;
  }
  if (total === 0) return null;
  const onEdge: Vec2 = [
    best.edge.a[0] + (best.edge.b[0] - best.edge.a[0]) * best.t,
    best.edge.a[1] + (best.edge.b[1] - best.edge.a[1]) * best.t,
  ];
  return { facing, u: walked / total, normal: best.edge.normal, point: onEdge };
}

/**
 * Full-height band for a stack (used when floorplans are stacks and no floor
 * is known): position on the facade plus ground→roof vertical extent.
 */
export function placeStackBand(
  stack: string,
  mapping: UnitMapping,
  geometry: BuildingGeometry,
  ring: Vec2[],
): { facing: Facing; point: Vec2; normal: Vec2; zMin: number; zMax: number } | null {
  const info = mapping.stacks[stack];
  const facing = info?.facing ?? mapping.defaultFacing;
  if (!facing) return null;
  const fp = facadePoint(ring, facing, info?.u ?? 0.5);
  if (!fp) return null;
  return {
    facing,
    point: fp.point,
    normal: fp.normal,
    zMin: geometry.groundFloorOffsetM,
    zMax: geometry.groundFloorOffsetM + geometry.floors * geometry.floorHeightM,
  };
}

// ---------------------------------------------------------------------------
// The placement heuristic
// ---------------------------------------------------------------------------

const MARKER_INSET_M = 2;
const EYE_HEIGHT_M = 1.5;

export function placeUnit(
  unitNumber: string | null,
  mapping: UnitMapping | undefined,
  geometry: BuildingGeometry,
  /** Building footprint in scene-local meters; null if unknown. */
  ring: Vec2[] | null,
  /** Exact unit position (scene-local meters) from a floorplate sidecar. */
  exact?: { x: number; y: number },
): UnitPlacement {
  const none: UnitPlacement = {
    floor: null,
    confidence: "none",
    marker: null,
    floorSlab: null,
    viewCamera: null,
  };
  if (!mapping) return none;

  const { floor, stack } = parseUnitNumber(unitNumber, mapping);
  if (floor === null || floor < 1 || floor > geometry.floors) return none;

  const zMin = geometry.groundFloorOffsetM + (floor - 1) * geometry.floorHeightM;
  const zMax = zMin + geometry.floorHeightM;
  const floorSlab = { zMin, zMax };
  const midZExact = (zMin + zMax) / 2;

  // Exact placement from a floorplate map beats every heuristic.
  if (exact && ring) {
    const fp = facadeParam(ring, [exact.x, exact.y]);
    const viewCamera = fp
      ? {
          position: [
            fp.point[0] + fp.normal[0] * 0.5,
            fp.point[1] + fp.normal[1] * 0.5,
            zMin + EYE_HEIGHT_M,
          ] as Vec3,
          dir: [fp.normal[0], fp.normal[1], 0] as Vec3,
        }
      : null;
    return {
      floor,
      confidence: "exact",
      marker: [exact.x, exact.y, midZExact],
      floorSlab,
      viewCamera,
    };
  }

  const stackInfo = stack ? mapping.stacks[stack] : undefined;
  const facing = stackInfo?.facing ?? mapping.defaultFacing;
  const u = stackInfo?.u ?? 0.5;

  if (!ring || !facing) {
    return { floor, confidence: "floor-only", marker: null, floorSlab, viewCamera: null };
  }

  const fp = facadePoint(ring, facing, u);
  if (!fp) {
    return { floor, confidence: "floor-only", marker: null, floorSlab, viewCamera: null };
  }

  const midZ = (zMin + zMax) / 2;
  const marker: Vec3 = [
    fp.point[0] - fp.normal[0] * MARKER_INSET_M,
    fp.point[1] - fp.normal[1] * MARKER_INSET_M,
    midZ,
  ];
  const viewCamera = {
    position: [
      fp.point[0] + fp.normal[0] * 0.5,
      fp.point[1] + fp.normal[1] * 0.5,
      zMin + EYE_HEIGHT_M,
    ] as Vec3,
    dir: [fp.normal[0], fp.normal[1], 0] as Vec3,
  };

  // Only claim full confidence when the stack was explicitly mapped.
  const confidence = stackInfo ? "stack" : "floor-only";
  return {
    floor,
    confidence,
    marker: stackInfo ? marker : null,
    floorSlab,
    viewCamera: stackInfo ? viewCamera : null,
  };
}
