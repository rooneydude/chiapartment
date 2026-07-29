#!/usr/bin/env tsx
/**
 * Populate the database with a synthetic building so the UI and the geometry
 * solver can be exercised without hitting anyone's website.
 *
 *   npm run seed:demo
 *
 * The data is fabricated. It is shaped like a real Chicago high-rise — unit
 * numbers are <floor><line>, each line has consistent square footage, rent
 * rises with floor, and about a fifth of the building is listed at any moment
 * — but no number here came from a real listing, and the UI labels it as
 * synthetic wherever it appears.
 */
import { getDb, schema } from "../src/lib/db";
import { inferForBuilding } from "../src/lib/massing/persist";

const DEMO_SLUG = "demo-tower";
const TOP_FLOOR = 38;
const BASE_FLOOR = 4;
/** Rent premium per floor above the base, dollars. */
const FLOOR_PREMIUM = 22;
const HISTORY_DAYS = 60;
const HISTORY_STEP_DAYS = 3;

interface LineSpec {
  line: string;
  bedrooms: number;
  bathrooms: number;
  sqft: number;
  baseRent: number;
  planName: string;
}

/** Eight lines: a plausible point-tower plate with two corner 2-beds. */
const LINES: LineSpec[] = [
  { line: "01", bedrooms: 0, bathrooms: 1, sqft: 512, baseRent: 1795, planName: "Studio A" },
  { line: "02", bedrooms: 1, bathrooms: 1, sqft: 706, baseRent: 2195, planName: "One Bed A" },
  { line: "03", bedrooms: 1, bathrooms: 1, sqft: 742, baseRent: 2260, planName: "One Bed B" },
  { line: "04", bedrooms: 2, bathrooms: 2, sqft: 1148, baseRent: 3350, planName: "Two Bed Corner" },
  { line: "05", bedrooms: 1, bathrooms: 1, sqft: 698, baseRent: 2150, planName: "One Bed A" },
  { line: "06", bedrooms: 0, bathrooms: 1, sqft: 498, baseRent: 1745, planName: "Studio B" },
  { line: "07", bedrooms: 2, bathrooms: 2, sqft: 1102, baseRent: 3240, planName: "Two Bed" },
  { line: "08", bedrooms: 2, bathrooms: 2, sqft: 1215, baseRent: 3480, planName: "Two Bed Corner" },
];

const db = getDb();
const now = Math.floor(Date.now() / 1000);

// Deterministic pseudo-randomness keeps re-seeding reproducible.
let seed = 20260729;
function rand(): number {
  seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
  return seed / 4_294_967_296;
}

db.insert(schema.buildings)
  .values({
    slug: DEMO_SLUG,
    name: "Demo Tower",
    address: "300 N Example St, Chicago, IL",
    neighborhood: "River North",
    lat: 41.8905,
    lng: -87.6335,
    platform: "demo",
  })
  .onConflictDoUpdate({ target: schema.buildings.slug, set: { name: "Demo Tower" } })
  .run();

for (const spec of LINES) {
  db.insert(schema.floorplans)
    .values({
      id: `${DEMO_SLUG}:${planKey(spec.planName)}`,
      buildingSlug: DEMO_SLUG,
      name: spec.planName,
      bedrooms: spec.bedrooms,
      bathrooms: spec.bathrooms,
      sqft: spec.sqft,
    })
    .onConflictDoNothing()
    .run();
}

/** Day offsets to generate, oldest first. */
const dayOffsets: number[] = [];
for (let d = HISTORY_DAYS; d >= 0; d -= HISTORY_STEP_DAYS) dayOffsets.push(d);

interface SeededUnit {
  id: string;
  bedrooms: number;
  sqft: number;
  /** Rent by day offset. */
  rentByDay: Map<number, number>;
}
const seeded: SeededUnit[] = [];

for (let floor = BASE_FLOOR; floor <= TOP_FLOOR; floor++) {
  if (floor === 13) continue; // The building skips 13, as most towers do.
  for (const spec of LINES) {
    // Only about a fifth of a building is on the market at any moment.
    if (rand() >= 0.2) continue;

    const unitCode = `${floor}${spec.line}`;
    const id = `${DEMO_SLUG}:${unitCode}`;
    const currentRent =
      spec.baseRent +
      (floor - BASE_FLOOR) * FLOOR_PREMIUM +
      Math.round((rand() - 0.5) * 120);

    db.insert(schema.units)
      .values({
        id,
        buildingSlug: DEMO_SLUG,
        unitCode,
        floor,
        line: spec.line,
        floorplanId: `${DEMO_SLUG}:${planKey(spec.planName)}`,
        bedrooms: spec.bedrooms,
        bathrooms: spec.bathrooms,
        sqft: spec.sqft,
        status: "available",
        rent: currentRent,
        availableOn: isoDaysFromNow(Math.floor(rand() * 75)),
        leaseTermMonths: 12,
      })
      .onConflictDoUpdate({
        target: schema.units.id,
        set: { rent: currentRent, status: "available", lastSeenAt: now },
      })
      .run();

    // Walk backwards from today so the series ends exactly on the live rent.
    const rentByDay = new Map<number, number>();
    let rent = currentRent;
    for (const d of [...dayOffsets].reverse()) {
      rentByDay.set(d, rent);
      // Slight upward drift going back in time means a gentle decline forward.
      rent += Math.round((rand() - 0.42) * 45);
    }

    for (const d of dayOffsets) {
      db.insert(schema.priceSnapshots)
        .values({
          unitId: id,
          observedAt: now - d * 86_400,
          rent: rentByDay.get(d)!,
          status: "available",
          leaseTermMonths: 12,
        })
        .run();
    }

    seeded.push({ id, bedrooms: spec.bedrooms, sqft: spec.sqft, rentByDay });
  }
}

// --- per-type rollup, computed from the same series ------------------------
// Written directly rather than via rollUpByType() because the historical rows
// need the historical rents, not today's.
let typeRows = 0;
for (const d of dayOffsets) {
  const byBedrooms = new Map<number, SeededUnit[]>();
  for (const u of seeded) {
    const arr = byBedrooms.get(u.bedrooms) ?? [];
    arr.push(u);
    byBedrooms.set(u.bedrooms, arr);
  }
  for (const [bedrooms, group] of byBedrooms) {
    const rents = group.map((u) => u.rentByDay.get(d)!).sort((a, b) => a - b);
    const ppsf = group.map((u) => (u.rentByDay.get(d)! / u.sqft) * 100);
    db.insert(schema.typeSnapshots)
      .values({
        buildingSlug: DEMO_SLUG,
        bedrooms,
        observedAt: now - d * 86_400,
        availableCount: group.length,
        minRent: rents[0],
        medianRent: Math.round(median(rents)),
        avgRent: Math.round(rents.reduce((a, b) => a + b, 0) / rents.length),
        maxRent: rents.at(-1)!,
        avgSqft: Math.round(group.reduce((a, u) => a + u.sqft, 0) / group.length),
        medianPpsfCents: Math.round(median(ppsf)),
      })
      .run();
    typeRows++;
  }
}

const result = inferForBuilding(DEMO_SLUG);

console.log(
  [
    `Seeded ${seeded.length} units, ${seeded.length * dayOffsets.length} price snapshots, ` +
      `${typeRows} type rollups for "${DEMO_SLUG}".`,
    `Massing: ${result.spec.topFloor} floors, ${result.plate.stacks.length} lines, ` +
      `confidence=${result.confidence}`,
    ...result.notes.map((n) => `  · ${n}`),
    "",
    "Start the app with: npm run dev",
  ].join("\n"),
);

function planKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
