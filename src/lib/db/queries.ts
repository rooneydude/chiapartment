import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from ".";
import { BuildingSpecSchema, type BuildingSpec } from "../massing/spec";
import { FloorPlateSchema, type FloorPlate } from "../floorplan/schema";
import { resolveUnitPlacement, type UnitPlacement } from "../units/placement";
import type { Unit } from "./schema";

/** A building with its geometry deserialized, when it has any. */
export interface BuildingWithGeometry {
  slug: string;
  name: string;
  address: string | null;
  neighborhood: string | null;
  websiteUrl: string | null;
  platform: string | null;
  lat: number | null;
  lng: number | null;
  specConfidence: string | null;
  spec: BuildingSpec | null;
  plate: FloorPlate | null;
}

export function listBuildings(): BuildingWithGeometry[] {
  const db = getDb();
  return db
    .select()
    .from(schema.buildings)
    .orderBy(asc(schema.buildings.name))
    .all()
    .map(hydrate);
}

export function getBuilding(slug: string): BuildingWithGeometry | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.buildings)
    .where(eq(schema.buildings.slug, slug))
    .get();
  return row ? hydrate(row) : null;
}

function hydrate(row: typeof schema.buildings.$inferSelect): BuildingWithGeometry {
  return {
    slug: row.slug,
    name: row.name,
    address: row.address,
    neighborhood: row.neighborhood,
    websiteUrl: row.websiteUrl,
    platform: row.platform,
    lat: row.lat,
    lng: row.lng,
    specConfidence: row.specConfidence,
    spec: parseOrNull(row.specJson, BuildingSpecSchema),
    plate: parseOrNull(row.plateJson, FloorPlateSchema),
  };
}

function parseOrNull<T>(
  json: string | null,
  schemaDef: { parse: (v: unknown) => T },
): T | null {
  if (!json) return null;
  try {
    return schemaDef.parse(JSON.parse(json));
  } catch {
    // A spec that no longer validates is a bug worth surfacing, but it must
    // not take the whole page down — the listing data is still useful.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export interface UnitFilters {
  status?: "available" | "leased";
  bedrooms?: number[];
  maxRent?: number;
  minSqft?: number;
  /** Only units whose primary exposure starts with one of these, e.g. ["S","E"]. */
  facing?: string[];
  minFloor?: number;
}

/** A listing joined to its physical placement in the building. */
export interface PlacedUnit {
  unit: Unit;
  placement: UnitPlacement | null;
  floorplanName: string | null;
}

export function listUnits(
  buildingSlug: string,
  filters: UnitFilters = {},
): PlacedUnit[] {
  const db = getDb();
  const conditions = [eq(schema.units.buildingSlug, buildingSlug)];
  if (filters.status) conditions.push(eq(schema.units.status, filters.status));
  if (filters.bedrooms?.length) {
    conditions.push(inArray(schema.units.bedrooms, filters.bedrooms));
  }
  if (filters.maxRent != null) {
    conditions.push(sql`${schema.units.rent} <= ${filters.maxRent}`);
  }
  if (filters.minSqft != null) {
    conditions.push(sql`${schema.units.sqft} >= ${filters.minSqft}`);
  }
  if (filters.minFloor != null) {
    conditions.push(sql`${schema.units.floor} >= ${filters.minFloor}`);
  }

  const rows = db
    .select({ unit: schema.units, floorplanName: schema.floorplans.name })
    .from(schema.units)
    .leftJoin(schema.floorplans, eq(schema.units.floorplanId, schema.floorplans.id))
    .where(and(...conditions))
    .orderBy(desc(schema.units.floor), asc(schema.units.line))
    .all();

  const building = getBuilding(buildingSlug);
  const placed = rows.map(({ unit, floorplanName }) => ({
    unit,
    floorplanName,
    placement: placeUnit(building, unit),
  }));

  if (!filters.facing?.length) return placed;
  const wanted = filters.facing.map((f) => f.toUpperCase());
  return placed.filter((p) =>
    p.placement?.exposures.some((e) => wanted.some((w) => e.point.startsWith(w))),
  );
}

export function getUnit(unitId: string): PlacedUnit | null {
  const db = getDb();
  const row = db
    .select({ unit: schema.units, floorplanName: schema.floorplans.name })
    .from(schema.units)
    .leftJoin(schema.floorplans, eq(schema.units.floorplanId, schema.floorplans.id))
    .where(eq(schema.units.id, unitId))
    .get();
  if (!row) return null;
  const building = getBuilding(row.unit.buildingSlug);
  return {
    unit: row.unit,
    floorplanName: row.floorplanName,
    placement: placeUnit(building, row.unit),
  };
}

function placeUnit(
  building: BuildingWithGeometry | null,
  unit: Unit,
): UnitPlacement | null {
  if (!building?.spec || !building.plate) return null;
  if (unit.floor == null || unit.line == null) return null;
  return resolveUnitPlacement(
    building.spec,
    building.plate,
    { unitCode: unit.unitCode, floor: unit.floor, line: unit.line },
    { sqft: unit.sqft },
  );
}

// ---------------------------------------------------------------------------
// Price history
// ---------------------------------------------------------------------------

export interface PricePoint {
  observedAt: number;
  rent: number | null;
  marketRent: number | null;
  status: string;
  availableOn: string | null;
}

/** Full observed history for one unit, oldest first. */
export function unitHistory(unitId: string): PricePoint[] {
  const db = getDb();
  return db
    .select({
      observedAt: schema.priceSnapshots.observedAt,
      rent: schema.priceSnapshots.rent,
      marketRent: schema.priceSnapshots.marketRent,
      status: schema.priceSnapshots.status,
      availableOn: schema.priceSnapshots.availableOn,
    })
    .from(schema.priceSnapshots)
    .where(eq(schema.priceSnapshots.unitId, unitId))
    .orderBy(asc(schema.priceSnapshots.observedAt), asc(schema.priceSnapshots.id))
    .all();
}

export interface TypePoint {
  observedAt: number;
  availableCount: number;
  minRent: number | null;
  medianRent: number | null;
  avgRent: number | null;
  maxRent: number | null;
  medianPpsfCents: number | null;
}

/** Time series for one bedroom count at one building. */
export function typeHistory(
  buildingSlug: string,
  bedrooms: number,
  sinceDays = 365,
): TypePoint[] {
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - sinceDays * 86_400;
  return db
    .select({
      observedAt: schema.typeSnapshots.observedAt,
      availableCount: schema.typeSnapshots.availableCount,
      minRent: schema.typeSnapshots.minRent,
      medianRent: schema.typeSnapshots.medianRent,
      avgRent: schema.typeSnapshots.avgRent,
      maxRent: schema.typeSnapshots.maxRent,
      medianPpsfCents: schema.typeSnapshots.medianPpsfCents,
    })
    .from(schema.typeSnapshots)
    .where(
      and(
        eq(schema.typeSnapshots.buildingSlug, buildingSlug),
        eq(schema.typeSnapshots.bedrooms, bedrooms),
        gte(schema.typeSnapshots.observedAt, since),
      ),
    )
    .orderBy(asc(schema.typeSnapshots.observedAt))
    .all();
}

export interface TypeSummary {
  bedrooms: number;
  label: string;
  availableCount: number;
  medianRent: number | null;
  minRent: number | null;
  avgSqft: number | null;
  medianPpsf: number | null;
  /** Change in median rent versus the oldest point inside the window. */
  changeVsWindow: number | null;
  windowDays: number;
}

/** Latest rollup per bedroom count, with the trend over `windowDays`. */
export function typeSummary(buildingSlug: string, windowDays = 30): TypeSummary[] {
  const db = getDb();
  const latest = db
    .select()
    .from(schema.typeSnapshots)
    .where(eq(schema.typeSnapshots.buildingSlug, buildingSlug))
    .orderBy(desc(schema.typeSnapshots.observedAt))
    .all();

  const seen = new Set<number>();
  const out: TypeSummary[] = [];
  for (const row of latest) {
    if (seen.has(row.bedrooms)) continue;
    seen.add(row.bedrooms);

    const history = typeHistory(buildingSlug, row.bedrooms, windowDays);
    const oldest = history.find((p) => p.medianRent != null);
    const change =
      oldest?.medianRent != null && row.medianRent != null
        ? row.medianRent - oldest.medianRent
        : null;

    out.push({
      bedrooms: row.bedrooms,
      label: bedroomLabel(row.bedrooms),
      availableCount: row.availableCount,
      medianRent: row.medianRent,
      minRent: row.minRent,
      avgSqft: row.avgSqft,
      medianPpsf: row.medianPpsfCents != null ? row.medianPpsfCents / 100 : null,
      changeVsWindow: change,
      windowDays,
    });
  }
  return out.sort((a, b) => a.bedrooms - b.bedrooms);
}

export function bedroomLabel(bedrooms: number): string {
  if (bedrooms === 0) return "Studio";
  if (bedrooms === 1) return "1 bed";
  return `${bedrooms} bed`;
}

/**
 * Cross-building comparison for a bedroom count — the "where is a 2-bed
 * cheapest right now" view.
 */
export function compareBuildings(bedrooms: number): Array<
  TypeSummary & { buildingSlug: string; buildingName: string }
> {
  const db = getDb();
  const buildingRows = db.select().from(schema.buildings).all();
  return buildingRows
    .flatMap((b) =>
      typeSummary(b.slug)
        .filter((t) => t.bedrooms === bedrooms)
        .map((t) => ({ ...t, buildingSlug: b.slug, buildingName: b.name })),
    )
    .sort((a, b) => (a.medianRent ?? Infinity) - (b.medianRent ?? Infinity));
}

export interface PriceChange {
  unitId: string;
  unitCode: string;
  buildingSlug: string;
  buildingName: string;
  bedrooms: number | null;
  observedAt: number;
  rent: number;
  previousRent: number;
  delta: number;
}

/**
 * Each unit's most recent rent move, newest first.
 *
 * Done as a window function rather than by pulling rows into JS: the previous
 * observation for a unit can be arbitrarily far back in the table, so any
 * approach that reads a fixed slice of recent rows and pairs them up silently
 * returns nothing once more than a handful of units are tracked.
 */
export function recentPriceChanges(limit = 50): PriceChange[] {
  const db = getDb();
  return db.all<PriceChange>(sql`
    WITH ranked AS (
      SELECT
        unit_id,
        observed_at,
        rent,
        LAG(rent) OVER (
          PARTITION BY unit_id ORDER BY observed_at, id
        ) AS previous_rent,
        ROW_NUMBER() OVER (
          PARTITION BY unit_id ORDER BY observed_at DESC, id DESC
        ) AS rn
      FROM price_snapshots
    )
    SELECT
      r.unit_id      AS unitId,
      u.unit_code    AS unitCode,
      u.building_slug AS buildingSlug,
      b.name         AS buildingName,
      u.bedrooms     AS bedrooms,
      r.observed_at  AS observedAt,
      r.rent         AS rent,
      r.previous_rent AS previousRent,
      r.rent - r.previous_rent AS delta
    FROM ranked r
    JOIN units u ON u.id = r.unit_id
    JOIN buildings b ON b.slug = u.building_slug
    WHERE r.rn = 1
      AND r.rent IS NOT NULL
      AND r.previous_rent IS NOT NULL
      AND r.rent <> r.previous_rent
    ORDER BY r.observed_at DESC, ABS(r.rent - r.previous_rent) DESC
    LIMIT ${limit}
  `);
}
