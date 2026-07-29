#!/usr/bin/env tsx
/**
 * Re-derive building geometry from the listing data already in the database.
 *
 *   npm run infer -- --all
 *   npm run infer -- fulbrix
 *
 * Useful after editing the solver, or after a scrape that added new lines.
 */
import { getDb, schema } from "../src/lib/db";
import { inferForBuilding } from "../src/lib/massing/persist";
import { resolveUnitPlacement } from "../src/lib/units/placement";
import { eq } from "drizzle-orm";

const argv = process.argv.slice(2);
const all = argv.includes("--all");
const verbose = argv.includes("--verbose") || argv.includes("-v");
const slug = argv.find((a) => !a.startsWith("-"));

const db = getDb();
const targets = all
  ? db.select({ slug: schema.buildings.slug }).from(schema.buildings).all().map((b) => b.slug)
  : slug
    ? [slug]
    : [];

if (targets.length === 0) {
  console.log("Usage: npm run infer -- <building-slug> | --all [-v]");
  process.exit(0);
}

let failures = 0;
for (const target of targets) {
  try {
    const result = inferForBuilding(target);
    console.log(
      `\n${target}: ${result.spec.topFloor} floors, ${result.plate.stacks.length} lines, ` +
        `confidence=${result.confidence}`,
    );
    for (const note of result.notes) console.log(`  · ${note}`);

    if (verbose) {
      console.log("\n  line   facing        sqft   frontage");
      for (const stack of result.plate.stacks) {
        const placement = resolveUnitPlacement(
          result.spec,
          result.plate,
          { unitCode: `X${stack.line}`, floor: result.spec.topFloor, line: stack.line },
        );
        if (!placement) continue;
        console.log(
          `  ${stack.line.padEnd(6)} ${placement.exposureLabel.padEnd(14)}` +
            `${String(placement.areaSqft).padStart(5)}  ` +
            `${placement.exposures[0]?.lengthM.toFixed(1) ?? "-"} m`,
        );
      }
    }
  } catch (err) {
    failures++;
    console.error(`\n${target}: ${(err as Error).message}`);
  }
}

if (failures > 0) process.exit(1);
