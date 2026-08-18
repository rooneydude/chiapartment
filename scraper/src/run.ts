import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BuildingsConfigSchema,
  SnapshotSchema,
  type BuildingConfig,
  type BuildingsConfig,
  type BuildingSnapshot,
  type Snapshot,
} from "../../shared/src/types";
import { resolveAdapter } from "./adapters/index";
import type { AdapterContext } from "./adapters/types";
import { makeFixtureFetch, makeRecorder } from "./fixtures";
import { httpFetch, sleep } from "./http";

export interface RefreshOptions {
  fixtures: boolean;
  capture: boolean;
  commit: boolean;
  buildings: string[] | null; // null = all
}

const POLITE_DELAY_MS = 1500;

export function loadConfig(root: string): BuildingsConfig {
  const path = join(root, "buildings.json");
  if (!existsSync(path)) {
    throw new Error(`buildings.json not found at ${path} — run from the repo root`);
  }
  return BuildingsConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

type ScrapeResult = Omit<BuildingSnapshot, "buildingId">;

async function scrapeOne(
  root: string,
  building: BuildingConfig,
  opts: RefreshOptions,
  maxLeaseTermMonths?: number,
): Promise<ScrapeResult> {
  const adapter = resolveAdapter(building.adapter);
  const fixtureDir = join(root, "scraper", "fixtures", building.id);
  const recorder = opts.capture ? makeRecorder(fixtureDir) : null;
  const ctx: AdapterContext = {
    fetch: opts.fixtures ? makeFixtureFetch(fixtureDir) : httpFetch,
    log: (msg) => console.log(`  [${building.id}] ${msg}`),
    ...(recorder ? { record: recorder.record } : {}),
    ...(maxLeaseTermMonths ? { maxLeaseTermMonths } : {}),
  };
  console.log(`Scraping ${building.name} (${adapter.id})...`);
  try {
    const units = await adapter.scrape(building, ctx);
    console.log(`  → ${units.length} listings`);
    return {
      status: "ok",
      source: { adapter: adapter.id, fetchedUrl: building.url },
      units,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  → FAILED: ${message}`);
    return {
      status: "error",
      error: message,
      source: { adapter: adapter.id, fetchedUrl: building.url },
      units: [],
    };
  } finally {
    recorder?.flush();
  }
}

export async function refresh(root: string, opts: RefreshOptions): Promise<string> {
  if (opts.fixtures && opts.capture) {
    throw new Error("--fixtures and --capture are mutually exclusive");
  }
  const config = loadConfig(root);
  const targets = config.buildings.filter(
    (b) => opts.buildings === null || opts.buildings.includes(b.id),
  );
  if (targets.length === 0) throw new Error("No buildings matched --buildings filter");

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const snapshot: Snapshot = { schemaVersion: 1, timestamp, buildings: [] };

  // Towers sharing a group + url + adapter are scraped once and reused —
  // but only in live modes; fixture mode reads per-building fixtures.
  const groupCache = new Map<string, ScrapeResult>();

  for (const building of targets) {
    const cacheKey =
      !opts.fixtures && building.group
        ? `${building.group}:${building.url}:${building.adapter}:${JSON.stringify(building.adapterOptions ?? null)}`
        : null;
    let result = cacheKey ? groupCache.get(cacheKey) : undefined;
    if (!result) {
      result = await scrapeOne(root, building, opts, config.focus?.maxLeaseTermMonths);
      if (cacheKey) groupCache.set(cacheKey, result);
      if (!opts.fixtures && building !== targets[targets.length - 1]) {
        await sleep(POLITE_DELAY_MS);
      }
    } else {
      console.log(`Scraping ${building.name}: reusing group "${building.group}" result`);
    }
    snapshot.buildings.push({ buildingId: building.id, ...result });
  }

  SnapshotSchema.parse(snapshot); // never write an invalid snapshot

  const dir = join(root, "data", "snapshots");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${timestamp.replaceAll(":", "-")}.json`);
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);

  const okCount = snapshot.buildings.filter((b) => b.status === "ok").length;
  console.log(`\nSnapshot written: ${file} (${okCount}/${snapshot.buildings.length} buildings ok)`);

  if (opts.commit) {
    execFileSync("git", ["add", "data/snapshots"], { cwd: root });
    execFileSync("git", ["commit", "-m", `data: snapshot ${timestamp}`], {
      cwd: root,
      stdio: "inherit",
    });
  }
  return file;
}
