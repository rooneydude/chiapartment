import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { resolveUnitPlacement } from "../units/placement";
import { inferBuilding, type InferResult } from "./infer";

/**
 * Re-derive a building's geometry from whatever listing data is currently in
 * the database, store it, and stamp every unit with its resolved facing.
 *
 * Run after every scrape: each new listing sharpens the line vocabulary and
 * the floor range, so the massing gets more accurate the longer you track a
 * building rather than being a one-time guess.
 */
export function inferForBuilding(buildingSlug: string): InferResult {
  const db = getDb();

  const building = db
    .select()
    .from(schema.buildings)
    .where(eq(schema.buildings.slug, buildingSlug))
    .get();
  if (!building) throw new Error(`Unknown building "${buildingSlug}"`);

  // Every unit ever seen, not just the available ones — a leased unit still
  // proves its line and floor exist, which is exactly what the solver needs.
  const units = db
    .select()
    .from(schema.units)
    .where(eq(schema.units.buildingSlug, buildingSlug))
    .all();

  const plans = db
    .select()
    .from(schema.floorplans)
    .where(eq(schema.floorplans.buildingSlug, buildingSlug))
    .all();

  const result = inferBuilding({
    slug: buildingSlug,
    name: building.name,
    address: building.address ?? undefined,
    lat: building.lat,
    lng: building.lng,
    units: units.map((u) => ({
      unitCode: u.unitCode,
      floor: u.floor,
      line: u.line,
      sqft: u.sqft,
      bedrooms: u.bedrooms,
      planKey: u.floorplanId?.split(":").slice(1).join(":") ?? null,
    })),
    plans: plans.map((p) => ({
      key: p.id.split(":").slice(1).join(":"),
      name: p.name,
      bedrooms: p.bedrooms,
      bathrooms: p.bathrooms,
      sqft: p.sqft,
    })),
  });

  db.update(schema.buildings)
    .set({
      specJson: JSON.stringify(result.spec),
      plateJson: JSON.stringify(result.plate),
      specConfidence: result.confidence,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(schema.buildings.slug, buildingSlug))
    .run();

  // Denormalise each unit's facing so list views and filters don't have to
  // re-solve the geometry on every query.
  for (const u of units) {
    if (u.floor == null || u.line == null) continue;
    const placement = resolveUnitPlacement(
      result.spec,
      result.plate,
      { unitCode: u.unitCode, floor: u.floor, line: u.line },
      { sqft: u.sqft },
    );
    if (!placement) continue;
    db.update(schema.units)
      .set({ facingDeg: placement.facingDeg })
      .where(eq(schema.units.id, u.id))
      .run();
  }

  return result;
}
