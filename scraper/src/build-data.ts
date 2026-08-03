import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeDelta } from "../../shared/src/delta";
import {
  SnapshotSchema,
  type BuildingHistory,
  type BuildingSnapshot,
  type CompiledConfig,
  type DataWarning,
  type FloorplanPoint,
  type Snapshot,
} from "../../shared/src/types";
import { loadConfig } from "./run";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Data-sanity alarms so a broken scrape never masquerades as market truth. */
function computeWarnings(
  lastAny: BuildingSnapshot | null,
  okRuns: { timestamp: string; units: Snapshot["buildings"][number]["units"] }[],
): DataWarning[] {
  const warnings: DataWarning[] = [];
  if (lastAny?.status === "error") {
    warnings.push({
      code: "scrape-error",
      message: `Last scrape failed: ${lastAny.error ?? "unknown error"}. Showing older data.`,
    });
  }
  const latest = okRuns[okRuns.length - 1];
  const prev = okRuns[okRuns.length - 2];
  if (!latest || !prev) return warnings;

  if (latest.units.length === 0 && prev.units.length > 0) {
    warnings.push({
      code: "empty-run",
      message: `Latest scrape returned 0 units (previous run had ${prev.units.length}) — likely a site change, not a sold-out building.`,
    });
  }
  if (latest.units.length > 0 && prev.units.length >= 4) {
    const mLatest = median(latest.units.map((u) => u.price));
    const mPrev = median(prev.units.map((u) => u.price));
    const jump = Math.abs(mLatest - mPrev) / mPrev;
    if (jump > 0.15) {
      warnings.push({
        code: "price-jump",
        message: `Median price moved ${Math.round(jump * 100)}% in one run ($${Math.round(mPrev)} → $${Math.round(mLatest)}) — verify before trusting.`,
      });
    }
    if (latest.units.length < prev.units.length * 0.5) {
      warnings.push({
        code: "count-drop",
        message: `Listing count halved in one run (${prev.units.length} → ${latest.units.length}) — possible partial scrape.`,
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
  if (existsSync(snapDir)) {
    for (const f of readdirSync(snapDir).sort()) {
      if (!f.endsWith(".json")) continue;
      try {
        snapshots.push(SnapshotSchema.parse(JSON.parse(readFileSync(join(snapDir, f), "utf8"))));
      } catch (err) {
        console.warn(`Skipping invalid snapshot ${f}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const warningCounts: Record<string, number> = {};
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
    };

    const okRuns: { timestamp: string; units: Snapshot["buildings"][number]["units"] }[] = [];
    let lastAny: BuildingSnapshot | null = null;
    for (const snap of snapshots) {
      const bs = snap.buildings.find((b) => b.buildingId === building.id);
      if (!bs) continue;
      lastAny = bs;
      if (bs.status !== "ok") continue;
      okRuns.push({ timestamp: snap.timestamp, units: bs.units });
    }

    for (const run of okRuns) {
      history.runs.push(run.timestamp);
      const byPlan = new Map<string, number[]>();
      for (const u of run.units) {
        if (u.unitNumber) {
          (history.perUnit[u.unitNumber] ??= []).push({ t: run.timestamp, price: u.price });
          history.perUnitMeta[u.unitNumber] ??= {
            firstSeen: run.timestamp,
            firstPrice: u.price,
          };
        }
        const prices = byPlan.get(u.floorplanName) ?? [];
        prices.push(u.price);
        byPlan.set(u.floorplanName, prices);
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
      );
    }
    history.warnings = computeWarnings(lastAny, okRuns);
    warningCounts[building.id] = history.warnings.length;

    writeFileSync(join(outDir, "buildings", `${building.id}.json`), JSON.stringify(history));
  }

  const compiledConfig: CompiledConfig = {
    ...config,
    health: { generated: new Date().toISOString(), buildings: warningCounts },
  };
  writeFileSync(join(outDir, "config.json"), JSON.stringify(compiledConfig));

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
    `Compiled ${snapshots.length} snapshot(s) for ${config.buildings.length} building(s) → web/public/data/`,
  );
}
