import { z } from "zod";

// ---------------------------------------------------------------------------
// Config (buildings.json)
// ---------------------------------------------------------------------------

export const FacingSchema = z.enum(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);
export type Facing = z.infer<typeof FacingSchema>;

/**
 * How to derive a unit's floor + horizontal position from its unit number.
 * `stacks` maps a stack (e.g. the trailing "14" of unit 2314) to a facade
 * facing and a fraction 0..1 along that facade. It can be filled incrementally
 * per building — everything degrades gracefully when data is missing.
 */
export const UnitMappingSchema = z.object({
  scheme: z.enum(["floor-prefix", "regex", "none"]).default("floor-prefix"),
  /** floor-prefix scheme: how many trailing digits form the stack. */
  stackDigits: z.number().int().min(1).max(3).default(2),
  /** regex scheme: pattern with named groups (?<floor>...) and optional (?<stack>...). */
  regex: z.string().optional(),
  /**
   * When floorplans ARE stacks (e.g. Stead 220's "Large Studio - Unit 01"),
   * a regex whose first capture group extracts the stack from the plan name.
   */
  stackFromPlanRegex: z.string().optional(),
  /** Added to the parsed floor (e.g. numbering starts above a podium). */
  floorOffset: z.number().int().default(0),
  stacks: z
    .record(z.object({ facing: FacingSchema, u: z.number().min(0).max(1) }))
    .default({}),
  defaultFacing: FacingSchema.optional(),
});
export type UnitMapping = z.infer<typeof UnitMappingSchema>;

export const BuildingGeometrySchema = z.object({
  floors: z.number().int().positive(),
  floorHeightM: z.number().positive().default(3.2),
  /** Extra height of lobby/retail podium below floor 1 residences. */
  groundFloorOffsetM: z.number().min(0).default(0),
  /** OSM way id whose footprint (from skyline.geojson) is this building. */
  osmWayId: z.number().int().optional(),
  /** Fallback footprint ring as [lon, lat] pairs when no OSM match. */
  footprint: z.array(z.tuple([z.number(), z.number()])).min(3).optional(),
  /** Fallback box dimensions when neither osmWayId nor footprint exist. */
  fallbackWidthM: z.number().positive().default(35),
  fallbackDepthM: z.number().positive().default(25),
});
export type BuildingGeometry = z.infer<typeof BuildingGeometrySchema>;

export const BuildingConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  address: z.string(),
  lat: z.number(),
  lon: z.number(),
  /** Leasing / availability page. */
  url: z.string().url(),
  /** Adapter registry key (scraper/src/adapters). */
  adapter: z.string(),
  adapterOptions: z.record(z.unknown()).optional(),
  /** Towers of one complex share a group (and one leasing source). */
  group: z.string().optional(),
  geometry: BuildingGeometrySchema,
  unitMapping: UnitMappingSchema.optional(),
});
export type BuildingConfig = z.infer<typeof BuildingConfigSchema>;

export const BuildingsConfigSchema = z.object({
  schemaVersion: z.literal(1),
  skyline: z
    .object({
      /** Radius around each building cluster to include in the skyline. */
      clusterRadiusM: z.number().positive().default(800),
      /** Within this distance of a tracked building keep even short buildings. */
      nearRadiusM: z.number().positive().default(250),
      minHeightNearM: z.number().min(0).default(4),
      minHeightFarM: z.number().min(0).default(20),
    })
    .default({}),
  buildings: z.array(BuildingConfigSchema).min(1),
});
export type BuildingsConfig = z.infer<typeof BuildingsConfigSchema>;

// ---------------------------------------------------------------------------
// Scrape output (data/snapshots/*.json)
// ---------------------------------------------------------------------------

export const UnitListingSchema = z.object({
  /** null when the site only lists floorplans with "starting at" prices. */
  unitNumber: z.string().nullable(),
  floorplanName: z.string(),
  /** 0 = studio */
  beds: z.number().int().min(0),
  baths: z.number().nullable(),
  sqft: z.number().nullable(),
  /** Monthly USD; lowest advertised. */
  price: z.number().positive(),
  priceMax: z.number().positive().optional(),
  availableDate: z.string().nullable(),
  /** Concession text, e.g. "1 month free on 13-month leases". */
  specials: z.string().optional(),
  url: z.string().optional(),
});
export type UnitListing = z.infer<typeof UnitListingSchema>;

export const BuildingSnapshotSchema = z.object({
  buildingId: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  source: z.object({ adapter: z.string(), fetchedUrl: z.string() }),
  units: z.array(UnitListingSchema),
});
export type BuildingSnapshot = z.infer<typeof BuildingSnapshotSchema>;

export const SnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  /** ISO 8601 UTC */
  timestamp: z.string(),
  buildings: z.array(BuildingSnapshotSchema),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ---------------------------------------------------------------------------
// Compiled frontend data (generated by build-data, never committed)
// ---------------------------------------------------------------------------

export interface PricePoint {
  t: string;
  price: number;
}

export interface FloorplanPoint {
  t: string;
  minPrice: number;
  avgPrice: number;
  count: number;
}

export interface PriceChange {
  unitNumber: string;
  floorplanName: string;
  from: number;
  to: number;
}

export interface SnapshotDelta {
  from: string | null;
  to: string;
  newUnits: UnitListing[];
  removedUnits: UnitListing[];
  priceChanges: PriceChange[];
}

export interface DataWarning {
  code: "scrape-error" | "empty-run" | "price-jump" | "count-drop";
  message: string;
}

export interface BuildingHistory {
  buildingId: string;
  latest: { timestamp: string; units: UnitListing[] } | null;
  delta: SnapshotDelta | null;
  /** unitNumber → price series */
  perUnit: Record<string, PricePoint[]>;
  /** floorplanName → aggregate series */
  perFloorplan: Record<string, FloorplanPoint[]>;
  /** unitNumber → first time (and price at which) the unit was ever listed. */
  perUnitMeta: Record<string, { firstSeen: string; firstPrice: number }>;
  /** Data-sanity alarms for the latest state of this building. */
  warnings: DataWarning[];
  /** Timestamps of every snapshot run that included this building (ok only). */
  runs: string[];
}

/** Shape of the compiled config.json (buildings.json + build-time health). */
export type CompiledConfig = BuildingsConfig & {
  health?: {
    generated: string;
    /** buildingId → warning count for dashboard badges. */
    buildings: Record<string, number>;
  };
};

// ---------------------------------------------------------------------------
// Skyline (data/skyline.geojson) — coordinates are LOCAL METERS around
// meta.origin, NOT lon/lat. Internal format; do not feed to GIS tools.
// ---------------------------------------------------------------------------

export interface SkylineFeatureProperties {
  osmId: number;
  height: number;
  minHeight: number;
  levels?: number;
  name?: string;
  /** Set when this footprint is one of the tracked buildings. */
  trackedId?: string;
}

export interface SkylineFeature {
  type: "Feature";
  properties: SkylineFeatureProperties;
  geometry: {
    type: "Polygon";
    /** [x east, y north] in meters relative to meta.origin. */
    coordinates: [number, number][][];
  };
}

/** v2: streets and rail lines (local meters). */
export interface SkylineLineFeature {
  type: "Feature";
  properties: { kind: "road" | "rail"; class: string; name?: string };
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

/** v2: transit stations (local meters). */
export interface SkylinePointFeature {
  type: "Feature";
  properties: { kind: "station"; name?: string; station?: string };
  geometry: { type: "Point"; coordinates: [number, number] };
}

export type AnySkylineFeature = SkylineFeature | SkylineLineFeature | SkylinePointFeature;

export interface SkylineCollection {
  type: "FeatureCollection";
  meta: {
    origin: { lat: number; lon: number };
    generated: string;
    bboxes: [number, number, number, number][]; // [s, w, n, e] in lon/lat
    /** Absent = v1 (buildings only). 2 = adds roads/rail/stations. */
    schemaVersion?: 2;
  };
  features: AnySkylineFeature[];
}

// ---------------------------------------------------------------------------
// Unit-position sidecar (data/unitmaps/<id>.json) — exact unit locations
// derived from a georeferenced floorplate source (e.g. SightMap).
// Coordinates are WGS84 lon/lat so the file survives skyline-origin changes;
// the web projects them with makeProjector(skyline.meta.origin) at load.
// ---------------------------------------------------------------------------

export interface UnitPositionEntry {
  lon: number;
  lat: number;
  facing?: Facing;
  levelIndex?: number;
}

export interface UnitMapSidecar {
  schemaVersion: 1;
  buildingId: string;
  source: { sightmapId: string; assetUrl: string; capturedAt: string };
  fit: {
    metersPerPixel: number;
    bearingDeg: number;
    /** Translation snap applied to align with the OSM footprint (meters E/N). */
    translationCorrectionM: [number, number];
    /** Worst distance of any unit centroid outside the footprint ring. */
    residualM: number;
    anchor: "center" | "top-left";
  };
  /** unitNumber → position. Accumulates across runs (merge, never overwrite). */
  units: Record<string, UnitPositionEntry>;
}
