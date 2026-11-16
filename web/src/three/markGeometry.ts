import { normalizeRing, type Vec2 } from "../../../shared/src/placement";
import type { UnitMark } from "../../../shared/src/unitLayout";
import { isDrawn, type MarkLook, type MarkState } from "./unitMarks";

/**
 * Turns the marks into ONE merged set of quads (plain typed arrays, no
 * three.js) plus a second, invisible set that the pointer is tested against.
 *
 * Every quad is flat against a wall, a little proud of it, and carries its
 * own local coordinates in metres; the fragment shader (markMaterial.ts)
 * draws the body, outline, hatch, whiskers and dashes inside it, so line
 * weights can be held in screen pixels. Quads are emitted back to front
 * (bands, strips, whiskers, plates) and the material writes no depth, so
 * marks never z-fight with each other: the order in the index buffer is the
 * paint order.
 */

/** What a quad is — `aStyle.x`. */
export const KIND = { plate: 0, belt: 1, riser: 2, whisker: 3 } as const;
/** How its body is filled — `aStyle.y`. */
export const FILL = { outline: 0, solid: 1, hatch: 2, muted: 3 } as const;

const FILL_OF: Record<MarkLook, number> = {
  outline: FILL.outline,
  solid: FILL.solid,
  hatch: FILL.hatch,
  muted: FILL.muted,
};
/** Paint order inside a layer: the grey marks first, so they never cover a coloured one. */
const PAINT_RANK: Record<MarkLook, number> = { muted: 0, hatch: 1, outline: 2, solid: 3 };

/** How far each layer stands off the wall, in metres. */
const PROUD_M = { belt: 0.14, riser: 0.2, whisker: 0.25, plate: 0.3 };
/** The pointer targets stand a little further out, plates in front: a plate wins over the band behind it. */
const PICK_PROUD_M = { belt: 0.34, riser: 0.4, plate: 0.46 };
/** Room around a body for its dark edge and its highlight ring. */
const MARGIN_M = 1.6;
/** A plate stops this far short of its floor's top and bottom, so plates on adjacent floors stay two marks. */
const PLATE_INSET_M = 0.3;
/** Approximate position: a whisker of at most this length on each side, ending in a tick this tall. */
const WHISKER_M = 2.6;
const WHISKER_TICK_M = 1.5;
const WHISKER_MIN_M = 0.8;
/** A strip is this share of the slot the layout gives a stack. */
const RISER_SHARE = 0.6;
/**
 * Floor-only band: height, and the length of one dash plus its gap (before
 * fitting the perimeter). Kept slight — it is one listing, drawn on every
 * face, and must not outweigh the plates.
 */
const BELT_HEIGHT_M = 1;
const BELT_PERIOD_M = 8;
const BELT_DASH_SHARE = 0.4;
/** `aShape.w` of a band packs "which dash is mine" as slot + BELT_SLOT_BASE * count. */
export const BELT_SLOT_BASE = 64;
/** Footprint edges shorter than this are notches, not facades (as in the layout). */
const MIN_FACADE_EDGE_M = 6;

interface RingEdge {
  a: Vec2;
  /** Unit vector from a to b. */
  dir: Vec2;
  /** Unit outward normal (the ring is counter-clockwise). */
  normal: Vec2;
  length: number;
  /** Distance along the perimeter at which the edge starts. */
  start: number;
}

function ringEdges(ring: Vec2[]): { edges: RingEdge[]; perimeter: number } {
  const r = normalizeRing(ring);
  const edges: RingEdge[] = [];
  let start = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-6) continue;
    const dir: Vec2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    edges.push({ a, dir, normal: [dir[1], -dir[0]], length, start });
    start += length;
  }
  return { edges, perimeter: start };
}

/** Free facade on either side of a mark (towards the start / the end of its edge), in metres. */
function facadeRoom(edges: readonly RingEdge[], mark: UnitMark): [number, number] {
  const c = mark.center!;
  const n = mark.normal!;
  let best: [number, number] | null = null;
  let bestDistance = Infinity;
  for (const e of edges) {
    if (e.normal[0] * n[0] + e.normal[1] * n[1] < 0.99) continue;
    const along = (c[0] - e.a[0]) * e.dir[0] + (c[1] - e.a[1]) * e.dir[1];
    const t = Math.min(Math.max(along, 0), e.length);
    const distance =
      Math.hypot(c[0] - (e.a[0] + e.dir[0] * t), c[1] - (e.a[1] + e.dir[1] * t)) +
      (e.length < MIN_FACADE_EDGE_M ? 1000 : 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [along - mark.widthM / 2, e.length - along - mark.widthM / 2];
    }
  }
  return best ?? [0, 0];
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** "#rrggbb" (sRGB) -> linear RGB, the space the shader works in. */
export function hexToLinear(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => toLinear(parseInt(h.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
}

type Vec4 = readonly [number, number, number, number];
type Rgb = readonly [number, number, number];

/** Collects quads that lie in a vertical plane given by a plan point, a direction along the wall and its normal. */
class Quads {
  readonly position: number[] = [];
  readonly local: number[] = [];
  readonly shape: number[] = [];
  readonly style: number[] = [];
  readonly color: number[] = [];
  readonly index: number[] = [];

  /**
   * x0..x1 metres along `along` from `origin`, z0..z1 metres above ground,
   * `proud` metres out of the wall. Local coordinates run lx0..lx1 across and
   * ly0..ly1 up. Wound counter-clockwise seen from outside.
   */
  add(
    origin: Vec2,
    along: Vec2,
    normal: Vec2,
    proud: number,
    [x0, x1, z0, z1]: Vec4,
    [lx0, lx1, ly0, ly1]: Vec4,
    shape?: Vec4,
    style?: Vec4,
    rgb?: Rgb,
  ): void {
    const base = this.position.length / 3;
    const ox = origin[0] + normal[0] * proud;
    const oy = origin[1] + normal[1] * proud;
    const corners: readonly (readonly [number, number, number, number])[] = [
      [x0, z0, lx0, ly0],
      [x1, z0, lx1, ly0],
      [x1, z1, lx1, ly1],
      [x0, z1, lx0, ly1],
    ];
    for (const [x, z, lx, ly] of corners) {
      // plan (x east, y north, z up) -> three (x, up, -north)
      this.position.push(ox + along[0] * x, z, -(oy + along[1] * x));
      this.local.push(lx, ly);
      if (shape) this.shape.push(shape[0], shape[1], shape[2], shape[3]);
      if (style) this.style.push(style[0], style[1], style[2], style[3]);
      if (rgb) this.color.push(rgb[0], rgb[1], rgb[2]);
    }
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  get quadCount(): number {
    return this.index.length / 6;
  }
}

/** The floor-only listings of one floor: they share its dashed band, dash by dash. */
export interface BeltGroup {
  /** Length of one dash plus its gap, in metres along the perimeter. */
  period: number;
  /** State index of the listing each slot belongs to. */
  members: number[];
}

/** What one quad of the pointer geometry stands for. */
export type PickTarget =
  | { mark: number }
  | { belt: BeltGroup; a: Vec2; dir: Vec2; start: number };

export interface MarkBuffers {
  /** Vertex data of the drawn quads; empty arrays when nothing can be placed. */
  position: Float32Array;
  /** aLocal: metres across / up inside the quad. */
  local: Float32Array;
  /** aShape: half width, half height of the body, then two numbers that depend on the kind. */
  shape: Float32Array;
  /** aStyle: KIND, FILL, state index, unused. */
  style: Float32Array;
  /** aColor: linear RGB. */
  color: Float32Array;
  index: Uint16Array;
  pick: {
    position: Float32Array;
    index: Uint16Array;
    /** One entry per quad (two triangles). */
    targets: PickTarget[];
  };
  /** Per state: where its label goes, in three.js coordinates; null for bands (anywhere around the floor). */
  anchors: ([number, number, number] | null)[];
}

export function buildMarkBuffers(states: readonly MarkState[], ring: Vec2[]): MarkBuffers {
  const { edges, perimeter } = ringEdges(ring);
  const draw = new Quads();
  const pick = new Quads();
  const targets: PickTarget[] = [];
  const anchors: ([number, number, number] | null)[] = states.map(() => null);

  const order = states
    .map((state, index) => ({ state, index }))
    .filter(({ state }) => isDrawn(state))
    .sort((p, q) => PAINT_RANK[p.state.look] - PAINT_RANK[q.state.look] || p.index - q.index);
  const style = (kind: number, s: MarkState, index: number): Vec4 => [
    kind,
    FILL_OF[s.look],
    index,
    0,
  ];

  // ---- bands: floor known, side unknown ----
  const groups = new Map<number, { group: BeltGroup; zMin: number; zMax: number }>();
  for (const { state, index } of order) {
    const m = state.mark;
    if (m.kind !== "belt" || m.zMin === null || m.zMax === null || m.floor === null) continue;
    const [slot, count] = m.beltSlot ?? [0, 1];
    let entry = groups.get(m.floor);
    if (!entry) {
      // A whole number of dashes around the tower, the same number for each listing of the floor.
      const cells = count * Math.max(1, Math.round(perimeter / (count * BELT_PERIOD_M)));
      entry = {
        group: { period: perimeter / cells, members: new Array<number>(count).fill(-1) },
        zMin: m.zMin,
        zMax: m.zMax,
      };
      groups.set(m.floor, entry);
    }
    const { group } = entry;
    group.members[slot] = index;
    const mid = (m.zMin + m.zMax) / 2;
    const halfH = BELT_HEIGHT_M / 2;
    const rgb = hexToLinear(state.color);
    for (const e of edges) {
      draw.add(
        e.a,
        e.dir,
        e.normal,
        PROUD_M.belt,
        [0, e.length, mid - halfH - MARGIN_M, mid + halfH + MARGIN_M],
        [e.start, e.start + e.length, -halfH - MARGIN_M, halfH + MARGIN_M],
        [(group.period * BELT_DASH_SHARE) / 2, halfH, group.period, slot + BELT_SLOT_BASE * count],
        style(KIND.belt, state, index),
        rgb,
      );
    }
  }
  for (const { group, zMin, zMax } of groups.values()) {
    for (const e of edges) {
      pick.add(e.a, e.dir, e.normal, PICK_PROUD_M.belt, [0, e.length, zMin, zMax], [0, 0, 0, 0]);
      targets.push({ belt: group, a: e.a, dir: e.dir, start: e.start });
    }
  }

  // ---- strips: stack known, floor unknown ----
  for (const { state, index } of order) {
    const m = state.mark;
    if (m.kind !== "riser" || !m.center || !m.normal || !m.tangent) continue;
    if (m.zMin === null || m.zMax === null) continue;
    const halfW = (m.widthM * RISER_SHARE) / 2;
    const halfH = (m.zMax - m.zMin) / 2;
    const mid = (m.zMin + m.zMax) / 2;
    draw.add(
      m.center,
      m.tangent,
      m.normal,
      PROUD_M.riser,
      [-halfW - MARGIN_M, halfW + MARGIN_M, m.zMin - MARGIN_M, m.zMax + MARGIN_M],
      [-halfW - MARGIN_M, halfW + MARGIN_M, -halfH - MARGIN_M, halfH + MARGIN_M],
      [halfW, halfH, 0, 0],
      style(KIND.riser, state, index),
      hexToLinear(state.color),
    );
    const pickHalf = m.widthM / 2 + 0.3;
    pick.add(m.center, m.tangent, m.normal, PICK_PROUD_M.riser, [-pickHalf, pickHalf, m.zMin, m.zMax], [0, 0, 0, 0]);
    targets.push({ mark: index });
    anchors[index] = [
      m.center[0] + m.normal[0] * PROUD_M.riser,
      mid + halfH * 0.3,
      -(m.center[1] + m.normal[1] * PROUD_M.riser),
    ];
  }

  // ---- plates: one floor on one face; whiskers first, so that no whisker crosses a neighbour's plate ----
  const plates = order.filter(
    ({ state: { mark: m } }) =>
      m.kind === "plate" && m.center && m.normal && m.tangent && m.zMin !== null && m.zMax !== null,
  );
  for (const { state, index } of plates) {
    const m = state.mark;
    if (m.confidence === "exact") continue;
    const [before, after] = facadeRoom(edges, m);
    const fit = (room: number): number => {
      const length = Math.min(WHISKER_M, room - 0.3);
      return length >= WHISKER_MIN_M ? length : 0;
    };
    const left = fit(before);
    const right = fit(after);
    if (left === 0 && right === 0) continue;
    const halfW = m.widthM / 2;
    const mid = (m.zMin! + m.zMax!) / 2;
    const halfTick = WHISKER_TICK_M / 2;
    const pad = 0.7;
    draw.add(
      m.center!,
      m.tangent!,
      m.normal!,
      PROUD_M.whisker,
      [-halfW - left - pad, halfW + right + pad, mid - halfTick - pad, mid + halfTick + pad],
      [-halfW - left - pad, halfW + right + pad, -halfTick - pad, halfTick + pad],
      [halfW, halfTick, left, right],
      style(KIND.whisker, state, index),
      hexToLinear(state.color),
    );
  }
  for (const { state, index } of plates) {
    const m = state.mark;
    const halfW = m.widthM / 2;
    const halfH = Math.max((m.zMax! - m.zMin!) / 2 - PLATE_INSET_M, 0.5);
    const mid = (m.zMin! + m.zMax!) / 2;
    draw.add(
      m.center!,
      m.tangent!,
      m.normal!,
      PROUD_M.plate,
      [-halfW - MARGIN_M, halfW + MARGIN_M, mid - halfH - MARGIN_M, mid + halfH + MARGIN_M],
      [-halfW - MARGIN_M, halfW + MARGIN_M, -halfH - MARGIN_M, halfH + MARGIN_M],
      [halfW, halfH, 0, 0],
      style(KIND.plate, state, index),
      hexToLinear(state.color),
    );
    pick.add(
      m.center!,
      m.tangent!,
      m.normal!,
      PICK_PROUD_M.plate,
      [-halfW - 0.5, halfW + 0.5, m.zMin!, m.zMax!],
      [0, 0, 0, 0],
    );
    targets.push({ mark: index });
    anchors[index] = [
      m.center![0] + m.normal![0] * PROUD_M.plate,
      mid + halfH,
      -(m.center![1] + m.normal![1] * PROUD_M.plate),
    ];
  }

  return {
    position: new Float32Array(draw.position),
    local: new Float32Array(draw.local),
    shape: new Float32Array(draw.shape),
    style: new Float32Array(draw.style),
    color: new Float32Array(draw.color),
    index: new Uint16Array(draw.index),
    pick: {
      position: new Float32Array(pick.position),
      index: new Uint16Array(pick.index),
      targets,
    },
    anchors,
  };
}

/** Which listing a hit on a pointer quad means; `point` is the hit in three.js coordinates. -1 = none. */
export function resolvePick(target: PickTarget, point: { x: number; z: number }): number {
  if ("mark" in target) return target.mark;
  const { belt, a, dir, start } = target;
  // three (x, up, -north) -> plan, then metres along the perimeter
  const s = start + (point.x - a[0]) * dir[0] + (-point.z - a[1]) * dir[1];
  const count = belt.members.length;
  const slot = ((Math.floor(s / belt.period) % count) + count) % count;
  return belt.members[slot] ?? -1;
}

/**
 * Where the label of a floor-only mark goes when nothing points at it: on the
 * outline, at the point nearest to the viewer (`eye` in plan metres), at the
 * top of its floor. Three.js coordinates.
 */
export function beltAnchor(ring: Vec2[], mark: UnitMark, eye: Vec2): [number, number, number] | null {
  if (mark.zMax === null) return null;
  let best: Vec2 | null = null;
  let bestDistance = Infinity;
  for (const e of ringEdges(ring).edges) {
    const t = Math.min(
      Math.max((eye[0] - e.a[0]) * e.dir[0] + (eye[1] - e.a[1]) * e.dir[1], 0),
      e.length,
    );
    const p: Vec2 = [e.a[0] + e.dir[0] * t, e.a[1] + e.dir[1] * t];
    const distance = Math.hypot(eye[0] - p[0], eye[1] - p[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = p;
    }
  }
  return best ? [best[0], mark.zMax, -best[1]] : null;
}
