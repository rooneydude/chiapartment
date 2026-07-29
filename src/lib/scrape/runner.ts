import * as cheerio from "cheerio";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { parseUnitCode } from "../units/code";
import { createFetcher, type Fetcher } from "./http";
import { detectPlatform } from "./fingerprint";
import { inferForBuilding } from "../massing/persist";
import { detectAdapter, getAdapter } from "./registry";
import { planKey as toPlanKey } from "./parse";
import type { ScrapeContext, ScrapeResult } from "./types";

export const FLOORPLAN_DIR =
  process.env.CHIAPARTMENT_FLOORPLANS ?? resolve("data/floorplans");

export interface RunOptions {
  /** Force a specific adapter instead of detecting one. */
  adapterId?: string;
  /** Serve pages from the disk cache when younger than this. */
  cacheMaxAgeSec?: number;
  /** Parse only; write nothing to the database. */
  dryRun?: boolean;
  /** Skip downloading floor plan images. */
  skipImages?: boolean;
  /**
   * Re-derive the building's geometry once the listings are in. On by default:
   * every scrape adds lines and floors, so the massing is only correct if it
   * is refreshed alongside the data it is derived from.
   */
  inferGeometry?: boolean;
  log?: (msg: string) => void;
}

export interface RunSummary {
  sourceSlug: string;
  buildingSlug: string;
  adapter: string;
  platform: string;
  unitsFound: number;
  unitsChanged: number;
  unitsDelisted: number;
  plansFound: number;
  imagesDownloaded: number;
  warnings: string[];
  /** Units whose label could not be split into floor + line. */
  unparsedUnitCodes: string[];
  /** Notes from the geometry solver, when it ran. */
  geometryNotes: string[];
}

/**
 * Fetch one source, parse it, and fold the result into the database.
 *
 * The write path is deliberately conservative: units are upserted, a price
 * snapshot is appended only when something material changed, and units that
 * vanish from the feed are marked leased rather than deleted — a unit
 * disappearing *is* the signal that it rented, and that is exactly the event
 * worth keeping.
 */
export async function runSource(
  source: { slug: string; buildingSlug: string; url: string; adapter?: string | null; crawlDelaySec?: number },
  opts: RunOptions = {},
): Promise<RunSummary> {
  const log = opts.log ?? (() => {});
  const db = getDb();

  const fetcher = createFetcher({
    crawlDelaySec: source.crawlDelaySec ?? 2,
    cacheMaxAgeSec: opts.cacheMaxAgeSec ?? 0,
    onLog: log,
  });

  const runRow = opts.dryRun
    ? null
    : db
        .insert(schema.scrapeRuns)
        .values({ sourceSlug: source.slug, adapter: opts.adapterId ?? source.adapter ?? null })
        .returning({ id: schema.scrapeRuns.id })
        .get();

  try {
    const result = await fetchAndParse(source.url, fetcher, {
      adapterId: opts.adapterId ?? source.adapter ?? undefined,
      log,
    });

    const summary = opts.dryRun
      ? emptySummary(source, result)
      : await persist(source, result, { ...opts, runId: runRow?.id ?? null, fetcher, log });

    if (runRow) {
      db.update(schema.scrapeRuns)
        .set({
          finishedAt: Math.floor(Date.now() / 1000),
          ok: true,
          adapter: result.adapter,
          unitsFound: summary.unitsFound,
          unitsChanged: summary.unitsChanged,
          warnings: summary.warnings.length ? JSON.stringify(summary.warnings) : null,
        })
        .where(eq(schema.scrapeRuns.id, runRow.id))
        .run();
    }
    return summary;
  } catch (err) {
    if (runRow) {
      db.update(schema.scrapeRuns)
        .set({
          finishedAt: Math.floor(Date.now() / 1000),
          ok: false,
          error: (err as Error).message,
        })
        .where(eq(schema.scrapeRuns.id, runRow.id))
        .run();
    }
    throw err;
  }
}

/** Fetch a URL, choose an adapter, and run it. No database involvement. */
export async function fetchAndParse(
  url: string,
  fetcher: Fetcher,
  opts: { adapterId?: string; log?: (m: string) => void } = {},
): Promise<ScrapeResult> {
  const log = opts.log ?? (() => {});
  const html = await fetcher.getText(url);
  const $ = cheerio.load(html);
  const origin = new URL(url).origin;

  let adapter = opts.adapterId ? getAdapter(opts.adapterId) : undefined;
  if (opts.adapterId && !adapter) {
    throw new Error(`Unknown adapter "${opts.adapterId}"`);
  }
  if (!adapter) {
    const detection = detectAdapter(html, url);
    adapter = detection.adapter;
    log(
      `adapter: ${detection.adapter.id} (${detection.score}) — ` +
        detection.ranked.map((r) => `${r.id}:${r.score}`).join(" "),
    );
  }

  const ctx: ScrapeContext = {
    url,
    origin,
    html,
    $,
    fetch: fetcher,
    getText: fetcher.getText,
    getJson: fetcher.getJson,
    log,
  };

  const result = await adapter.scrape(ctx);
  const platform = detectPlatform(html, url);
  return { ...result, platform: platform?.id ?? result.platform };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface PersistOptions extends RunOptions {
  runId: number | null;
  fetcher: Fetcher;
  log: (m: string) => void;
}

async function persist(
  source: { slug: string; buildingSlug: string; url: string },
  result: ScrapeResult,
  opts: PersistOptions,
): Promise<RunSummary> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const warnings = [...result.warnings];

  // --- building -----------------------------------------------------------
  db.insert(schema.buildings)
    .values({
      slug: source.buildingSlug,
      name: result.building.name ?? source.buildingSlug,
      websiteUrl: source.url,
      address: result.building.address ?? null,
      lat: result.building.lat ?? null,
      lng: result.building.lng ?? null,
      platform: result.platform,
    })
    .onConflictDoUpdate({
      target: schema.buildings.slug,
      set: {
        // Never clobber a curated value with a null from a thinner page.
        ...(result.building.name ? { name: result.building.name } : {}),
        ...(result.building.address ? { address: result.building.address } : {}),
        ...(result.building.lat != null ? { lat: result.building.lat } : {}),
        ...(result.building.lng != null ? { lng: result.building.lng } : {}),
        platform: result.platform,
        updatedAt: now,
      },
    })
    .run();

  // --- floor plans --------------------------------------------------------
  let imagesDownloaded = 0;
  for (const plan of result.plans) {
    const id = `${source.buildingSlug}:${toPlanKey(plan.key)}`;
    let imagePath: string | null = null;

    if (plan.imageUrl && !opts.skipImages) {
      const existing = db
        .select({ imagePath: schema.floorplans.imagePath, imageUrl: schema.floorplans.imageUrl })
        .from(schema.floorplans)
        .where(eq(schema.floorplans.id, id))
        .get();
      // Only re-download when the URL changed; plan images are static.
      if (existing?.imagePath && existing.imageUrl === plan.imageUrl) {
        imagePath = existing.imagePath;
      } else {
        try {
          imagePath = await downloadImage(plan.imageUrl, source.buildingSlug, toPlanKey(plan.key), opts.fetcher);
          imagesDownloaded++;
          opts.log(`floorplan image → ${imagePath}`);
        } catch (err) {
          warnings.push(`floor plan image ${plan.imageUrl}: ${(err as Error).message}`);
        }
      }
    }

    db.insert(schema.floorplans)
      .values({
        id,
        buildingSlug: source.buildingSlug,
        name: plan.name,
        bedrooms: plan.bedrooms ?? null,
        bathrooms: plan.bathrooms ?? null,
        sqft: plan.sqft ?? null,
        imageUrl: plan.imageUrl ?? null,
        imagePath,
      })
      .onConflictDoUpdate({
        target: schema.floorplans.id,
        set: {
          name: plan.name,
          ...(plan.bedrooms != null ? { bedrooms: plan.bedrooms } : {}),
          ...(plan.bathrooms != null ? { bathrooms: plan.bathrooms } : {}),
          ...(plan.sqft != null ? { sqft: plan.sqft } : {}),
          ...(plan.imageUrl ? { imageUrl: plan.imageUrl } : {}),
          ...(imagePath ? { imagePath } : {}),
          updatedAt: now,
        },
      })
      .run();
  }

  // Availability tables routinely name a plan the site has no separate entry
  // for — every plan without a marketing image, in practice. Those still need
  // a record, both to satisfy the unit → floorplan reference and because the
  // massing solver reads plan square footage.
  const existingPlanIds = new Set(
    db
      .select({ id: schema.floorplans.id })
      .from(schema.floorplans)
      .where(eq(schema.floorplans.buildingSlug, source.buildingSlug))
      .all()
      .map((r) => r.id),
  );

  for (const u of result.units) {
    if (!u.planKey) continue;
    const id = `${source.buildingSlug}:${toPlanKey(u.planKey)}`;
    if (existingPlanIds.has(id)) continue;
    db.insert(schema.floorplans)
      .values({
        id,
        buildingSlug: source.buildingSlug,
        name: u.planKey,
        bedrooms: u.bedrooms ?? null,
        bathrooms: u.bathrooms ?? null,
        sqft: u.sqft ?? null,
      })
      .onConflictDoNothing()
      .run();
    existingPlanIds.add(id);
  }

  // --- units --------------------------------------------------------------
  // The building's line vocabulary sharpens unit-code parsing, so collect the
  // candidate lines from a first pass before committing to a split.
  const knownLines = inferLines(result.units.map((u) => u.unitCode));
  const unparsed: string[] = [];
  let unitsChanged = 0;
  const seenIds = new Set<string>();

  for (const u of result.units) {
    const id = `${source.buildingSlug}:${u.unitCode}`;
    seenIds.add(id);
    const parsed = parseUnitCode(u.unitCode, knownLines);
    if (!parsed) unparsed.push(u.unitCode);

    const planId = u.planKey ? `${source.buildingSlug}:${toPlanKey(u.planKey)}` : null;
    const prior = db.select().from(schema.units).where(eq(schema.units.id, id)).get();

    db.insert(schema.units)
      .values({
        id,
        buildingSlug: source.buildingSlug,
        unitCode: u.unitCode,
        floor: parsed?.floor ?? null,
        line: parsed?.line ?? null,
        wing: parsed?.wing ?? null,
        floorplanId: planId,
        bedrooms: u.bedrooms ?? null,
        bathrooms: u.bathrooms ?? null,
        sqft: u.sqft ?? null,
        status: u.status ?? "available",
        rent: u.rent ?? null,
        marketRent: u.marketRent ?? null,
        availableOn: u.availableOn ?? null,
        leaseTermMonths: u.leaseTermMonths ?? null,
        listingUrl: u.listingUrl ?? null,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: schema.units.id,
        set: {
          floor: parsed?.floor ?? prior?.floor ?? null,
          line: parsed?.line ?? prior?.line ?? null,
          wing: parsed?.wing ?? prior?.wing ?? null,
          ...(planId ? { floorplanId: planId } : {}),
          ...(u.bedrooms != null ? { bedrooms: u.bedrooms } : {}),
          ...(u.bathrooms != null ? { bathrooms: u.bathrooms } : {}),
          ...(u.sqft != null ? { sqft: u.sqft } : {}),
          status: u.status ?? "available",
          rent: u.rent ?? null,
          marketRent: u.marketRent ?? null,
          availableOn: u.availableOn ?? null,
          leaseTermMonths: u.leaseTermMonths ?? null,
          ...(u.listingUrl ? { listingUrl: u.listingUrl } : {}),
          lastSeenAt: now,
        },
      })
      .run();

    if (
      recordSnapshot(id, {
        rent: u.rent ?? null,
        marketRent: u.marketRent ?? null,
        status: u.status ?? "available",
        availableOn: u.availableOn ?? null,
        leaseTermMonths: u.leaseTermMonths ?? null,
        runId: opts.runId,
      })
    ) {
      unitsChanged++;
    }
  }

  // --- delisting ----------------------------------------------------------
  // A unit that was available last run and is now absent has been leased.
  const stillListed = db
    .select()
    .from(schema.units)
    .where(
      and(
        eq(schema.units.buildingSlug, source.buildingSlug),
        eq(schema.units.status, "available"),
      ),
    )
    .all();

  let unitsDelisted = 0;
  for (const row of stillListed) {
    if (seenIds.has(row.id)) continue;
    db.update(schema.units)
      .set({ status: "leased", lastSeenAt: now })
      .where(eq(schema.units.id, row.id))
      .run();
    recordSnapshot(row.id, {
      rent: row.rent,
      marketRent: row.marketRent,
      status: "leased",
      availableOn: row.availableOn,
      leaseTermMonths: row.leaseTermMonths,
      runId: opts.runId,
    });
    unitsDelisted++;
  }

  // --- per-bedroom-type rollup -------------------------------------------
  const typeRows = rollUpByType(source.buildingSlug, opts.runId);
  opts.log(`wrote ${typeRows} unit-type snapshot(s)`);

  // --- geometry -----------------------------------------------------------
  // Derived here rather than in the CLI so every caller — command line,
  // scheduled run, API route — ends up with geometry consistent with the
  // listings that were just written.
  let geometryNotes: string[] = [];
  if (opts.inferGeometry !== false && result.units.length > 0) {
    try {
      const inferred = inferForBuilding(source.buildingSlug);
      geometryNotes = inferred.notes;
      opts.log(
        `massing derived: ${inferred.spec.topFloor} floors, ` +
          `${inferred.plate.stacks.length} lines (${inferred.confidence})`,
      );
    } catch (err) {
      warnings.push(`Geometry not derived: ${(err as Error).message}`);
    }
  }

  if (unparsed.length) {
    warnings.push(
      `${unparsed.length} unit label(s) carried no floor/line information and cannot be placed in 3D: ` +
        unparsed.slice(0, 10).join(", ") +
        (unparsed.length > 10 ? ", …" : ""),
    );
  }

  return {
    sourceSlug: source.slug,
    buildingSlug: source.buildingSlug,
    adapter: result.adapter,
    platform: result.platform,
    unitsFound: result.units.length,
    unitsChanged,
    unitsDelisted,
    plansFound: result.plans.length,
    imagesDownloaded,
    warnings,
    unparsedUnitCodes: unparsed,
    geometryNotes,
  };
}

/**
 * Append a price snapshot when it differs from the last one for this unit.
 * @returns true when a row was written.
 */
function recordSnapshot(
  unitId: string,
  next: {
    rent: number | null;
    marketRent: number | null;
    status: string;
    availableOn: string | null;
    leaseTermMonths: number | null;
    runId: number | null;
  },
): boolean {
  const db = getDb();
  const last = db
    .select()
    .from(schema.priceSnapshots)
    .where(eq(schema.priceSnapshots.unitId, unitId))
    .orderBy(desc(schema.priceSnapshots.observedAt), desc(schema.priceSnapshots.id))
    .limit(1)
    .get();

  const unchanged =
    last &&
    last.rent === next.rent &&
    last.marketRent === next.marketRent &&
    last.status === next.status &&
    last.availableOn === next.availableOn &&
    last.leaseTermMonths === next.leaseTermMonths;
  if (unchanged) return false;

  db.insert(schema.priceSnapshots)
    .values({
      unitId,
      rent: next.rent,
      marketRent: next.marketRent,
      status: next.status,
      availableOn: next.availableOn,
      leaseTermMonths: next.leaseTermMonths,
      runId: next.runId,
    })
    .run();
  return true;
}

/**
 * Summarise what's currently available at each bedroom count and append one
 * row per type. Written every run so the series has a point whenever the
 * building's inventory was observed, which is what makes "2-beds here are up
 * $140 this month" answerable.
 *
 * @returns number of rows written.
 */
export function rollUpByType(buildingSlug: string, runId: number | null): number {
  const db = getDb();
  const available = db
    .select()
    .from(schema.units)
    .where(
      and(
        eq(schema.units.buildingSlug, buildingSlug),
        eq(schema.units.status, "available"),
      ),
    )
    .all();

  const byBedrooms = new Map<number, typeof available>();
  for (const u of available) {
    if (u.bedrooms == null) continue;
    const arr = byBedrooms.get(u.bedrooms) ?? [];
    arr.push(u);
    byBedrooms.set(u.bedrooms, arr);
  }

  let written = 0;
  for (const [bedrooms, group] of byBedrooms) {
    const rents = group
      .map((u) => u.rent)
      .filter((r): r is number => r != null && r > 0)
      .sort((a, b) => a - b);
    const sqfts = group.map((u) => u.sqft).filter((s): s is number => s != null && s > 0);
    // Price per square foot only from units that publish both numbers.
    const ppsf = group
      .filter((u) => u.rent != null && u.sqft != null && u.sqft > 0)
      .map((u) => (u.rent! / u.sqft!) * 100);

    db.insert(schema.typeSnapshots)
      .values({
        buildingSlug,
        bedrooms,
        runId,
        availableCount: group.length,
        minRent: rents[0] ?? null,
        medianRent: rents.length ? Math.round(medianOf(rents)) : null,
        avgRent: rents.length ? Math.round(rents.reduce((a, b) => a + b, 0) / rents.length) : null,
        maxRent: rents.at(-1) ?? null,
        avgSqft: sqfts.length ? Math.round(sqfts.reduce((a, b) => a + b, 0) / sqfts.length) : null,
        medianPpsfCents: ppsf.length ? Math.round(medianOf(ppsf)) : null,
      })
      .run();
    written++;
  }
  return written;
}

function medianOf(sorted: number[]): number {
  const s = [...sorted].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Guess the building's line vocabulary from its unit labels. Lines are the
 * trailing 2 digits for the overwhelming majority of Chicago towers; taking
 * the most common trailing-length that yields a consistent, small vocabulary
 * gets the exceptions right too.
 */
export function inferLines(codes: string[]): string[] {
  const numeric = codes
    .map((c) => c.replace(/\D/g, ""))
    .filter((c) => c.length >= 3);
  if (numeric.length === 0) return [];

  let best: { len: number; lines: string[]; score: number } | null = null;
  for (const len of [2, 3, 1]) {
    const lines = new Set<string>();
    let usable = 0;
    for (const n of numeric) {
      if (n.length <= len) continue;
      lines.add(n.slice(-len));
      usable++;
    }
    if (usable === 0) continue;
    // A real line vocabulary is small relative to the number of units: a
    // 40-storey tower with 8 lines has ~300 units but only 8 distinct lines.
    const ratio = lines.size / usable;
    const score = ratio < 0.5 ? 1 - ratio : -ratio;
    if (!best || score > best.score) {
      best = { len, lines: [...lines], score };
    }
  }
  return best?.lines ?? [];
}

async function downloadImage(
  url: string,
  buildingSlug: string,
  key: string,
  fetcher: Fetcher,
): Promise<string> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  let ext = extname(new URL(url).pathname).toLowerCase();
  if (!/^\.(png|jpe?g|webp|gif|svg|pdf)$/.test(ext)) {
    const type = res.headers.get("content-type") ?? "";
    ext = type.includes("png") ? ".png"
      : type.includes("webp") ? ".webp"
      : type.includes("svg") ? ".svg"
      : type.includes("pdf") ? ".pdf"
      : ".jpg";
  }

  const rel = join(buildingSlug, `${key}${ext}`);
  const abs = join(FLOORPLAN_DIR, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  return rel;
}

function emptySummary(
  source: { slug: string; buildingSlug: string },
  result: ScrapeResult,
): RunSummary {
  const knownLines = inferLines(result.units.map((u) => u.unitCode));
  const unparsed = result.units
    .filter((u) => !parseUnitCode(u.unitCode, knownLines))
    .map((u) => u.unitCode);
  return {
    sourceSlug: source.slug,
    buildingSlug: source.buildingSlug,
    adapter: result.adapter,
    platform: result.platform,
    unitsFound: result.units.length,
    unitsChanged: 0,
    unitsDelisted: 0,
    plansFound: result.plans.length,
    imagesDownloaded: 0,
    warnings: result.warnings,
    unparsedUnitCodes: unparsed,
    geometryNotes: [],
  };
}
