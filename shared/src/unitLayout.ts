import { parseUnitNumber, stackFromPlan } from "./parse";
import {
  facadePoint,
  facingFromNormal,
  normalizeRing,
  type UnitPlacement,
  type Vec2,
} from "./placement";
import type { BuildingGeometry, Facing, UnitMapping } from "./types";

/**
 * Where every listed unit goes on a tower, for the 3D scene — and how sure
 * we are of it. Positions stay honest; a listing gets one of four marks:
 *
 *   plate    one floor on one face — exact (from a unit map) or approximate
 *            (from the building's stack table);
 *   belt     the floor is known but the side is not: a band around that floor;
 *   riser    the stack is known but the floor is not (Stead 220 lists
 *            floor-plan stacks, not apartments): a strip up one face;
 *   unplaced nothing to go on — the listing is counted, never drawn somewhere
 *            invented.
 *
 * Pure plan geometry in metres (x east, y north); no three.js.
 */

/** Mark width by size bucket (studio, 1, 2, 3+ beds): a glyph, not real frontage. */
export const BED_WIDTH_M = [5, 7, 10, 13] as const;
/** Footprint edges shorter than this are notches, not facades. */
export const MIN_FACADE_EDGE_M = 6;
/**
 * A unit-map point further than this inside the drawn outline cannot be
 * attributed to a face (the outline is a simplification of the real plan).
 */
export const EXACT_MAX_SETBACK_M = 20;
const RISER_WIDTH_M = 3;
const MIN_GAP_M = 1;
const MIN_WIDTH_M = 3;

export type MarkKind = "plate" | "belt" | "riser" | "unplaced";

/** The minimum a listing needs to be placed (units and also-listed rows alike). */
export interface LayoutListing {
  unitNumber: string | null;
  floorplanName: string;
  /** null when the site publishes no bed count. */
  beds: number | null;
}

export interface UnitMark {
  /** Same identity as `listingKey` ("u:<unit>" or "fp:<beds>:<plan>"). */
  key: string;
  unitNumber: string | null;
  kind: MarkKind;
  confidence: UnitPlacement["confidence"];
  floor: number | null;
  /** Vertical extent in metres above ground. */
  zMin: number | null;
  zMax: number | null;
  facing: Facing | null;
  /** Unit outward normal of the face the mark sits on. */
  normal: Vec2 | null;
  /** Mark centre on the facade line. */
  center: Vec2 | null;
  /** Unit vector along the facade. */
  tangent: Vec2 | null;
  widthM: number;
  /** exact only: how far inside the drawn face the unit-map point sits. */
  setbackM?: number;
  /** belt only: [index, count] among the floor-only listings sharing the floor. */
  beltSlot?: [number, number];
  /** Why the listing is not on a face — for tooltips and the legend. */
  note?: string;
}

interface Edge {
  a: Vec2;
  b: Vec2;
  length: number;
  /** Unit outward normal (ring is CCW). */
  normal: Vec2;
}

function edgesOf(ring: Vec2[]): Edge[] {
  const r = normalizeRing(ring);
  const out: Edge[] = [];
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    // `|| 0` normalizes -0 to 0.
    out.push({ a, b, length, normal: [dy / length || 0, -dx / length || 0] });
  }
  return out;
}

/** Closest point of an edge to `p`, as distance along the edge and distance from it. */
function projectOnEdge(e: Edge, p: Vec2): { along: number; point: Vec2; distance: number } {
  const dx = e.b[0] - e.a[0];
  const dy = e.b[1] - e.a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / (e.length * e.length)),
  );
  const point: Vec2 = [e.a[0] + dx * t, e.a[1] + dy * t];
  return { along: t * e.length, point, distance: Math.hypot(p[0] - point[0], p[1] - point[1]) };
}

export interface FacadeHit {
  facing: Facing;
  normal: Vec2;
  /** Nearest point on the facade line. */
  point: Vec2;
  distanceM: number;
  edgeLengthM: number;
}

/** The facade (an edge of at least `minEdgeM`) nearest to a plan point; null if there is none. */
export function nearestFacade(
  ring: Vec2[],
  p: Vec2,
  minEdgeM: number = MIN_FACADE_EDGE_M,
): FacadeHit | null {
  let best: FacadeHit | null = null;
  for (const e of edgesOf(ring)) {
    if (e.length < minEdgeM) continue;
    const hit = projectOnEdge(e, p);
    if (best === null || hit.distance < best.distanceM) {
      best = {
        facing: facingFromNormal(e.normal),
        normal: e.normal,
        point: hit.point,
        distanceM: hit.distance,
        edgeLengthM: e.length,
      };
    }
  }
  return best;
}

/** Total facade length per 8-way facing (edges of at least `minEdgeM`). */
export function ringFacades(
  ring: Vec2[],
  minEdgeM: number = MIN_FACADE_EDGE_M,
): { facing: Facing; lengthM: number }[] {
  const byFacing = new Map<Facing, number>();
  for (const e of edgesOf(ring)) {
    if (e.length < minEdgeM) continue;
    const facing = facingFromNormal(e.normal);
    byFacing.set(facing, (byFacing.get(facing) ?? 0) + e.length);
  }
  return [...byFacing.entries()].map(([facing, lengthM]) => ({ facing, lengthM }));
}

const sizeBucket = (beds: number | null): number => (beds === null ? 1 : Math.min(Math.max(beds, 0), 3));

export function layoutListings(args: {
  listings: readonly LayoutListing[];
  mapping: UnitMapping | undefined;
  geometry: BuildingGeometry;
  /** The tower's footprint in plan metres. */
  ring: Vec2[];
  /** Exact plan position of a unit (from a unit map), when one is known. */
  exactFor?: (unitNumber: string) => Vec2 | undefined;
}): UnitMark[] {
  const { listings, mapping, geometry: g, ring } = args;
  const out: UnitMark[] = [];

  for (const u of listings) {
    const base: UnitMark = {
      key: u.unitNumber ? `u:${u.unitNumber}` : `fp:${u.beds}:${u.floorplanName}`,
      unitNumber: u.unitNumber,
      kind: "unplaced",
      confidence: "none",
      floor: null,
      zMin: null,
      zMax: null,
      facing: null,
      normal: null,
      center: null,
      tangent: null,
      widthM: BED_WIDTH_M[sizeBucket(u.beds)]!,
    };
    if (!mapping) {
      out.push({ ...base, note: "no unit-number scheme is configured for this building" });
      continue;
    }

    const { floor, stack } = parseUnitNumber(u.unitNumber, mapping);
    if (floor === null || floor < 1 || floor > g.floors) {
      // A floor plan that IS a stack (Stead 220): a riser on its mapped face.
      const planStack = !u.unitNumber ? stackFromPlan(u.floorplanName, mapping) : null;
      const info = planStack ? mapping.stacks[planStack] : undefined;
      const fp = info ? facadePoint(ring, info.facing, info.u) : null;
      if (fp) {
        out.push({
          ...base,
          kind: "riser",
          confidence: "stack",
          zMin: g.groundFloorOffsetM,
          zMax: g.groundFloorOffsetM + g.floors * g.floorHeightM,
          facing: facingFromNormal(fp.normal),
          normal: fp.normal,
          center: fp.point,
          tangent: [-fp.normal[1], fp.normal[0]],
          widthM: RISER_WIDTH_M,
        });
      } else {
        out.push({
          ...base,
          note:
            floor === null
              ? "the leasing site publishes no unit number or floor for this listing"
              : `floor ${floor} is outside this ${g.floors}-floor model`,
        });
      }
      continue;
    }

    const zMin = g.groundFloorOffsetM + (floor - 1) * g.floorHeightM;
    const onFloor: UnitMark = { ...base, floor, zMin, zMax: zMin + g.floorHeightM };

    const exact = u.unitNumber ? args.exactFor?.(u.unitNumber) : undefined;
    if (exact) {
      const hit = nearestFacade(ring, exact);
      if (hit && hit.distanceM <= EXACT_MAX_SETBACK_M) {
        out.push({
          ...onFloor,
          kind: "plate",
          confidence: "exact",
          facing: hit.facing,
          normal: hit.normal,
          center: hit.point,
          tangent: [-hit.normal[1], hit.normal[0]],
          setbackM: hit.distanceM,
        });
      } else {
        out.push({
          ...onFloor,
          kind: "belt",
          confidence: "floor-only",
          note: `its floor-plan position is ${hit ? `${hit.distanceM.toFixed(0)} m` : "far"} inside the building outline, so no side is claimed`,
        });
      }
      continue;
    }

    const info = stack ? mapping.stacks[stack] : undefined;
    const fp = info ? facadePoint(ring, info.facing, info.u) : null;
    if (fp) {
      out.push({
        ...onFloor,
        kind: "plate",
        confidence: "stack",
        facing: facingFromNormal(fp.normal),
        normal: fp.normal,
        center: fp.point,
        tangent: [-fp.normal[1], fp.normal[0]],
      });
    } else {
      out.push({
        ...onFloor,
        kind: "belt",
        confidence: "floor-only",
        note: stack
          ? `stack ${stack} is not mapped to a side of the building`
          : "the unit number carries no stack",
      });
    }
  }

  // Floor-only listings sharing a floor split its band between them.
  const beltsByFloor = new Map<number, UnitMark[]>();
  for (const m of out) {
    if (m.kind !== "belt" || m.floor === null) continue;
    beltsByFloor.set(m.floor, [...(beltsByFloor.get(m.floor) ?? []), m]);
  }
  for (const marks of beltsByFloor.values()) {
    marks.forEach((m, i) => {
      m.beltSlot = [i, marks.length];
    });
  }

  declutter(out, edgesOf(ring));
  return out;
}

/**
 * Marks that share a floor and a straight facade run (or risers sharing a
 * face) must not overlap: approximate marks are nudged apart along the
 * facade, exact ones keep their place (see arrangeAlongEdge for the one
 * exception, at a facade's end), and when a facade is simply too short the
 * marks shrink instead.
 */
function declutter(marks: UnitMark[], edges: Edge[]): void {
  const groups = new Map<string, { edge: Edge; marks: UnitMark[] }>();
  for (const m of marks) {
    if ((m.kind !== "plate" && m.kind !== "riser") || !m.normal || !m.center) continue;
    // The edge the centre lies on: same outward normal, nearest — and never a
    // notch when a real facade matches.
    let edgeIndex = -1;
    let best = Infinity;
    edges.forEach((e, i) => {
      if (e.normal[0] * m.normal![0] + e.normal[1] * m.normal![1] < 0.99) return;
      const d = projectOnEdge(e, m.center!).distance + (e.length < MIN_FACADE_EDGE_M ? 1000 : 0);
      if (d < best - 1e-6) {
        best = d;
        edgeIndex = i;
      }
    });
    if (edgeIndex < 0) continue;
    const groupKey = `${m.kind === "riser" ? "riser" : m.floor}:${edgeIndex}`;
    const group = groups.get(groupKey) ?? { edge: edges[edgeIndex]!, marks: [] };
    group.marks.push(m);
    groups.set(groupKey, group);
  }

  for (const { edge: e, marks: group } of groups.values()) {
    const t: Vec2 = [(e.b[0] - e.a[0]) / e.length, (e.b[1] - e.a[1]) / e.length];
    const along = (m: UnitMark): number =>
      (m.center![0] - e.a[0]) * t[0] + (m.center![1] - e.a[1]) * t[1];
    const items: Slot[] = group
      .map((m) => ({
        m,
        s: along(m),
        w: Math.min(m.widthM, Math.max(MIN_WIDTH_M, e.length - 2 * EDGE_PAD_M)),
        fixed: m.confidence === "exact",
      }))
      .sort((a, b) => a.s - b.s);
    arrangeAlongEdge(items, e.length);
    for (const it of items) {
      it.m.center = [e.a[0] + t[0] * it.s, e.a[1] + t[1] * it.s];
      it.m.widthM = Math.round(it.w * 10) / 10;
    }
  }
}

/** Marks keep this far from a facade's ends. */
const EDGE_PAD_M = 0.5;

interface Slot {
  m: UnitMark;
  /** Centre, metres along the edge. */
  s: number;
  w: number;
  /** An exact position: it never moves. */
  fixed: boolean;
}

/**
 * Lay marks out along one facade (sorted by position): no overlaps, a gap
 * between neighbours, everything on the facade, and a cluster of approximate
 * marks kept centred on where its units really are. An exact mark keeps its
 * place — unless its glyph would hang off the end of the facade (a corner
 * unit, whose floor-plan point projects onto the facade's very end): then it
 * sits flush with that end.
 */
function arrangeAlongEdge(items: Slot[], length: number): void {
  const n = items.length;
  const lo = (it: Slot): number => EDGE_PAD_M + it.w / 2;
  const hi = (it: Slot): number => Math.max(lo(it), length - EDGE_PAD_M - it.w / 2);
  const need = (a: Slot, b: Slot): number => (a.w + b.w) / 2 + MIN_GAP_M;

  // Too many marks for this facade: they all get narrower (never below the minimum).
  const room = length - 2 * EDGE_PAD_M - MIN_GAP_M * (n - 1);
  const wanted = items.reduce((sum, it) => sum + it.w, 0);
  if (wanted > room) {
    const f = Math.max(room, 0) / wanted;
    for (const it of items) it.w = Math.max(MIN_WIDTH_M, it.w * f);
  }
  // A mark is a glyph on ONE face: half of it past the corner would float in
  // the air or sink into the next wall.
  for (const it of items) if (it.fixed) it.s = Math.min(Math.max(it.s, lo(it)), hi(it));
  // Two exact marks cannot move apart; where they collide they narrow instead.
  for (let i = 1; i < n; i++) {
    const a = items[i - 1]!;
    const b = items[i]!;
    if (!a.fixed || !b.fixed) continue;
    const have = b.s - a.s;
    if (have >= need(a, b)) continue;
    const f = Math.max(0.3, (have - MIN_GAP_M) / ((a.w + b.w) / 2));
    a.w = Math.max(MIN_WIDTH_M, a.w * f);
    b.w = Math.max(MIN_WIDTH_M, b.w * f);
  }
  for (const it of items) if (!it.fixed) it.s = Math.min(Math.max(it.s, lo(it)), hi(it));

  // Symmetric relaxation: overlapping neighbours part by equal amounts, so a
  // group stays centred on its true position.
  for (let pass = 0; pass < 16; pass++) {
    let moved = 0;
    for (let i = 1; i < n; i++) {
      const a = items[i - 1]!;
      const b = items[i]!;
      const push = need(a, b) - (b.s - a.s);
      if (push <= 1e-6 || (a.fixed && b.fixed)) continue;
      if (!a.fixed && !b.fixed) {
        a.s -= push / 2;
        b.s += push / 2;
      } else if (a.fixed) {
        b.s += push;
      } else {
        a.s -= push;
      }
      moved = Math.max(moved, push);
    }
    if (moved < 1e-4) break;
  }

  // Exact guarantee: one sweep each way pushes the movable marks clear of
  // their neighbours and back onto the facade.
  let cursor = EDGE_PAD_M;
  for (const it of items) {
    if (!it.fixed) it.s = Math.max(it.s, cursor + it.w / 2);
    cursor = it.s + it.w / 2 + MIN_GAP_M;
  }
  cursor = length - EDGE_PAD_M;
  for (let i = n - 1; i >= 0; i--) {
    const it = items[i]!;
    if (!it.fixed) it.s = Math.min(it.s, cursor - it.w / 2);
    cursor = it.s - it.w / 2 - MIN_GAP_M;
  }
  // Only when the facade is hopelessly short can a mark still stick out: pin it.
  for (const it of items) if (!it.fixed) it.s = Math.min(Math.max(it.s, lo(it)), hi(it));
}
