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
  /** Display-only neighborhood tag (e.g. "Old Town"). */
  neighborhood: z.string().optional(),
  geometry: BuildingGeometrySchema,
  unitMapping: UnitMappingSchema.optional(),
});
export type BuildingConfig = z.infer<typeof BuildingConfigSchema>;

export const BuildingsConfigSchema = z.object({
  schemaVersion: z.literal(1),
  /** Bed counts the user actually shops for — the UI leads with these. */
  focus: z
    .object({
      beds: z.array(z.number().int().min(0).max(6)).min(1),
      /**
       * The lease length the owner compares prices at (default 12). View-time
       * only: where a site publishes a lease-term price table the UI can show
       * this term's price next to the advertised one. It never filters,
       * drops or re-prices anything at scrape time.
       */
      compareLeaseTermMonths: z.number().int().positive().optional(),
    })
    .optional(),
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

/** One row of a unit's lease-term price table: N-month lease → monthly rent. */
export const LeaseTermPriceSchema = z.object({
  months: z.number().int().positive(),
  price: z.number().positive(),
});
export type LeaseTermPrice = z.infer<typeof LeaseTermPriceSchema>;

export const UnitListingSchema = z.object({
  /** null when the site only lists floorplans with "starting at" prices. */
  unitNumber: z.string().nullable(),
  floorplanName: z.string(),
  /** 0 = studio */
  beds: z.number().int().min(0),
  /**
   * The site's own name for the unit type when it says more than the bed
   * count does: "Jr. 2 Bed", "1 Bed + Flex", "Convertible", "JR 1 Bedroom".
   * `beds` stays a plain number so filters and history keep working; this
   * keeps a junior 2-bed from passing for a full one.
   */
  planType: z.string().optional(),
  baths: z.number().nullable(),
  /** Interior living area. Outdoor (terrace) area goes in outdoorSqft. */
  sqft: z.number().nullable(),
  outdoorSqft: z.number().nonnegative().optional(),
  /**
   * Monthly USD BASE RENT — the rent the leasing site itself advertises for
   * this unit (so it can be checked against the website at a glance). When
   * the site ties that price to a lease length, leaseTermMonths says which.
   */
  price: z.number().positive(),
  /** Top of the site's advertised range, when it prints one. */
  priceMax: z.number().positive().optional(),
  /**
   * Mandatory monthly charges on top of base rent, when the site publishes
   * them (1225 Old Town: a $100–$230 utility bundle — the site headlines
   * rent + this). Usage-based and third-party costs are not included.
   */
  monthlyFees: z.object({ min: z.number().nonnegative(), max: z.number().nonnegative() }).optional(),
  /** Lease term (months) the advertised `price` applies to, when the site says. */
  leaseTermMonths: z.number().int().positive().nullable().optional(),
  /**
   * Every lease length the site offers for this unit and what each costs,
   * quoted for the unit's earliest move-in date (`availableDate`). Present
   * only where the site publishes it; sorted by months ascending.
   */
  leaseTerms: z.array(LeaseTermPriceSchema).optional(),
  /**
   * Earliest move-in day, YYYY-MM-DD (Chicago calendar). For a unit that can
   * be moved into today this is the scrape day and `availableNow` is true
   * (snapshots before 2026-11-15 have no flag, and The Leo's carried the
   * vacancy date here — `isAvailableNow` handles both). null = the site
   * gives no date.
   */
  availableDate: z.string().nullable(),
  /** The site says the unit can be moved into now (vs. on a future date). */
  availableNow: z.boolean().optional(),
  /** Day the unit became vacant, when the site says (a now-available unit). */
  vacantSince: z.string().optional(),
  /** Concession text, e.g. "1 month free on 13-month leases". */
  specials: z.string().optional(),
  /** Deep link to this unit on the leasing site, when there is one. */
  url: z.string().optional(),
  /**
   * When the SITE says it last edited this listing (ISO timestamp). Only
   * hand-maintained catalogues expose it (Stead 220); an old value means the
   * price is a stale "starting from" figure, however fresh our scrape is.
   */
  sourceUpdatedAt: z.string().optional(),
});
export type UnitListing = z.infer<typeof UnitListingSchema>;

/**
 * Something the site lists that cannot be compared as a regular unit: it has
 * no price ("Contact for Pricing", waitlist plans) or the site publishes no
 * bed count for it (townhome / penthouse plans). Recorded so the dashboard
 * can still show that it exists — the tracker must never look emptier than
 * the leasing site.
 */
export const AlsoListedSchema = z.object({
  unitNumber: z.string().nullable(),
  floorplanName: z.string(),
  /** null when the site does not say. */
  beds: z.number().int().min(0).nullable(),
  baths: z.number().nullable().optional(),
  sqft: z.number().nullable().optional(),
  outdoorSqft: z.number().nonnegative().optional(),
  /** Present when the site does print a price (the row is here for another reason). */
  price: z.number().positive().optional(),
  priceMax: z.number().positive().optional(),
  availableDate: z.string().nullable().optional(),
  availableNow: z.boolean().optional(),
  /** Why it is not a regular listing, in the site's words where possible. */
  note: z.string(),
  url: z.string().optional(),
});
export type AlsoListed = z.infer<typeof AlsoListedSchema>;

/**
 * HISTORICAL ONLY (8 Sep – 14 Nov 2026): a unit the scraper saw but dropped
 * because of the since-removed lease-term cap. Nothing writes this any more —
 * every unit a site lists is recorded — but old snapshots carry it, so the
 * schema must keep parsing it.
 */
export const OmittedListingSchema = z.object({
  unitNumber: z.string().nullable(),
  floorplanName: z.string(),
  beds: z.number().int().min(0),
  baths: z.number().nullable().optional(),
  sqft: z.number().nullable().optional(),
  advertisedPrice: z.number().positive(),
  leaseTermMonths: z.number().int().positive(),
  reason: z.literal("over-cap").default("over-cap"),
});
export type OmittedListing = z.infer<typeof OmittedListingSchema>;

export const BuildingSnapshotSchema = z.object({
  buildingId: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  source: z.object({ adapter: z.string(), fetchedUrl: z.string() }),
  units: z.array(UnitListingSchema),
  /** Historical only — see OmittedListingSchema. */
  omitted: z.array(OmittedListingSchema).optional(),
  /** Listed on the site but not comparable (no price / no bed count). */
  alsoListed: z.array(AlsoListedSchema).optional(),
  /** Building-wide notices the site prints (specials, concessions). */
  notices: z.array(z.string()).optional(),
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
  /** Lease term (months) that price was quoted for, when the site said. */
  term?: number;
}

export interface FloorplanPoint {
  t: string;
  minPrice: number;
  avgPrice: number;
  count: number;
}

export interface PriceChange {
  /**
   * Display identity: real unit number, or the floorplan name for stack /
   * starting-at listings that have no unit number (Stead 220).
   */
  unitNumber: string;
  floorplanName: string;
  from: number;
  to: number;
  beds: number;
  /**
   * Lease terms the two prices were quoted for, when known. A change is
   * like-for-like when they match (or the site gives no term at all).
   */
  fromTerm?: number;
  toTerm?: number;
  /**
   * Set when `from` and `to` are not like for like, so this is NOT a real
   * price move and must never be alerted on:
   *   "lease-term" — the site headlines a different lease length now and no
   *                  same-length comparison was possible;
   *   "price-form" — one run printed a rent range, the other a single price
   *                  (Old Town Park alternates between two pricing states).
   */
  notComparable?: "lease-term" | "price-form";
}

/** A unit whose earliest move-in day changed between two runs. */
export interface DateChange {
  unitNumber: string;
  floorplanName: string;
  beds: number;
  from: string | null;
  to: string | null;
}

export interface SnapshotDelta {
  from: string | null;
  to: string;
  newUnits: UnitListing[];
  removedUnits: UnitListing[];
  priceChanges: PriceChange[];
  /** Move-in date moves (future ↔ future, or future → now). Additive. */
  dateChanges?: DateChange[];
}

/** Calendar-day, focus-bed slice of a delta — weekday-brief input. */
export interface FocusDelta extends SnapshotDelta {
  chicagoFrom: string | null;
  chicagoTo: string;
  focusBeds: number[];
}

export interface BriefListing {
  label: string;
  unitNumber: string | null;
  floorplanName: string;
  beds: number;
  /** The site's unit-type label when it differs from the bed count ("Jr. 2 Bed"). */
  planType?: string;
  /** Advertised base rent. */
  price: number;
  priceMax?: number;
  /** Mandatory monthly charges on top of base rent, when published. */
  monthlyFees?: { min: number; max: number };
  availableDate: string | null;
  availableNow?: boolean;
  vacantSince?: string;
  leaseTermMonths?: number | null;
  leaseTerms?: LeaseTermPrice[];
  sqft?: number | null;
  url?: string;
}

export interface BriefDrop {
  label: string;
  unitNumber: string | null;
  floorplanName: string;
  beds: number;
  from: number;
  to: number;
  /** Lease term both prices are quoted for, when known. */
  leaseTermMonths?: number;
}

export interface BriefOmitted {
  label: string;
  unitNumber: string | null;
  floorplanName: string;
  beds: number;
  advertisedPrice: number;
  leaseTermMonths: number;
  reason: "over-cap";
}

export interface WeekdayBriefBuilding {
  id: string;
  name: string;
  status: "ok" | "error" | "missing";
  error?: string;
  from: string | null;
  to: string | null;
  chicagoFrom: string | null;
  chicagoTo: string | null;
  focusAvailable: number;
  new: BriefListing[];
  removed: BriefListing[];
  drops: BriefDrop[];
  omitted: BriefOmitted[];
  warnings: DataWarning[];
  /**
   * Every focus-bed listing currently on the market, with its move-in date,
   * advertised lease term and (where published) lease-term price table — so a
   * reader of brief.json needs nothing else. Additive.
   */
  listings?: BriefListing[];
  /** Timestamp of the scrape `listings` came from (last good one on error). */
  listingsAsOf?: string | null;
  /** Focus-bed units whose earliest move-in day moved since the prior day. */
  dateChanges?: DateChange[];
  /** Listed on the site but not comparable (no price / no bed count). */
  alsoListed?: AlsoListed[];
  /** Building-wide notices the site prints (specials). */
  notices?: string[];
}

export interface WeekdayBrief {
  schemaVersion: 1;
  timezone: "America/Chicago";
  generated: string;
  focusBeds: number[];
  chicagoFrom: string | null;
  chicagoTo: string | null;
  summary: {
    drops: number;
    newListings: number;
    removed: number;
    scrapeErrors: number;
    /** Historical; always 0 since the lease-term cap was removed. */
    omittedOverCap: number;
    /** Focus-bed listings on the market across all buildings. */
    focusAvailable?: number;
    /** …of which can be moved into now. */
    availableNow?: number;
    moveInDateChanges?: number;
  };
  buildings: WeekdayBriefBuilding[];
}

export interface DataWarning {
  code: "scrape-error" | "empty-run" | "price-jump" | "count-drop" | "partial-data";
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
  /**
   * unitNumber → first time (and price at which) the unit was ever listed.
   * Floorplan / stack listings without a unit number are keyed by their
   * listing key ("fp:<beds>:<floorplanName>"). `firstTerm` is the lease
   * length that first price was quoted for, when the site said — needed to
   * compare "since first listing" like for like.
   */
  perUnitMeta: Record<string, { firstSeen: string; firstPrice: number; firstTerm?: number }>;
  /** Data-sanity alarms for the latest state of this building. */
  warnings: DataWarning[];
  /** Timestamps of every snapshot run that included this building (ok only). */
  runs: string[];
  /** Most recent scrape attempt, including failures. Null if never scraped. */
  lastAttempt: {
    timestamp: string;
    status: "ok" | "error";
    error?: string;
  } | null;
  /**
   * Calendar-day diff on focus.beds (Chicago timezone). Additive field for
   * the weekday Grok brief; `delta` remains last-two-ok-runs unfiltered.
   */
  focusDelta: FocusDelta | null;
  /** Historical: over-cap units skipped on the latest ok scrape. Empty since the cap was removed. */
  omitted: OmittedListing[];
  /** Listed but not comparable on the latest ok scrape (no price / no bed count). */
  alsoListed: AlsoListed[];
  /** Building-wide notices (specials) from the latest ok scrape. */
  notices: string[];
}

/** Shape of the compiled config.json (buildings.json + build-time health). */
export type CompiledConfig = BuildingsConfig & {
  health?: {
    generated: string;
    /** buildingId → warning count for dashboard badges. */
    buildings: Record<string, number>;
    /** How many snapshot files were compiled. */
    snapshots?: number;
    /** Snapshot files that failed schema validation and were left out. */
    skippedSnapshots?: string[];
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

/** v2: flat ground areas — water bodies and parks (local meters). */
export interface SkylineAreaFeature {
  type: "Feature";
  properties: { kind: "water" | "park"; name?: string };
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
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

export type AnySkylineFeature =
  | SkylineFeature
  | SkylineAreaFeature
  | SkylineLineFeature
  | SkylinePointFeature;

export function isBuildingFeature(f: AnySkylineFeature): f is SkylineFeature {
  // Water/park areas are Polygons too — buildings are the ones with a height.
  return f.geometry.type === "Polygon" && "height" in f.properties;
}

export function isAreaFeature(f: AnySkylineFeature): f is SkylineAreaFeature {
  return f.geometry.type === "Polygon" && !("height" in f.properties);
}

export function isLineFeature(f: AnySkylineFeature): f is SkylineLineFeature {
  return f.geometry.type === "LineString";
}

export function isStationFeature(f: AnySkylineFeature): f is SkylinePointFeature {
  return f.geometry.type === "Point";
}

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
    /** Where the pixel scale came from — SightMap's zoom is not always honest. */
    scaleSource: "georeference" | "footprint-fit";
    /** Translation snap applied to align with the OSM footprint (meters E/N). */
    translationCorrectionM: [number, number];
    /** Worst distance of any unit centroid outside the footprint ring. */
    residualM: number;
  };
  /** unitNumber → position. Accumulates across runs (merge, never overwrite). */
  units: Record<string, UnitPositionEntry>;
}
