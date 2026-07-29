#!/usr/bin/env tsx
/**
 * Ingest a leasing agent's tour email.
 *
 *   npm run ingest -- --building the-leo --file email.txt
 *   pbpaste | npm run ingest -- --building the-leo
 *   npm run ingest -- --building the-leo --file email.txt --dry-run
 *
 * These emails carry two things nothing else does: what the rent actually
 * includes, and which way each unit faces. The facings become observations
 * that pin down the floor plate, so the massing is re-derived afterwards.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../src/lib/db";
import { parseAgentEmail, type UnitFact } from "../src/lib/ingest/email";
import { parseUnitCode } from "../src/lib/units/code";
import { inferForBuilding } from "../src/lib/massing/persist";
import { computeCost } from "../src/lib/pricing/effective";
import { compassPoint } from "../src/lib/geo";
import type { Charge } from "../src/lib/pricing/schema";

// Colour helpers are declared before the top-level main() call: they are
// consts, so using them from main() while still in the temporal dead zone
// throws before any output is produced.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = wrap("1");
const dim = wrap("2");
const red = wrap("31");
const green = wrap("32");
const yellow = wrap("33");

interface Args {
  building?: string;
  file?: string;
  source: string;
  dryRun: boolean;
  weight: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { source: "agent-email", dryRun: false, weight: 3 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--building" || t === "-b") a.building = argv[++i];
    else if (t === "--file" || t === "-f") a.file = argv[++i];
    else if (t === "--source") a.source = argv[++i];
    else if (t === "--weight") a.weight = Number(argv[++i] ?? 3);
    else if (t === "--dry-run") a.dryRun = true;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

main().catch((err) => {
  console.error(`\n${red("✖")} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

async function main() {
  if (!args.building) {
    console.log(
      [
        "Usage:",
        "  npm run ingest -- --building <slug> --file <email.txt>",
        "  pbpaste | npm run ingest -- --building <slug>",
        "",
        "Flags:",
        "  --source <name>  label for provenance (default: agent-email)",
        "  --weight <n>     confidence of the stated facings (default: 3)",
        "  --dry-run        print what would be written, change nothing",
      ].join("\n"),
    );
    process.exit(args.building ? 0 : 1);
  }

  const text = args.file ? readFileSync(args.file, "utf8") : readStdin();
  if (!text.trim()) throw new Error("No input. Pass --file or pipe the email in.");

  const db = getDb();
  const building = db
    .select()
    .from(schema.buildings)
    .where(eq(schema.buildings.slug, args.building))
    .get();
  if (!building) {
    throw new Error(
      `No building "${args.building}". Register it first: npm run scrape -- --add <url>`,
    );
  }

  const result = parseAgentEmail(text);
  console.log(`\n${bold(building.name)} ${dim(`← ${args.file ?? "stdin"}`)}`);
  if (result.buildingHint) console.log(dim(`  email mentions: ${result.buildingHint}`));

  // --- units --------------------------------------------------------------
  const knownLines = db
    .select({ line: schema.units.line })
    .from(schema.units)
    .where(eq(schema.units.buildingSlug, args.building))
    .all()
    .map((r) => r.line)
    .filter((l): l is string => !!l);

  console.log(`\n${bold("Units")}`);
  let facingCount = 0;
  for (const fact of result.units) {
    const parsed = parseUnitCode(fact.unitCode, [...new Set(knownLines)]);
    const line = parsed?.line ?? null;
    const facing =
      fact.facingDeg != null ? `${compassPoint(fact.facingDeg)} (${fact.facingDeg}°)` : "—";

    console.log(
      `  ${bold(pad(fact.unitCode, 8))}` +
        `${pad(parsed?.floor != null ? `fl ${parsed.floor}` : "fl ?", 8)}` +
        `${pad(line ? `line ${line}` : "line ?", 10)}` +
        `${pad(facing, 14)}` +
        `${pad(fact.rent != null ? `$${fact.rent.toLocaleString()}` : "—", 10)}` +
        `${fact.allInRent != null ? dim(`all-in $${fact.allInRent.toLocaleString()}`) : ""}`,
    );

    if (args.dryRun) continue;

    writeUnit(args.building!, fact, parsed?.floor ?? null, line);

    if (fact.facingDeg != null && line) {
      db.insert(schema.facingObservations)
        .values({
          buildingSlug: args.building!,
          line,
          unitCode: fact.unitCode,
          bearingDeg: fact.facingDeg,
          weight: args.weight,
          statement: fact.facingText ?? null,
          source: args.source,
        })
        .onConflictDoUpdate({
          target: [
            schema.facingObservations.buildingSlug,
            schema.facingObservations.line,
            schema.facingObservations.source,
          ],
          set: {
            bearingDeg: fact.facingDeg,
            unitCode: fact.unitCode,
            weight: args.weight,
            statement: fact.facingText ?? null,
          },
        })
        .run();
      facingCount++;
    }
  }

  // A stated base and all-in pair implies the utility charge outright.
  const implied = impliedUtilityCharge(result.units);
  const charges = implied ? [...result.charges, implied] : result.charges;

  // --- charges ------------------------------------------------------------
  if (charges.length) {
    console.log(`\n${bold("Charges")}`);
    for (const c of charges) {
      const amount = c.amount == null ? dim("varies") : `$${c.amount.toLocaleString()}`;
      const scope =
        c.appliesToPlanName ?? (c.appliesToBedrooms != null ? `${c.appliesToBedrooms}bd` : "all");
      console.log(
        `  ${pad(c.label, 34)}${pad(amount, 10)}${pad(c.cadence, 22)}` +
          `${pad(c.requirement, 13)}${dim(scope)}`,
      );
      if (!args.dryRun) writeCharge(args.building!, c, args.file ?? args.source);
    }
  } else {
    console.log(`\n${yellow("!")} No fee information found in this email.`);
  }

  for (const note of result.notes) console.log(dim(`\n  note: ${note}`));
  for (const w of result.warnings) console.log(`  ${yellow("!")} ${w}`);

  if (args.dryRun) {
    console.log(`\n${dim("Dry run — nothing written.")}`);
    return;
  }

  // --- re-derive ----------------------------------------------------------
  if (facingCount > 0) {
    try {
      const inferred = inferForBuilding(args.building);
      console.log(
        `\n${green("✔")} massing re-derived with ${facingCount} stated facing(s)`,
      );
      for (const n of inferred.notes) console.log(dim(`   · ${n}`));
    } catch (err) {
      console.log(`\n${yellow("!")} massing not re-derived: ${(err as Error).message}`);
    }
  }

  // --- worked example -----------------------------------------------------
  const sample = result.units.find((u) => u.rent != null);
  if (sample?.rent != null) {
    const cost = computeCost({
      rent: sample.rent,
      bedrooms: sample.bedrooms ?? null,
      planName: sample.planName ?? null,
      charges,
    });
    console.log(`\n${bold(`What unit ${sample.unitCode} actually costs`)}`);
    console.log(`  base rent                       $${sample.rent.toLocaleString()}`);
    for (const line of cost.required) {
      const v = line.monthly == null ? "varies" : `$${line.monthly.toLocaleString()}`;
      console.log(`  ${pad(line.label, 32)}${v}`);
    }
    if (cost.allInMonthly != null) {
      console.log(
        `  ${bold(pad("all-in monthly", 32))}${bold(`$${cost.allInMonthly.toLocaleString()}`)}` +
          (cost.hasVariableCharges ? dim("  + metered usage") : ""),
      );
    }
    if (cost.oneTimeTotal > 0) {
      console.log(dim(`  one-time on signing             $${cost.oneTimeTotal.toLocaleString()}`));
    }
  }
}

// ---------------------------------------------------------------------------

function writeUnit(
  buildingSlug: string,
  fact: UnitFact,
  floor: number | null,
  line: string | null,
) {
  const db = getDb();
  const id = `${buildingSlug}:${fact.unitCode}`;
  const now = Math.floor(Date.now() / 1000);

  db.insert(schema.units)
    .values({
      id,
      buildingSlug,
      unitCode: fact.unitCode,
      floor,
      line,
      wing: fact.wing ?? null,
      bedrooms: fact.bedrooms ?? null,
      sqft: fact.sqft ?? null,
      status: "available",
      rent: fact.rent ?? null,
      availableOn: fact.availableFrom ?? null,
      leaseTermMonths: fact.leaseMonths ?? null,
      listingUrl: fact.tourUrl ?? null,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: schema.units.id,
      set: {
        // An agent's numbers are better than a scraped page's, so they win —
        // but only where the email actually said something.
        ...(floor != null ? { floor } : {}),
        ...(line != null ? { line } : {}),
        ...(fact.wing ? { wing: fact.wing } : {}),
        ...(fact.bedrooms != null ? { bedrooms: fact.bedrooms } : {}),
        ...(fact.sqft != null ? { sqft: fact.sqft } : {}),
        ...(fact.rent != null ? { rent: fact.rent } : {}),
        ...(fact.availableFrom ? { availableOn: fact.availableFrom } : {}),
        ...(fact.leaseMonths != null ? { leaseTermMonths: fact.leaseMonths } : {}),
        lastSeenAt: now,
      },
    })
    .run();

  if (fact.rent != null) {
    db.insert(schema.priceSnapshots)
      .values({ unitId: id, rent: fact.rent, status: "available" })
      .run();
  }
}

function writeCharge(buildingSlug: string, charge: Charge, ref: string) {
  const db = getDb();
  db.insert(schema.charges)
    .values({
      buildingSlug,
      kind: charge.kind,
      label: charge.label,
      amount: charge.amount,
      cadence: charge.cadence,
      requirement: charge.requirement,
      appliesToBedrooms: charge.appliesToBedrooms,
      appliesToPlanName: charge.appliesToPlanName,
      includes: charge.includes.length ? JSON.stringify(charge.includes) : null,
      note: charge.note ?? null,
      sourceKind: "email",
      sourceRef: ref,
      observedAt: new Date().toISOString().slice(0, 10),
    })
    .onConflictDoNothing()
    .run();
}

/**
 * When an agent quotes both a base rent and an "all in" figure, the difference
 * is the required monthly charge — stated more precisely than any fee sheet.
 */
function impliedUtilityCharge(units: UnitFact[]): Charge | null {
  const gaps = units
    .filter((u) => u.rent != null && u.allInRent != null && u.allInRent > u.rent)
    .map((u) => u.allInRent! - u.rent!);
  if (gaps.length === 0) return null;

  // Only assert a flat charge when every quote agrees; otherwise it scales
  // with unit type and needs the per-type fee sheet instead.
  const first = gaps[0];
  if (!gaps.every((g) => g === first)) return null;

  return {
    kind: "utilities",
    label: "Bundled utilities (from quoted all-in)",
    amount: first,
    cadence: "monthly",
    requirement: "required",
    appliesToBedrooms: null,
    appliesToPlanName: null,
    includes: ["utilities"],
    note: "Derived from the agent quoting base rent and an all-in figure.",
    source: { kind: "email" },
  };
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? `${s} ` : s + " ".repeat(n - s.length);
}

