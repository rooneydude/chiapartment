import { z } from "zod";

/**
 * Floor plans come in two layers:
 *
 *  1. A **floor plate** — how the units tile a typical floor. This is what
 *     answers "where in the building is unit 3208?".
 *  2. A **unit plan** — the interior layout of one floor plan type (rooms,
 *     walls, doors, windows). This is what gets drawn in 2D and extruded into
 *     the 3D unit volume.
 *
 * Both are authored in metres in the building's *unrotated* local frame, with
 * the same origin as the BuildingSpec footprint, so a unit polygon can be
 * dropped straight onto the massing without any per-building fudge factors.
 */

export const PointSchema = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof PointSchema>;

export const ROOM_TYPES = [
  "living",
  "bedroom",
  "kitchen",
  "dining",
  "bath",
  "closet",
  "hall",
  "balcony",
  "den",
  "laundry",
  "storage",
  "core", // elevator / stair / shaft — not part of any unit
] as const;
export const RoomTypeSchema = z.enum(ROOM_TYPES);
export type RoomType = z.infer<typeof RoomTypeSchema>;

export const RoomSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  type: RoomTypeSchema,
  /** Room outline, counter-clockwise, metres in the unit's local frame. */
  polygon: z.array(PointSchema).min(3),
});
export type Room = z.infer<typeof RoomSchema>;

export const OpeningSchema = z.object({
  id: z.string(),
  kind: z.enum(["door", "window", "sliding-door", "opening"]),
  /** Both endpoints on the wall the opening sits in. */
  a: PointSchema,
  b: PointSchema,
  /** Sill height above the floor, metres. Windows ~0.5, doors 0. */
  sillM: z.number().default(0),
  /** Head height above the floor, metres. */
  headM: z.number().default(2.1),
  /** True when the opening faces outside the building. */
  exterior: z.boolean().default(false),
});
export type Opening = z.infer<typeof OpeningSchema>;

export const UnitPlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  bedrooms: z.number().min(0),
  bathrooms: z.number().min(0),
  /** Advertised interior square feet, when the building publishes it. */
  sqft: z.number().positive().optional(),
  ceilingHeightM: z.number().positive().default(2.7),
  /** Outline of the whole unit, counter-clockwise, metres. */
  outline: z.array(PointSchema).min(3),
  rooms: z.array(RoomSchema).default([]),
  openings: z.array(OpeningSchema).default([]),
  /** Where this plan came from — a traced image, hand entry, or the building. */
  source: z
    .object({
      kind: z.enum(["traced", "manual", "published", "inferred"]).default("manual"),
      image: z.string().optional(),
      /** Pixels per metre used when tracing, kept so a retrace is reproducible. */
      pxPerM: z.number().positive().optional(),
      note: z.string().optional(),
    })
    .default({ kind: "manual" }),
});
export type UnitPlan = z.infer<typeof UnitPlanSchema>;

/**
 * A stack (a.k.a. "line") is the vertical column of identical units — unit 08
 * on every floor. Chicago high-rises are numbered `<floor><line>`, which makes
 * the stack the natural unit of geometry: define it once, and every listing in
 * that line resolves for free.
 */
export const StackSchema = z.object({
  /** The line portion of the unit number, e.g. "08" in 3208. Keep leading zeros. */
  line: z.string().min(1),
  /** Footprint of the unit on the floor plate, metres, building frame. */
  polygon: z.array(PointSchema).min(3),
  /** Which unit plan this stack uses. */
  planId: z.string(),
  /** Floors on which this stack exists. Omit for "all floors of the plate". */
  floors: z
    .object({ from: z.number().int(), to: z.number().int() })
    .optional(),
  /**
   * Indices of `polygon` edges that are exterior wall (edge i runs from
   * vertex i to vertex i+1). Derived automatically when omitted.
   */
  exteriorEdges: z.array(z.number().int().min(0)).optional(),
});
export type Stack = z.infer<typeof StackSchema>;

export const FloorPlateSchema = z.object({
  buildingSlug: z.string(),
  /** Which floors this plate describes. A tower usually needs 1-3 plates. */
  floors: z.object({ from: z.number().int(), to: z.number().int() }),
  name: z.string().default("Typical floor"),
  /** The floor plate outline; normally equal to the massing at these floors. */
  outline: z.array(PointSchema).min(3),
  /** Elevator/stair core, drawn as a hole and excluded from every unit. */
  core: z.array(PointSchema).min(3).optional(),
  stacks: z.array(StackSchema).min(1),
  plans: z.array(UnitPlanSchema).default([]),
});
export type FloorPlate = z.infer<typeof FloorPlateSchema>;
