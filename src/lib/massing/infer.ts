import { angleDeltaDeg, normalizeDeg } from "../geo";
import type { BuildingSpec, MassingSegment } from "./spec";
import { BuildingSpecSchema } from "./spec";
import type { FloorPlate, Point, Stack, UnitPlan } from "../floorplan/schema";
import { FloorPlateSchema } from "../floorplan/schema";

/**
 * Derive a building's 3D massing from nothing but its published availability.
 *
 * The chain of reasoning is:
 *
 *   unit labels        → floor range, line vocabulary, skipped floors
 *   unit square footage → each line's required window frontage
 *   sum of frontages   → the floor plate's perimeter
 *   perimeter + aspect → plate width and depth
 *   walk the perimeter → each line's footprint on the plate, and its facing
 *   lines by floor     → podium/tower setbacks
 *
 * Every one of those steps is a real constraint, not a guess: a 750 sqft
 * apartment with a 9.5 m depth *must* have about 7.3 m of window wall, and the
 * plate perimeter *must* be the sum of those frontages plus the core's share.
 * The result is dimensionally honest even though no one measured the building.
 *
 * What it cannot know is absolute orientation and which line sits on which
 * face. Those come out as assumptions, reported in `notes` and recorded as
 * `provenance.confidence = "estimated"`, and are overridable per building.
 */

const SQFT_PER_SQM = 10.7639;

/**
 * Net saleable area as a share of the gross floor plate. Residential towers
 * run roughly 0.72-0.85 once corridors, the core, shafts and wall thickness
 * are removed; 0.78 is the middle of that band.
 */
const RESIDENTIAL_EFFICIENCY = 0.78;

/** Bounds on the window-to-corridor depth of a unit, metres. */
const MIN_UNIT_DEPTH_M = 6;
const MAX_UNIT_DEPTH_M = 14;

/** Share of the plate perimeter taken by the elevator lobby and stairs. */
const CORE_FRONTAGE_FRACTION = 0.08;

/** Floor-to-floor heights, metres. */
const TYPICAL_FLOOR_HEIGHT_M = 3.05;
const PODIUM_FLOOR_HEIGHT_M = 4.2;

export interface InferUnitInput {
  unitCode: string;
  floor: number | null;
  line: string | null;
  sqft?: number | null;
  bedrooms?: number | null;
  planKey?: string | null;
}

export interface InferPlanInput {
  key: string;
  name: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  sqft?: number | null;
}

export interface InferInput {
  slug: string;
  name: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  /** Rotation of the building off true north, degrees clockwise. */
  headingDeg?: number;
  /** Override the assumed unit depth when the real plate is known. */
  unitDepthM?: number;
  /** Override the plate's width:depth ratio. */
  aspectRatio?: number;
  units: InferUnitInput[];
  plans?: InferPlanInput[];
  /**
   * Stated orientations, from tour emails or floor-plan key plates. Even one
   * turns the line arrangement from a convention into a fitted result.
   */
  facingObservations?: FacingObservation[];
}

export interface InferResult {
  spec: BuildingSpec;
  plate: FloorPlate;
  /** Human-readable account of every assumption made. Surfaced in the UI. */
  notes: string[];
  /** Confidence in the derived geometry. */
  confidence: "measured" | "estimated" | "approximate";
}

export function inferBuilding(input: InferInput): InferResult {
  const notes: string[] = [];
  const placeable = input.units.filter(
    (u): u is InferUnitInput & { floor: number; line: string } =>
      u.floor != null && u.line != null,
  );

  if (placeable.length === 0) {
    throw new Error(
      `No unit in ${input.slug} has both a floor and a line. ` +
        "Unit labels must be <floor><line> (e.g. 3208) for the massing to be inferable.",
    );
  }
  if (placeable.length < input.units.length) {
    notes.push(
      `${input.units.length - placeable.length} of ${input.units.length} units had ` +
        "unparseable labels and were excluded from the massing.",
    );
  }

  // --- floors -------------------------------------------------------------
  const floors = placeable.map((u) => u.floor);
  const minFloor = Math.min(...floors);
  const topFloor = Math.max(...floors);
  const observedFloors = new Set(floors);
  const skippedFloors = findSkippedFloors(observedFloors, minFloor, topFloor);
  if (skippedFloors.length) {
    notes.push(`Assuming the building skips floor ${skippedFloors.join(", ")}.`);
  }

  // Availability never covers every floor, so the lowest *residential* floor
  // is inferred from the lowest observed one rather than assumed to be 1.
  const baseFloor = minFloor;
  if (minFloor > 1) {
    notes.push(
      `Lowest listed unit is on floor ${minFloor}; floors below it are modelled as ` +
        "podium/amenity and carry no units.",
    );
  }

  // --- lines --------------------------------------------------------------
  const lineStats = summarizeLines(placeable, input.plans ?? []);
  if (lineStats.length < 2) {
    notes.push(
      "Only one unit line was observed, so the plate shape is a placeholder. " +
        "More availability data will sharpen it.",
    );
  }

  const medianSqft = median(lineStats.map((l) => l.sqft));
  const missingSqft = lineStats.filter((l) => !l.sqftKnown).length;
  if (missingSqft) {
    notes.push(
      `${missingSqft} line(s) had no published square footage; used the building ` +
        `median of ${Math.round(medianSqft)} sqft for them.`,
    );
  }

  // --- plate geometry -----------------------------------------------------
  //
  // The units are a ring around a core. For a W×D plate with a ring of depth
  // d, the ring's area is P·d − 4d² (the −4d² removes the corner squares that
  // the two adjoining edges would otherwise both count). So:
  //
  //   gross plate area  = net unit area / efficiency
  //   W, D              from that area and the aspect ratio
  //   ring depth d      from  4d² − P·d + A_units = 0
  //
  // Solving in that order guarantees a plate big enough to hold its own units,
  // which solving for the perimeter directly does not.
  const netAreaSqm = lineStats.reduce((a, l) => a + l.sqft, 0) / SQFT_PER_SQM;
  const grossAreaSqm = netAreaSqm / RESIDENTIAL_EFFICIENCY;

  const aspect = input.aspectRatio ?? chooseAspect(lineStats.length, grossAreaSqm);
  const width = Math.sqrt(grossAreaSqm * aspect);
  const depth = Math.sqrt(grossAreaSqm / aspect);
  const perimeter = 2 * (width + depth);

  const unitDepth = input.unitDepthM ?? solveRingDepth(perimeter, netAreaSqm);

  notes.push(
    `Plate solved from ${lineStats.length} line(s) totalling ` +
      `${Math.round(netAreaSqm * SQFT_PER_SQM).toLocaleString()} sqft of units: ` +
      `${width.toFixed(1)} × ${depth.toFixed(1)} m ` +
      `(${Math.round(grossAreaSqm * SQFT_PER_SQM).toLocaleString()} sqft gross), ` +
      `${unitDepth.toFixed(1)} m unit depth.`,
  );

  const outline = rectangle(width, depth);
  const core = coreRectangle(width, depth, unitDepth);

  // --- allocate lines around the perimeter --------------------------------
  const orderedLines = [...lineStats].sort(compareLines);

  // Reserve the lift lobby's share of the perimeter, then divide the rest
  // between the lines in proportion to their floor area.
  const usablePerimeter = perimeter * (1 - CORE_FRONTAGE_FRACTION);
  const startT = perimeter * CORE_FRONTAGE_FRACTION;
  const frontages = orderedLines.map(
    (l) => usablePerimeter * ((l.sqft / SQFT_PER_SQM) / netAreaSqm),
  );

  const arrangement = fitArrangement({
    lines: orderedLines,
    frontages,
    width,
    depth,
    startT,
    observations: input.facingObservations ?? [],
  });

  if (arrangement.matched > 0) {
    notes.push(
      `Line positions fitted to ${arrangement.matched} stated facing(s) — ` +
        `${arrangement.direction === 1 ? "clockwise" : "counter-clockwise"} from line ` +
        `${orderedLines[arrangement.startIndex].line}, mean error ` +
        `${arrangement.score.toFixed(0)}°.`,
    );
    if (arrangement.score > 45) {
      notes.push(
        "That fit is poor — the plate is probably not a simple rectangle, or " +
          "the building has more lines than have been listed so far.",
      );
    }
  } else {
    notes.push(
      "Lines are placed clockwise from the north-west corner in ascending line " +
        "order — the standard convention, but unverified for this building. " +
        "Ingest a tour email stating any unit's facing to pin this down.",
    );
  }

  const stacks: Stack[] = orderedLines.map((line) => {
    const [t0, t1] = arrangement.arcs.get(line.line)!;
    return {
      line: line.line,
      polygon: perimeterSlab(width, depth, t0, t1, unitDepth),
      planId: line.planKey ?? `line-${line.line}`,
      floors: line.floorRange,
    };
  });

  // --- vertical segmentation ---------------------------------------------
  const segments = inferSegments(placeable, lineStats, baseFloor, topFloor, notes);

  // `baseFloor` on the spec is the lowest *modelled* floor, which is the base
  // of the segment stack — floor 1 whenever there is a podium, not the lowest
  // floor that happens to have a listing. Getting this wrong offsets every
  // height above the podium by the podium's floor count.
  const specBaseFloor = Math.min(...segments.map((s) => s.fromFloor));

  if (input.lat == null || input.lng == null) {
    notes.push(
      "No coordinates were scraped, so the building is placed at the Loop centroid. " +
        "Compass exposures are still correct; only the map position is a placeholder.",
    );
  }

  const spec = BuildingSpecSchema.parse({
    slug: input.slug,
    name: input.name,
    address: input.address,
    origin: {
      lat: input.lat ?? CHICAGO_LOOP.lat,
      lng: input.lng ?? CHICAGO_LOOP.lng,
    },
    headingDeg: input.headingDeg ?? 0,
    footprint: outline,
    baseFloor: specBaseFloor,
    topFloor,
    skippedFloors,
    segments,
    roof: "parapet",
    roofHeightM: 3,
    provenance: {
      source: "inferred-from-listings",
      confidence: "estimated",
      notes: [...notes],
    },
  });

  const plate = FloorPlateSchema.parse({
    buildingSlug: input.slug,
    floors: { from: baseFloor, to: topFloor },
    name: "Inferred typical floor",
    outline,
    core,
    stacks,
    plans: buildPlaceholderPlans(orderedLines, stacks, unitDepth),
  });

  return {
    spec,
    plate,
    notes,
    confidence: "estimated",
  };
}

const CHICAGO_LOOP = { lat: 41.8827, lng: -87.6233 };

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

interface LineStat {
  line: string;
  sqft: number;
  sqftKnown: boolean;
  bedrooms?: number;
  planKey?: string;
  unitCount: number;
  floorRange?: { from: number; to: number };
}

function summarizeLines(
  units: Array<InferUnitInput & { floor: number; line: string }>,
  plans: InferPlanInput[],
): LineStat[] {
  const planByKey = new Map(plans.map((p) => [p.key, p]));
  const byLine = new Map<string, Array<InferUnitInput & { floor: number; line: string }>>();
  for (const u of units) {
    const arr = byLine.get(u.line) ?? [];
    arr.push(u);
    byLine.set(u.line, arr);
  }

  const globalSqft = median(
    units.map((u) => u.sqft).filter((s): s is number => s != null && s > 0),
  );

  const out: LineStat[] = [];
  for (const [line, members] of byLine) {
    const sqfts = members
      .map((m) => m.sqft ?? (m.planKey ? planByKey.get(m.planKey)?.sqft ?? null : null))
      .filter((s): s is number => s != null && s > 0);

    const floorsOfLine = members.map((m) => m.floor);
    out.push({
      line,
      sqft: sqfts.length ? median(sqfts) : globalSqft || 750,
      sqftKnown: sqfts.length > 0,
      bedrooms: mode(members.map((m) => m.bedrooms).filter((b): b is number => b != null)),
      planKey: mode(members.map((m) => m.planKey).filter((p): p is string => !!p)),
      unitCount: members.length,
      // A line seen only on part of the tower genuinely exists only there.
      floorRange: { from: Math.min(...floorsOfLine), to: Math.max(...floorsOfLine) },
    });
  }
  return out;
}

/** Numeric line ids sort numerically; alphanumeric ones fall back to text. */
function compareLines(a: LineStat, b: LineStat): number {
  const na = Number(a.line.replace(/\D/g, ""));
  const nb = Number(b.line.replace(/\D/g, ""));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.line.localeCompare(b.line);
}

/**
 * A floor is treated as skipped only when it is superstition-numbered, absent
 * from the data, and bracketed by floors that *are* present. Plain absence
 * means "nothing available", not "doesn't exist".
 */
function findSkippedFloors(
  observed: Set<number>,
  min: number,
  max: number,
): number[] {
  const superstitious = [13, 14, 4, 24, 34, 44];
  return superstitious.filter(
    (f) =>
      f > min &&
      f < max &&
      !observed.has(f) &&
      observed.has(f - 1) &&
      observed.has(f + 1),
  );
}

// ---------------------------------------------------------------------------
// Plate geometry
// ---------------------------------------------------------------------------

/**
 * Width:depth ratio. Point towers with few lines are near-square; buildings
 * with many lines are double-loaded corridor bars and get progressively
 * longer. Clamped so the result stays a plausible building.
 */
function chooseAspect(lineCount: number, grossAreaSqm: number): number {
  if (lineCount <= 6) return 1.15;
  if (lineCount <= 10) return 1.5;
  if (lineCount <= 16) return 2.1;
  // Very large plates with many lines are almost always slab blocks.
  return Math.min(3.2, 2.1 + grossAreaSqm / 2000);
}

/**
 * Depth of the ring of units around the core, from
 * `perimeter · d − 4d² = netArea`. The smaller root is the physical one — the
 * larger root corresponds to the ring closing over the core entirely.
 */
function solveRingDepth(perimeter: number, netAreaSqm: number): number {
  const discriminant = perimeter * perimeter - 16 * netAreaSqm;
  const d =
    discriminant > 0
      ? (perimeter - Math.sqrt(discriminant)) / 8
      : // No real solution means the plate is too compact for a ring; fall
        // back to spreading the area evenly along the perimeter.
        netAreaSqm / perimeter;
  return Math.min(MAX_UNIT_DEPTH_M, Math.max(MIN_UNIT_DEPTH_M, d));
}

function rectangle(width: number, depth: number): Point[] {
  const w = width / 2;
  const d = depth / 2;
  // Counter-clockwise, which is what three.js Shape and the geo helpers expect.
  return [
    { x: -w, y: -d },
    { x: w, y: -d },
    { x: w, y: d },
    { x: -w, y: d },
  ];
}

function coreRectangle(width: number, depth: number, unitDepth: number): Point[] {
  const w = Math.max(2, width / 2 - unitDepth);
  const d = Math.max(2, depth / 2 - unitDepth);
  return [
    { x: -w, y: -d },
    { x: w, y: -d },
    { x: w, y: d },
    { x: -w, y: d },
  ];
}

/**
 * The footprint of one unit: a slab running from the exterior wall between
 * perimeter parameters `t0` and `t1` inward by `depth`.
 *
 * Corner units come out slightly squared-off because the inner boundary is
 * clamped to the core rectangle rather than mitred. That is visually correct
 * (corner units really do wrap the corner) and keeps every polygon simple.
 */
function perimeterSlab(
  width: number,
  depth: number,
  t0: number,
  t1: number,
  unitDepth: number,
): Point[] {
  const outer = perimeterPolyline(width, depth, t0, t1);
  const inner = outer.map((p) => towardCore(p, width, depth, unitDepth));
  return [...outer, ...inner.reverse()];
}

/** Points along the rectangle's perimeter from t0 to t1, corners included. */
function perimeterPolyline(
  width: number,
  depth: number,
  t0: number,
  t1: number,
): Point[] {
  const P = 2 * (width + depth);
  const pts: Point[] = [perimeterPoint(width, depth, t0)];
  // Corner parameters, walking clockwise from the north-west corner.
  const corners = [0, width, width + depth, 2 * width + depth];
  for (const c of corners) {
    for (const k of [-P, 0, P]) {
      const cc = c + k;
      if (cc > t0 + 1e-6 && cc < t1 - 1e-6) {
        pts.push(perimeterPoint(width, depth, cc));
      }
    }
  }
  pts.push(perimeterPoint(width, depth, t1));
  return pts;
}

// ---------------------------------------------------------------------------
// Fitting line positions to stated facings
// ---------------------------------------------------------------------------

/**
 * A unit's orientation as stated by someone who knows — a leasing agent's
 * "Southeast facing view", or a key plate on a floor plan PDF.
 */
export interface FacingObservation {
  line: string;
  /** Compass bearing, degrees from north. */
  bearingDeg: number;
  /** Relative confidence. A key plate outranks a remembered conversation. */
  weight?: number;
  source?: string;
}

interface Arrangement {
  startIndex: number;
  direction: 1 | -1;
  /** Perimeter arc [t0, t1] for each line. */
  arcs: Map<string, [number, number]>;
  /** Mean absolute angular error against the observations, degrees. */
  score: number;
  matched: number;
}

/**
 * Choose where each line sits on the plate.
 *
 * Without evidence this is pure convention — ascending line numbers running
 * clockwise from the north-west corner — and that convention is wrong often
 * enough to matter, because it decides every unit's compass exposure.
 *
 * Given even one or two stated facings the arrangement stops being a guess:
 * the number of consistent layouts is small (which line sits at the anchor,
 * times which way round the plate the numbering runs), so all of them are
 * enumerated and scored against what was actually observed.
 */
function fitArrangement(args: {
  lines: LineStat[];
  frontages: number[];
  width: number;
  depth: number;
  startT: number;
  observations: FacingObservation[];
}): Arrangement {
  const { lines, frontages, width, depth, startT, observations } = args;
  const n = lines.length;

  const known = new Map<string, FacingObservation>();
  for (const o of observations) {
    const key = o.line.trim().toUpperCase();
    if (lines.some((l) => l.line.toUpperCase() === key)) known.set(key, o);
  }

  let best: Arrangement | null = null;

  for (const direction of [1, -1] as const) {
    for (let startIndex = 0; startIndex < n; startIndex++) {
      const arcs = layOut(lines, frontages, startIndex, direction, startT);

      let error = 0;
      let weight = 0;
      let matched = 0;
      for (const [line, [t0, t1]] of arcs) {
        const obs = known.get(line.toUpperCase());
        if (!obs) continue;
        const predicted = arcFacing(width, depth, t0, t1);
        const w = obs.weight ?? 1;
        error += Math.abs(angleDeltaDeg(predicted, obs.bearingDeg)) * w;
        weight += w;
        matched++;
      }

      const score = weight > 0 ? error / weight : Number.POSITIVE_INFINITY;
      // With no observations every candidate ties, so the first one wins —
      // which is the conventional clockwise-from-north-west layout.
      if (!best || score < best.score) {
        best = { startIndex, direction, arcs, score, matched };
      }
    }
  }

  return best!;
}

/** Walk the lines around the perimeter from a given anchor and direction. */
function layOut(
  lines: LineStat[],
  frontages: number[],
  startIndex: number,
  direction: 1 | -1,
  startT: number,
): Map<string, [number, number]> {
  const n = lines.length;
  const out = new Map<string, [number, number]>();
  let t = startT;
  for (let k = 0; k < n; k++) {
    const i = (((startIndex + direction * k) % n) + n) % n;
    out.set(lines[i].line, [t, t + frontages[i]]);
    t += frontages[i];
  }
  return out;
}

/**
 * Outward bearing of the wall an arc covers, as a length-weighted circular
 * mean. A unit wrapping a corner correctly comes out diagonal rather than
 * snapping to whichever edge happens to hold its midpoint.
 */
export function arcFacing(
  width: number,
  depth: number,
  t0: number,
  t1: number,
): number {
  const P = 2 * (width + depth);
  // Edge spans in the clockwise-from-north-west parameterisation, and the
  // outward compass bearing of each.
  const edges: Array<[number, number, number]> = [
    [0, width, 0], // north
    [width, width + depth, 90], // east
    [width + depth, 2 * width + depth, 180], // south
    [2 * width + depth, P, 270], // west
  ];

  let sx = 0;
  let sy = 0;
  // Sweep one period either side so an arc that wraps the origin is covered.
  for (let period = -1; period <= 1; period++) {
    for (const [a, b, bearing] of edges) {
      const lo = Math.max(t0, a + period * P);
      const hi = Math.min(t1, b + period * P);
      const len = hi - lo;
      if (len <= 0) continue;
      const r = (bearing * Math.PI) / 180;
      sx += Math.sin(r) * len;
      sy += Math.cos(r) * len;
    }
  }
  if (sx === 0 && sy === 0) return 0;
  return normalizeDeg((Math.atan2(sx, sy) * 180) / Math.PI);
}

/**
 * Parameterise the rectangle clockwise from the north-west corner:
 * north edge → east edge → south edge → west edge.
 */
export function perimeterPoint(width: number, depth: number, t: number): Point {
  const P = 2 * (width + depth);
  let s = ((t % P) + P) % P;
  const w = width / 2;
  const d = depth / 2;

  if (s <= width) return { x: -w + s, y: d };
  s -= width;
  if (s <= depth) return { x: w, y: d - s };
  s -= depth;
  if (s <= width) return { x: w - s, y: -d };
  s -= width;
  return { x: -w, y: -d + s };
}

function towardCore(p: Point, width: number, depth: number, unitDepth: number): Point {
  const maxX = Math.max(1, width / 2 - unitDepth);
  const maxY = Math.max(1, depth / 2 - unitDepth);
  return {
    x: Math.sign(p.x) * Math.min(Math.abs(p.x), maxX),
    y: Math.sign(p.y) * Math.min(Math.abs(p.y), maxY),
  };
}

// ---------------------------------------------------------------------------
// Vertical segmentation
// ---------------------------------------------------------------------------

/**
 * Detect setbacks by looking for lines that stop partway up. When a group of
 * lines exists only below floor F, the plate above F is smaller — that is a
 * setback, and it is directly observable in the unit numbering.
 */
function inferSegments(
  units: Array<InferUnitInput & { floor: number; line: string }>,
  lines: LineStat[],
  baseFloor: number,
  topFloor: number,
  notes: string[],
): MassingSegment[] {
  const segments: MassingSegment[] = [];

  // Floors below the lowest listed unit are podium: taller, full footprint.
  // The podium must stop one floor *below* the first residential floor —
  // overlapping segments get counted twice by floorSlabHeight, which detaches
  // the roof and misplaces every unit above the overlap.
  const podiumTop = baseFloor - 1;
  if (podiumTop >= 1) {
    segments.push({
      fromFloor: 1,
      toFloor: podiumTop,
      inset: 0,
      floorHeight: PODIUM_FLOOR_HEIGHT_M,
      rotationDeg: 0,
      label: "Podium",
    });
  }

  // A line that tops out well below the roof implies the plate steps in there.
  //
  // Availability is a sparse sample of the building, so a line's highest
  // *listed* floor is not its highest floor. Only treat a ceiling as real when
  // it would be statistically surprising under uniform sampling: if a line has
  // n listings all at or below floor f, and floors run base..top, the chance of
  // that happening by luck is ((f − base) / (top − base))^n.
  const SIGNIFICANCE = 0.02;
  const span = Math.max(1, topFloor - baseFloor);

  const cutoffs = lines
    .filter((l) => {
      if (!l.floorRange || l.unitCount < 4) return false;
      const ceiling = l.floorRange.to;
      if (ceiling >= topFloor - 3) return false;
      const ratio = Math.max(0, (ceiling - baseFloor) / span);
      return Math.pow(ratio, l.unitCount) < SIGNIFICANCE;
    })
    .map((l) => l.floorRange!.to)
    .sort((a, b) => a - b);

  // One truncated line is an anomaly; several agreeing is a setback.
  const setbackAt = cutoffs.length >= 2 ? mode(cutoffs) : undefined;

  if (setbackAt != null && setbackAt > baseFloor + 2) {
    const droppedFrontage = lines
      .filter((l) => l.floorRange && l.floorRange.to <= setbackAt)
      .reduce((a, l) => a + l.sqft, 0);
    const totalFrontage = lines.reduce((a, l) => a + l.sqft, 0);
    // Translate the lost area into an inward offset of the whole ring.
    const shrink = droppedFrontage / totalFrontage;
    const inset = Math.max(1.5, Math.min(8, shrink * 20));

    segments.push({
      fromFloor: Math.max(baseFloor, 1),
      toFloor: setbackAt,
      inset: 0,
      floorHeight: TYPICAL_FLOOR_HEIGHT_M,
      rotationDeg: 0,
      label: "Lower tower",
    });
    segments.push({
      fromFloor: setbackAt + 1,
      toFloor: topFloor,
      inset,
      floorHeight: TYPICAL_FLOOR_HEIGHT_M,
      rotationDeg: 0,
      label: "Upper tower",
    });
    notes.push(
      `Lines ending at floor ${setbackAt} imply a setback there; the plate above ` +
        `is modelled ${inset.toFixed(1)} m smaller on each side.`,
    );
  } else {
    segments.push({
      fromFloor: Math.max(baseFloor, 1),
      toFloor: topFloor,
      inset: 0,
      floorHeight: TYPICAL_FLOOR_HEIGHT_M,
      rotationDeg: 0,
      label: "Tower",
    });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Placeholder unit plans
// ---------------------------------------------------------------------------

/**
 * Until a floor plan image is traced, each stack gets a plan that is simply
 * its own footprint with the exterior wall glazed. That is enough to render
 * the unit in 3D and to drive the view camera; tracing later replaces it with
 * real rooms.
 */
function buildPlaceholderPlans(
  lines: LineStat[],
  stacks: Stack[],
  unitDepth: number,
): UnitPlan[] {
  return stacks.map((stack, i) => {
    const line = lines[i];
    return {
      id: stack.planId,
      name: `Line ${stack.line}`,
      bedrooms: line?.bedrooms ?? 1,
      bathrooms: 1,
      sqft: Math.round(line?.sqft ?? 750),
      ceilingHeightM: 2.7,
      outline: stack.polygon,
      rooms: [],
      openings: [],
      source: {
        kind: "inferred" as const,
        note: `Footprint solved from ${Math.round(line?.sqft ?? 0)} sqft at ${unitDepth} m depth.`,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Small stats helpers
// ---------------------------------------------------------------------------

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mode<T>(values: T[]): T | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}
