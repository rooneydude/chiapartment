import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeDelta } from "../../shared/src/delta";
import {
  SnapshotSchema,
  type BuildingHistory,
  type FloorplanPoint,
  type Snapshot,
} from "../../shared/src/types";
import { loadConfig } from "./run";

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

  for (const building of config.buildings) {
    const history: BuildingHistory = {
      buildingId: building.id,
      latest: null,
      delta: null,
      perUnit: {},
      perFloorplan: {},
      runs: [],
    };

    const okRuns: { timestamp: string; units: Snapshot["buildings"][number]["units"] }[] = [];
    for (const snap of snapshots) {
      const bs = snap.buildings.find((b) => b.buildingId === building.id);
      if (!bs || bs.status !== "ok") continue;
      okRuns.push({ timestamp: snap.timestamp, units: bs.units });
    }

    for (const run of okRuns) {
      history.runs.push(run.timestamp);
      const byPlan = new Map<string, number[]>();
      for (const u of run.units) {
        if (u.unitNumber) {
          (history.perUnit[u.unitNumber] ??= []).push({ t: run.timestamp, price: u.price });
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

    writeFileSync(join(outDir, "buildings", `${building.id}.json`), JSON.stringify(history));
  }

  writeFileSync(join(outDir, "config.json"), JSON.stringify(config));

  const skylineSrc = join(root, "data", "skyline.geojson");
  if (existsSync(skylineSrc)) {
    copyFileSync(skylineSrc, join(outDir, "skyline.geojson"));
  }

  console.log(
    `Compiled ${snapshots.length} snapshot(s) for ${config.buildings.length} building(s) → web/public/data/`,
  );
}
