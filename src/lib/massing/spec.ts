import { z } from "zod";

/**
 * A BuildingSpec is the single source of truth for a building's 3D form.
 *
 * The goal is that *every* Chicago building can be described by this schema
 * without hand-modelling anything: a footprint polygon plus a stack of massing
 * segments reproduces the overwhelming majority of the city's residential
 * towers (podium + tower + setbacks + crown). Specs can be authored by hand,
 * generated from the Chicago open-data building footprint layer, or refined
 * from a floor plan.
 */

export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/**
 * A footprint vertex expressed as an offset in metres from the building origin.
 * Authoring in local metres (rather than lat/lng) keeps hand-written specs
 * readable — a 30 x 45 m floor plate is obvious, four 6-decimal coordinates
 * are not.
 */
export const FootprintPointSchema = z.object({
  x: z.number(), // metres east of origin
  y: z.number(), // metres north of origin
});

export const RoofStyleSchema = z.enum([
  "flat",
  "parapet",
  "setback-crown",
  "sloped",
  "spire",
]);
export type RoofStyle = z.infer<typeof RoofStyleSchema>;

/**
 * One vertical segment of the massing. Segments stack bottom-to-top and are
 * described in floors, not metres, so that a listing's floor number maps
 * directly onto geometry.
 */
export const MassingSegmentSchema = z.object({
  /** Inclusive first floor of this segment, using the building's own numbering. */
  fromFloor: z.number().int(),
  /** Inclusive last floor of this segment. */
  toFloor: z.number().int(),
  /** Metres each vertex is pulled inward from the base footprint. */
  inset: z.number().min(0).default(0),
  /** Floor-to-floor height in metres. Chicago residential is typically 2.9-3.2. */
  floorHeight: z.number().positive().default(3.05),
  /** Optional rotation of this segment about the building origin, in degrees. */
  rotationDeg: z.number().default(0),
  label: z.string().optional(),
});
export type MassingSegment = z.infer<typeof MassingSegmentSchema>;

export const BuildingSpecSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  address: z.string().optional(),
  neighborhood: z.string().optional(),

  /** Ground-level position of the footprint origin. */
  origin: LatLngSchema,
  /** Ground elevation in metres above lake datum. Chicago is ~180 m. */
  groundElevationM: z.number().default(180),
  /**
   * Rotation of the whole building about its origin, in degrees clockwise from
   * north. Most Chicago buildings sit on the street grid, which is itself
   * rotated slightly; this captures that.
   */
  headingDeg: z.number().default(0),

  /** Base footprint ring, counter-clockwise, in metres from origin. */
  footprint: z.array(FootprintPointSchema).min(3),

  /** Floor number of the lowest modelled floor (often 1, sometimes 0 or -1). */
  baseFloor: z.number().int().default(1),
  /** Highest occupied floor. */
  topFloor: z.number().int(),
  /**
   * Floor numbers the building skips (13, 14, 44 in buildings that omit
   * unlucky numbers). Used to convert a *label* floor to a *physical* floor.
   */
  skippedFloors: z.array(z.number().int()).default([]),

  segments: z.array(MassingSegmentSchema).min(1),

  roof: RoofStyleSchema.default("parapet"),
  /** Extra height above the top floor slab: parapet, crown, spire. */
  roofHeightM: z.number().min(0).default(3),

  /** Low-poly palette. Kept on the spec so buildings read as distinct. */
  palette: z
    .object({
      facade: z.string().default("#8f9aa8"),
      glass: z.string().default("#5b86a8"),
      accent: z.string().default("#c8cdd4"),
      roof: z.string().default("#6d7681"),
    })
    .default({
      facade: "#8f9aa8",
      glass: "#5b86a8",
      accent: "#c8cdd4",
      roof: "#6d7681",
    }),

  /** Where the numbers came from, and how much to trust them. */
  provenance: z
    .object({
      source: z.string().default("manual"),
      confidence: z.enum(["measured", "estimated", "approximate"]).default("approximate"),
      /** Every assumption the solver made, one per entry. Shown in the UI. */
      notes: z.array(z.string()).default([]),
    })
    .default({ source: "manual", confidence: "approximate", notes: [] }),
});

export type BuildingSpec = z.infer<typeof BuildingSpecSchema>;
export type FootprintPoint = z.infer<typeof FootprintPointSchema>;

/**
 * Convert a *label* floor (what the elevator button says) into a physical
 * floor index counted from `baseFloor`, accounting for skipped numbers.
 */
export function physicalFloorIndex(spec: BuildingSpec, labelFloor: number): number {
  const skipped = spec.skippedFloors.filter(
    (f) => f >= spec.baseFloor && f < labelFloor,
  ).length;
  return labelFloor - spec.baseFloor - skipped;
}

/** Height in metres of the slab of a given label floor, above ground. */
export function floorSlabHeight(spec: BuildingSpec, labelFloor: number): number {
  const target = physicalFloorIndex(spec, labelFloor);
  if (target <= 0) return 0;

  let h = 0;
  let counted = 0;
  for (const seg of orderedSegments(spec)) {
    const segFloors = segmentFloorCount(spec, seg);
    if (counted + segFloors >= target) {
      return h + (target - counted) * seg.floorHeight;
    }
    h += segFloors * seg.floorHeight;
    counted += segFloors;
  }
  // Above every declared segment — extrapolate with the topmost floor height.
  const last = orderedSegments(spec).at(-1)!;
  return h + (target - counted) * last.floorHeight;
}

/** Segments sorted bottom-to-top. */
export function orderedSegments(spec: BuildingSpec): MassingSegment[] {
  return [...spec.segments].sort((a, b) => a.fromFloor - b.fromFloor);
}

/** Number of *physical* floors a segment spans. */
export function segmentFloorCount(spec: BuildingSpec, seg: MassingSegment): number {
  const skipped = spec.skippedFloors.filter(
    (f) => f >= seg.fromFloor && f <= seg.toFloor,
  ).length;
  return seg.toFloor - seg.fromFloor + 1 - skipped;
}

/** The segment that contains a given label floor. */
export function segmentForFloor(
  spec: BuildingSpec,
  labelFloor: number,
): MassingSegment {
  const segs = orderedSegments(spec);
  const hit = segs.find((s) => labelFloor >= s.fromFloor && labelFloor <= s.toFloor);
  return hit ?? (labelFloor < segs[0].fromFloor ? segs[0] : segs.at(-1)!);
}

/** Total modelled height including the roof feature. */
export function buildingHeightM(spec: BuildingSpec): number {
  return floorSlabHeight(spec, spec.topFloor + 1) + spec.roofHeightM;
}

/** Every label floor the building actually has, in order. */
export function floorLabels(spec: BuildingSpec): number[] {
  const skipped = new Set(spec.skippedFloors);
  const out: number[] = [];
  for (let f = spec.baseFloor; f <= spec.topFloor; f++) {
    if (!skipped.has(f)) out.push(f);
  }
  return out;
}
