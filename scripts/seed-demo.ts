#!/usr/bin/env tsx
/**
 * Populate the database with synthetic buildings so the UI and the geometry
 * solver can be exercised without hitting anyone's website.
 *
 *   npm run seed:demo
 *
 * The data is fabricated. It is shaped like real Chicago rental stock — unit
 * numbers are <floor><line>, each line has consistent square footage, rent
 * rises with floor, and only a fraction of the building is listed at any
 * moment — but no number here came from a real listing.
 *
 * Two buildings, deliberately different, so the geometry solver and the
 * comparison view both get something to chew on: a slender point tower and a
 * wide mid-rise bar block.
 */
import { getDb, schema } from "../src/lib/db";
import { inferForBuilding } from "../src/lib/massing/persist";

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

interface BuildingSpecInput {
  slug: string;
  name: string;
  address: string;
  neighborhood: string;
  lat: number;
  lng: number;
  baseFloor: number;
  topFloor: number;
  /** Floors the building doesn't number. */
  skips: number[];
  /** Rent premium per floor above the base, dollars. */
  floorPremium: number;
  /** Share of units listed at any moment. */
  listedShare: number;
  lines: LineSpec[];
}

const BUILDINGS: BuildingSpecInput[] = [
  {
    slug: "demo-tower",
    name: "Demo Tower",
    address: "300 N Example St, Chicago, IL",
    neighborhood: "River North",
    lat: 41.8905,
    lng: -87.6335,
    baseFloor: 4,
    topFloor: 38,
    skips: [13],
    floorPremium: 22,
    listedShare: 0.2,
    // Eight lines: a point-tower plate with two corner 2-beds.
    lines: [
      { line: "01", bedrooms: 0, bathrooms: 1, sqft: 512, baseRent: 1795, planName: "Studio A" },
      { line: "02", bedrooms: 1, bathrooms: 1, sqft: 706, baseRent: 2195, planName: "One Bed A" },
      { line: "03", bedrooms: 1, bathrooms: 1, sqft: 742, baseRent: 2260, planName: "One Bed B" },
      { line: "04", bedrooms: 2, bathrooms: 2, sqft: 1148, baseRent: 3350, planName: "Two Bed Corner" },
      { line: "05", bedrooms: 1, bathrooms: 1, sqft: 698, baseRent: 2150, planName: "One Bed A" },
      { line: "06", bedrooms: 0, bathrooms: 1, sqft: 498, baseRent: 1745, planName: "Studio B" },
      { line: "07", bedrooms: 2, bathrooms: 2, sqft: 1102, baseRent: 3240, planName: "Two Bed" },
      { line: "08", bedrooms: 2, bathrooms: 2, sqft: 1215, baseRent: 3480, planName: "Two Bed Corner" },
    ],
  },
  {
    slug: "wells-street-lofts",
    name: "Wells Street Lofts",
    address: "1420 N Wells St, Chicago, IL",
    neighborhood: "Old Town",
    lat: 41.9088,
    lng: -87.6345,
    baseFloor: 2,
    topFloor: 12,
    skips: [],
    floorPremium: 14,
    listedShare: 0.26,
    // Fourteen lines across a long double-loaded corridor: a bar block, and
    // meaningfully cheaper than the tower so the comparison view has contrast.
    lines: [
      { line: "01", bedrooms: 0, bathrooms: 1, sqft: 545, baseRent: 1595, planName: "Loft Studio" },
      { line: "02", bedrooms: 1, bathrooms: 1, sqft: 688, baseRent: 1895, planName: "Loft One" },
      { line: "03", bedrooms: 1, bathrooms: 1, sqft: 705, baseRent: 1935, planName: "Loft One" },
      { line: "04", bedrooms: 1, bathrooms: 1, sqft: 730, baseRent: 1980, planName: "Loft One XL" },
      { line: "05", bedrooms: 2, bathrooms: 2, sqft: 1020, baseRent: 2795, planName: "Loft Two" },
      { line: "06", bedrooms: 2, bathrooms: 2, sqft: 1065, baseRent: 2860, planName: "Loft Two" },
      { line: "07", bedrooms: 0, bathrooms: 1, sqft: 520, baseRent: 1545, planName: "Loft Studio S" },
      { line: "08", bedrooms: 1, bathrooms: 1, sqft: 695, baseRent: 1905, planName: "Loft One" },
      { line: "09", bedrooms: 1, bathrooms: 1, sqft: 712, baseRent: 1950, planName: "Loft One" },
      { line: "10", bedrooms: 2, bathrooms: 2, sqft: 1105, baseRent: 2940, planName: "Loft Two XL" },
      { line: "11", bedrooms: 3, bathrooms: 2, sqft: 1385, baseRent: 3650, planName: "Loft Three" },
      { line: "12", bedrooms: 1, bathrooms: 1, sqft: 668, baseRent: 1860, planName: "Loft One S" },
      { line: "13", bedrooms: 0, bathrooms: 1, sqft: 505, baseRent: 1520, planName: "Loft Studio S" },
      { line: "14", bedrooms: 2, bathrooms: 2, sqft: 1042, baseRent: 2820, planName: "Loft Two" },
    ],
  },
];

const db = getDb();
const now = Math.floor(Date.now() / 1000);

// Deterministic pseudo-randomness keeps re-seeding reproducible.
let seed = 20260729;
function rand(): number {
  seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
  return seed / 4_294_967_296;
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

const summaryLines: string[] = [];

for (const b of BUILDINGS) {
  const seeded = seedBuilding(b);
  const result = inferForBuilding(b.slug);
  summaryLines.push(
    `\n${b.name} (${b.slug})`,
    `  ${seeded.length} units, ${seeded.length * dayOffsets.length} price snapshots`,
    `  Massing: ${result.spec.topFloor} floors, ${result.plate.stacks.length} lines, ` +
      `confidence=${result.confidence}`,
    ...result.notes.map((n) => `    · ${n}`),
  );
}

console.log(
  [
    `Seeded ${BUILDINGS.length} synthetic buildings.`,
    ...summaryLines,
    "",
    "Start the app with: npm run dev",
  ].join("\n"),
);

// ---------------------------------------------------------------------------

function seedBuilding(b: BuildingSpecInput): SeededUnit[] {
  db.insert(schema.buildings)
    .values({
      slug: b.slug,
      name: b.name,
      address: b.address,
      neighborhood: b.neighborhood,
      lat: b.lat,
      lng: b.lng,
      platform: "demo",
    })
    .onConflictDoUpdate({ target: schema.buildings.slug, set: { name: b.name } })
    .run();

  for (const spec of b.lines) {
    db.insert(schema.floorplans)
      .values({
        id: `${b.slug}:${planKey(spec.planName)}`,
        buildingSlug: b.slug,
        name: spec.planName,
        bedrooms: spec.bedrooms,
        bathrooms: spec.bathrooms,
        sqft: spec.sqft,
      })
      .onConflictDoNothing()
      .run();
  }

  const seeded: SeededUnit[] = [];

  for (let floor = b.baseFloor; floor <= b.topFloor; floor++) {
    if (b.skips.includes(floor)) continue;
    for (const spec of b.lines) {
      if (rand() >= b.listedShare) continue;

      const unitCode = `${floor}${spec.line}`;
      const id = `${b.slug}:${unitCode}`;
      const currentRent =
        spec.baseRent +
        (floor - b.baseFloor) * b.floorPremium +
        Math.round((rand() - 0.5) * 120);

      db.insert(schema.units)
        .values({
          id,
          buildingSlug: b.slug,
          unitCode,
          floor,
          line: spec.line,
          floorplanId: `${b.slug}:${planKey(spec.planName)}`,
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
        // Slight upward drift going back in time is a gentle decline forward.
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

  writeTypeRollups(b.slug, seeded);
  return seeded;
}

/**
 * Per-type rollups, computed from the same series. Written directly rather
 * than via rollUpByType() because the historical rows need the historical
 * rents, not today's.
 */
function writeTypeRollups(slug: string, seeded: SeededUnit[]) {
  const byBedrooms = new Map<number, SeededUnit[]>();
  for (const u of seeded) {
    const arr = byBedrooms.get(u.bedrooms) ?? [];
    arr.push(u);
    byBedrooms.set(u.bedrooms, arr);
  }

  for (const d of dayOffsets) {
    for (const [bedrooms, group] of byBedrooms) {
      const rents = group.map((u) => u.rentByDay.get(d)!).sort((a, b) => a - b);
      const ppsf = group.map((u) => (u.rentByDay.get(d)! / u.sqft) * 100);
      db.insert(schema.typeSnapshots)
        .values({
          buildingSlug: slug,
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
    }
  }
}

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
