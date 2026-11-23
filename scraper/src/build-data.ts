import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assembleWeekdayBrief, focusDeltaFromRuns } from "../../shared/src/brief";
import {
  alsoListedKeys,
  chicagoDate,
  computeDelta,
  deltaContextFor,
  listingKey,
  priorChicagoDayRun,
} from "../../shared/src/delta";
import { comparePrices, uniformReprice } from "../../shared/src/listing";
import {
  SnapshotSchema,
  type AlsoListed,
  type AlsoListedCompiled,
  type BuildingHistory,
  type BuildingSnapshot,
  type CompiledConfig,
  type DataWarning,
  type FloorplanPoint,
  type MethodChange,
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
  /** Undefined when the run did not record such rows at all. */
  alsoListed?: AlsoListed[] | undefined;
  notices?: string[];
  /** What the run could not read although it succeeded. */
  gaps?: string[];
}

/** How far back a "this detail used to be there" check looks. */
const PARTIAL_DATA_LOOKBACK_RUNS = 14;

const share = (units: UnitListing[], has: (u: UnitListing) => boolean): number =>
  units.length === 0 ? 0 : units.filter(has).length / units.length;

/**
 * For rows now listed without a price: the price the same plan / unit last
 * carried on the site, and when — "Contact for Pricing" after $2,250 says
 * more than "Contact for Pricing" alone.
 */
export function withLastPrices(rows: AlsoListed[], okRuns: OkRun[]): AlsoListedCompiled[] {
  return rows.map((row) => {
    if (row.price !== undefined) return row;
    const key = alsoListedKeys([row])[0];
    if (!key) return row;
    for (let i = okRuns.length - 1; i >= 0; i--) {
      const run = okRuns[i]!;
      const was = run.units.find((u) => listingKey(u) === key);
      if (was) return { ...row, lastPrice: was.price, lastPricedAt: run.timestamp };
    }
    return row;
  });
}

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
      ? ` Showing data from ${chicagoDate(lastGood.timestamp)}.`
      : "";
    warnings.push({
      code: "scrape-error",
      message: lastAny.blocked
        ? `The leasing site's bot protection refused the last scrape, so nothing new could be read.${lastGoodBit} The next scheduled run will ask again.`
        : `Last scrape failed: ${lastAny.error ?? "unknown error"}.${lastGoodBit}`,
    });
  }
  const latest = okRuns[okRuns.length - 1];
  // Judged against the same baseline the daily brief uses — the last run of
  // an earlier Chicago day — so a second run on the same day does not erase
  // a warning the morning run raised. (No earlier day yet: the previous run.)
  const prev = latest ? (priorChicagoDayRun(okRuns, latest) ?? okRuns[okRuns.length - 2]) : undefined;
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

  // Every unit moving by the same ratio at once: a concession, not a rent change.
  const uniform = uniformReprice(prev.units, latest.units);
  if (uniform) {
    const down = uniform.ratio < 1;
    warnings.push({
      code: "uniform-reprice",
      message: `All ${uniform.units} units listed in both runs were repriced by the same ${down ? "−" : "+"}${(Math.abs(uniform.ratio - 1) * 100).toFixed(1)}% at once. That pattern usually means a concession (free rent) was ${down ? "netted into" : "taken out of"} the advertised prices, not that base rent changed — check the site's current special.`,
    });
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
  // Compared with any recent run that still had the detail, so the warning
  // stays up until the data is back instead of vanishing after one run.
  const recent = okRuns.slice(-(PARTIAL_DATA_LOOKBACK_RUNS + 1), -1);
  for (const [what, has] of checks) {
    if (latest.units.length < 2 || share(latest.units, has) >= 0.5) continue;
    const hadIt = [...recent].reverse().find((r) => r.units.length >= 2 && share(r.units, has) >= 0.5);
    if (!hadIt) continue;
    const n = latest.units.filter(has).length;
    warnings.push({
      code: "partial-data",
      message: `Only ${n} of ${latest.units.length} units have ${what} in the latest scrape; the run of ${chicagoDate(hadIt.timestamp)} had them. If the next refresh does not bring them back, a request the scraper makes is failing.`,
    });
  }
  return warnings;
}

const CAPPED_NOTE =
  "From here the tracker stored each unit's cheapest rent for a lease of 14 months or less, and left out units that had none.";
const ADVERTISED_NOTE =
  "From here on: the rent the leasing site itself advertises, at the lease length it advertises — and every listed unit.";
/** Switches closer together than this are one changeover, not separate events. */
const CHANGEOVER_GAP_DAYS = 10;

/**
 * Where the MEANING of a building's stored prices changed. From 8 Sep to 14
 * Nov 2026 the scraper stored each 1225 unit at its cheapest rent for a lease
 * of 14 months or less (and left out units without one); before and after,
 * the rent the site advertises. A chart line stepping at those points is the
 * method, not the market — the chart marks them.
 *
 * While the new scraper was being checked, the old one was still on the
 * schedule, so for a few days runs of both kinds alternate. Those switches are
 * reported as one stretch (`until`) rather than a row of separate markers.
 */
export function findMethodChanges(okRuns: OkRun[]): MethodChange[] {
  const switches: { t: string; capped: boolean }[] = [];
  let capped = false;
  for (const run of okRuns) {
    const isCapped = (run.omitted?.length ?? 0) > 0;
    if (isCapped !== capped) switches.push({ t: run.timestamp, capped: isCapped });
    capped = isCapped;
  }
  const gapDays = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
  const out: MethodChange[] = [];
  for (let i = 0; i < switches.length; ) {
    let j = i;
    while (j + 1 < switches.length && gapDays(switches[j]!.t, switches[j + 1]!.t) <= CHANGEOVER_GAP_DAYS) j++;
    const first = switches[i]!;
    const last = switches[j]!;
    if (j > i) {
      out.push({
        t: first.t,
        until: last.t,
        note: `In this stretch runs used one method or the other (the old scraper was still on the schedule while the new one was being checked), so its points are not all like for like. After it: ${
          last.capped
            ? "each unit's cheapest rent for a lease of 14 months or less."
            : "the rent the leasing site itself advertises, at the lease length it advertises — and every listed unit."
        }`,
      });
    } else {
      out.push({ t: first.t, note: first.capped ? CAPPED_NOTE : ADVERTISED_NOTE });
    }
    i = j + 1;
  }
  return out;
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
    let failedRuns = 0;
    for (const snap of snapshots) {
      const bs = snap.buildings.find((b) => b.buildingId === building.id);
      if (!bs) continue;
      lastAny = bs;
      lastSnapTs = snap.timestamp;
      failedRuns = bs.status === "ok" ? 0 : failedRuns + 1;
      if (bs.status !== "ok") continue;
      okRuns.push({
        timestamp: snap.timestamp,
        units: bs.units,
        omitted: bs.omitted ?? [],
        // Left undefined on runs that did not record such rows (before 15 Nov
        // 2026): "none listed" and "not recorded" are different things.
        alsoListed: bs.alsoListed,
        notices: bs.notices ?? [],
        gaps: bs.gaps ?? [],
      });
    }
    if (lastAny && lastSnapTs) {
      history.lastAttempt = {
        timestamp: lastSnapTs,
        status: lastAny.status,
        ...(lastAny.status === "error" && lastAny.error ? { error: lastAny.error } : {}),
        ...(lastAny.status === "error" && lastAny.blocked ? { blocked: true } : {}),
        ...(failedRuns > 0 ? { failedRuns } : {}),
      };
    }

    for (const run of okRuns) {
      history.runs.push(run.timestamp);
      const byPlan = new Map<string, number[]>();
      // The lease term behind each plan's cheapest price that run, when known.
      const cheapestOfPlan = new Map<string, UnitListing>();
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
        } else {
          // Floorplan / stack listings (Stead 220) have no unit number; they
          // get first-seen metadata under the identity deltas use for them.
          history.perUnitMeta[listingKey(u)] ??= {
            firstSeen: run.timestamp,
            firstPrice: u.price,
            ...(u.leaseTermMonths != null ? { firstTerm: u.leaseTermMonths } : {}),
          };
        }
        const prices = byPlan.get(u.floorplanName) ?? [];
        prices.push(u.price);
        byPlan.set(u.floorplanName, prices);
        const cheapest = cheapestOfPlan.get(u.floorplanName);
        if (!cheapest || u.price < cheapest.price) cheapestOfPlan.set(u.floorplanName, u);
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
          ...(cheapestOfPlan.get(plan)?.leaseTermMonths != null
            ? { term: cheapestOfPlan.get(plan)!.leaseTermMonths! }
            : {}),
        };
        (history.perFloorplan[plan] ??= []).push(point);
      }
    }

    const methodChanges = findMethodChanges(okRuns);
    if (methodChanges.length > 0) history.methodChanges = methodChanges;

    const latest = okRuns[okRuns.length - 1];
    const prev = okRuns[okRuns.length - 2];
    if (latest) {
      history.latest = { timestamp: latest.timestamp, units: latest.units };
      history.delta = computeDelta(
        prev ? prev.units : null,
        latest.units,
        prev ? prev.timestamp : null,
        latest.timestamp,
        // Rows that were / are on the site outside the unit list (the old
        // lease cap's omissions, plans listed without a price) are neither
        // "new" nor "removed"; a unit seen in an earlier run is a re-listing.
        deltaContextFor(okRuns, prev ?? null, latest),
      );
      history.omitted = latest.omitted ?? [];
      history.alsoListed = withLastPrices(latest.alsoListed ?? [], okRuns);
      history.notices = latest.notices ?? [];
      if (latest.gaps && latest.gaps.length > 0) history.gaps = latest.gaps;
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
      // sorted by time above: the last one is the newest
      ...(snapshots.length > 0 ? { latestSnapshot: snapshots[snapshots.length - 1]!.timestamp } : {}),
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
