import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assembleWeekdayBrief, focusDeltaFromRuns } from "../../shared/src/brief";
import { computeDelta, listingKey } from "../../shared/src/delta";
import { comparePrices } from "../../shared/src/listing";
import {
  SnapshotSchema,
  type AlsoListed,
  type BuildingHistory,
  type BuildingSnapshot,
  type CompiledConfig,
  type DataWarning,
  type FloorplanPoint,
  type OmittedListing,
  type Snapshot,
  type UnitListing,
} from "../../shared/src/types";
import { loadConfig } from "./run";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One successful scrape of one building, as the compiler sees it. */
export interface OkRun {
  timestamp: string;
  units: UnitListing[];
  /** Historical: units the old lease-term cap dropped from `units` that run. */
  omitted?: OmittedListing[];
  alsoListed?: AlsoListed[];
  notices?: string[];
}

const share = (units: UnitListing[], has: (u: UnitListing) => boolean): number =>
  units.length === 0 ? 0 : units.filter(has).length / units.length;

/** Data-sanity alarms so a broken scrape never masquerades as market truth. */
export function computeWarnings(
  lastAny: BuildingSnapshot | null,
  okRuns: OkRun[],
  latestOmitted: OmittedListing[] = [],
): DataWarning[] {
  const warnings: DataWarning[] = [];
  if (lastAny?.status === "error") {
    const lastGood = okRuns[okRuns.length - 1];
    const lastGoodBit = lastGood
      ? ` Showing data from ${lastGood.timestamp.slice(0, 10)}.`
      : "";
    warnings.push({
      code: "scrape-error",
      message: `Last scrape failed: ${lastAny.error ?? "unknown error"}.${lastGoodBit}`,
    });
  }
  const latest = okRuns[okRuns.length - 1];
  const prev = okRuns[okRuns.length - 2];
  if (!latest || !prev) return warnings;

  if (latest.units.length === 0 && prev.units.length > 0) {
    warnings.push({
      code: "empty-run",
      message: `Latest scrape returned 0 units (previous run had ${prev.units.length}) — check the leasing site: either the building is fully leased or its page changed.`,
    });
  }

  // Price jump: judged on units present in BOTH runs, compared like for like,
  // so new/removed inventory and lease-term switches cannot fake a move.
  const prevByKey = new Map(prev.units.map((u) => [listingKey(u), u]));
  const ratios: number[] = [];
  for (const u of latest.units) {
    const before = prevByKey.get(listingKey(u));
    if (!before) continue;
    const cmp = comparePrices(before, u);
    if (!cmp.notComparable && cmp.from > 0) ratios.push(cmp.to / cmp.from);
  }
  if (ratios.length >= 4) {
    const move = median(ratios) - 1;
    if (Math.abs(move) > 0.15) {
      warnings.push({
        code: "price-jump",
        message: `Prices of the ${ratios.length} units listed in both runs moved ${move > 0 ? "+" : "−"}${Math.round(Math.abs(move) * 100)}% (median) in one run — verify before trusting.`,
      });
    }
  }

  if (latest.units.length > 0 && prev.units.length >= 4 && latest.units.length < prev.units.length * 0.5) {
    const omitted = latestOmitted.length;
    const accounted = latest.units.length + omitted;
    if (omitted > 0 && accounted >= prev.units.length * 0.5) {
      // Historical lease-cap omission explains the drop — not a partial scrape.
    } else {
      const omitBit = omitted > 0 ? `; ${omitted} omitted over-cap` : "";
      warnings.push({
        code: "count-drop",
        message: `Listing count halved in one run (${prev.units.length} → ${latest.units.length}${omitBit}) — possible partial scrape.`,
      });
    }
  }

  // Detail that was there yesterday and is mostly gone today means a
  // secondary request failed (e.g. the lease-term API), not that the site
  // stopped publishing it.
  const checks: [string, (u: UnitListing) => boolean][] = [
    ["lease-term price tables", (u) => (u.leaseTerms?.length ?? 0) > 0],
    ["move-in dates", (u) => u.availableDate !== null],
  ];
  for (const [what, has] of checks) {
    if (latest.units.length >= 2 && share(prev.units, has) >= 0.5 && share(latest.units, has) < 0.5) {
      const n = latest.units.filter(has).length;
      warnings.push({
        code: "partial-data",
        message: `Only ${n} of ${latest.units.length} units have ${what} in the latest scrape (the previous run had them) — a follow-up request probably failed.`,
      });
    }
  }
  return warnings;
}

/**
 * Compile committed per-run snapshots into the compact per-building files the
 * static frontend fetches. Runs at build time; output is gitignored.
 */
export function buildData(root: string): void {
  const config = loadConfig(root);
  const snapDir = join(root, "data", "snapshots");
  const outDir = join(root, "web", "public", "data");
  mkdirSync(join(outDir, "buildings"), { recursive: true });

  const snapshots: Snapshot[] = [];
  const skipped: string[] = [];
  if (existsSync(snapDir)) {
    for (const f of readdirSync(snapDir).sort()) {
      if (!f.endsWith(".json")) continue;
      try {
        snapshots.push(SnapshotSchema.parse(JSON.parse(readFileSync(join(snapDir, f), "utf8"))));
      } catch (err) {
        skipped.push(f);
        console.warn(`Skipping invalid snapshot ${f}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const focusBeds = config.focus?.beds ?? null;
  const warningCounts: Record<string, number> = {};
  const briefInputs: { id: string; name: string; history: BuildingHistory }[] = [];

  for (const building of config.buildings) {
    const history: BuildingHistory = {
      buildingId: building.id,
      latest: null,
      delta: null,
      perUnit: {},
      perFloorplan: {},
      perUnitMeta: {},
      warnings: [],
      runs: [],
      lastAttempt: null,
      focusDelta: null,
      omitted: [],
      alsoListed: [],
      notices: [],
    };

    const okRuns: OkRun[] = [];
    let lastAny: BuildingSnapshot | null = null;
    let lastSnapTs: string | null = null;
    for (const snap of snapshots) {
      const bs = snap.buildings.find((b) => b.buildingId === building.id);
      if (!bs) continue;
      lastAny = bs;
      lastSnapTs = snap.timestamp;
      if (bs.status !== "ok") continue;
      okRuns.push({
        timestamp: snap.timestamp,
        units: bs.units,
        omitted: bs.omitted ?? [],
        alsoListed: bs.alsoListed ?? [],
        notices: bs.notices ?? [],
      });
    }
    if (lastAny && lastSnapTs) {
      history.lastAttempt = {
        timestamp: lastSnapTs,
        status: lastAny.status,
        ...(lastAny.status === "error" && lastAny.error ? { error: lastAny.error } : {}),
      };
    }

    for (const run of okRuns) {
      history.runs.push(run.timestamp);
      const byPlan = new Map<string, number[]>();
      for (const u of run.units) {
        if (u.unitNumber) {
          (history.perUnit[u.unitNumber] ??= []).push({
            t: run.timestamp,
            price: u.price,
            ...(u.leaseTermMonths != null ? { term: u.leaseTermMonths } : {}),
          });
          history.perUnitMeta[u.unitNumber] ??= {
            firstSeen: run.timestamp,
            firstPrice: u.price,
            ...(u.leaseTermMonths != null ? { firstTerm: u.leaseTermMonths } : {}),
          };
        }
        const prices = byPlan.get(u.floorplanName) ?? [];
        prices.push(u.price);
        byPlan.set(u.floorplanName, prices);
      }
      // Units the old lease cap left out of `units` (8 Sep – 14 Nov 2026) were
      // on the site all the same, and their snapshots recorded what the site
      // advertised. Give them their place in the per-unit history — so a unit
      // listed for two months is not shown as "first seen today" — without
      // touching the snapshot files. (Floorplan aggregates stay as they were:
      // mixing these headline prices into the capped ones would distort them.)
      for (const o of run.omitted ?? []) {
        if (!o.unitNumber) continue;
        (history.perUnit[o.unitNumber] ??= []).push({
          t: run.timestamp,
          price: o.advertisedPrice,
          term: o.leaseTermMonths,
        });
        history.perUnitMeta[o.unitNumber] ??= {
          firstSeen: run.timestamp,
          firstPrice: o.advertisedPrice,
          firstTerm: o.leaseTermMonths,
        };
      }
      for (const [plan, prices] of byPlan) {
        const point: FloorplanPoint = {
          t: run.timestamp,
          minPrice: Math.min(...prices),
          avgPrice: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length),
          count: prices.length,
        };
        (history.perFloorplan[plan] ??= []).push(point);
      }
    }

    const latest = okRuns[okRuns.length - 1];
    const prev = okRuns[okRuns.length - 2];
    if (latest) {
      history.latest = { timestamp: latest.timestamp, units: latest.units };
      history.delta = computeDelta(
        prev ? prev.units : null,
        latest.units,
        prev ? prev.timestamp : null,
        latest.timestamp,
        // Units the old lease cap hid last run were on the market then too —
        // they are not "new" when they appear in the list now.
        (prev?.omitted ?? []).map(listingKey),
      );
      history.omitted = latest.omitted ?? [];
      history.alsoListed = latest.alsoListed ?? [];
      history.notices = latest.notices ?? [];
      history.focusDelta = focusDeltaFromRuns(okRuns, focusBeds);
    }
    history.warnings = computeWarnings(lastAny, okRuns, latest?.omitted ?? []);
    warningCounts[building.id] = history.warnings.length;
    briefInputs.push({ id: building.id, name: building.name, history });

    writeFileSync(join(outDir, "buildings", `${building.id}.json`), JSON.stringify(history));
  }

  const generated = new Date().toISOString();
  const compiledConfig: CompiledConfig = {
    ...config,
    health: {
      generated,
      buildings: warningCounts,
      snapshots: snapshots.length,
      ...(skipped.length > 0 ? { skippedSnapshots: skipped } : {}),
    },
  };
  writeFileSync(join(outDir, "config.json"), JSON.stringify(compiledConfig));

  const brief = assembleWeekdayBrief(briefInputs, focusBeds, generated);
  writeFileSync(join(outDir, "brief.json"), JSON.stringify(brief));

  const skylineSrc = join(root, "data", "skyline.geojson");
  if (existsSync(skylineSrc)) {
    copyFileSync(skylineSrc, join(outDir, "skyline.geojson"));
  }

  const unitmapsDir = join(root, "data", "unitmaps");
  if (existsSync(unitmapsDir)) {
    mkdirSync(join(outDir, "unitmaps"), { recursive: true });
    for (const f of readdirSync(unitmapsDir)) {
      if (f.endsWith(".json")) copyFileSync(join(unitmapsDir, f), join(outDir, "unitmaps", f));
    }
  }

  console.log(
    `Compiled ${snapshots.length} snapshot(s) for ${config.buildings.length} building(s) → web/public/data/ (brief ${brief.summary.drops} drops / ${brief.summary.newListings} new)`,
  );
  if (skipped.length > 0) {
    // A snapshot that no longer parses silently removes a day of history from
    // the dashboard — make that impossible to miss in the build log.
    console.error(
      `WARNING: ${skipped.length} snapshot file(s) failed schema validation and were left out: ${skipped.join(", ")}`,
    );
  }
}
