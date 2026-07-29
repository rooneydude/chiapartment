import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

export const DB_PATH = process.env.CHIAPARTMENT_DB ?? resolve("data/chiapartment.db");

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  migrate(sqlite);
  _db = drizzle(sqlite, { schema });
  return _db;
}

export { schema };

/**
 * Schema is applied with plain DDL rather than drizzle-kit migrations. There is
 * exactly one consumer (a local file), the statements are all idempotent, and
 * it means `npm run scrape` works on a clean checkout with no migrate step.
 */
function migrate(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS buildings (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      website_url TEXT,
      address TEXT,
      neighborhood TEXT,
      lat REAL,
      lng REAL,
      platform TEXT,
      spec_json TEXT,
      plate_json TEXT,
      spec_confidence TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sources (
      slug TEXT PRIMARY KEY,
      building_slug TEXT NOT NULL REFERENCES buildings(slug) ON DELETE CASCADE,
      url TEXT NOT NULL,
      platform TEXT,
      adapter TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      robots_allowed INTEGER,
      robots_checked_at INTEGER,
      crawl_delay_sec REAL NOT NULL DEFAULT 2,
      notes TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS sources_building_idx ON sources(building_slug);

    CREATE TABLE IF NOT EXISTS floorplans (
      id TEXT PRIMARY KEY,
      building_slug TEXT NOT NULL REFERENCES buildings(slug) ON DELETE CASCADE,
      name TEXT NOT NULL,
      bedrooms REAL,
      bathrooms REAL,
      sqft INTEGER,
      image_url TEXT,
      image_path TEXT,
      plan_json TEXT,
      traced_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS floorplans_building_idx ON floorplans(building_slug);

    CREATE TABLE IF NOT EXISTS units (
      id TEXT PRIMARY KEY,
      building_slug TEXT NOT NULL REFERENCES buildings(slug) ON DELETE CASCADE,
      unit_code TEXT NOT NULL,
      floor INTEGER,
      line TEXT,
      wing TEXT,
      floorplan_id TEXT REFERENCES floorplans(id) ON DELETE SET NULL,
      bedrooms REAL,
      bathrooms REAL,
      sqft INTEGER,
      facing_deg REAL,
      view_score REAL,
      status TEXT NOT NULL DEFAULT 'unknown',
      rent INTEGER,
      market_rent INTEGER,
      available_on TEXT,
      lease_term_months INTEGER,
      listing_url TEXT,
      first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS units_building_code_idx ON units(building_slug, unit_code);
    CREATE INDEX IF NOT EXISTS units_building_idx ON units(building_slug);
    CREATE INDEX IF NOT EXISTS units_status_idx ON units(status);

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_slug TEXT NOT NULL,
      adapter TEXT,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      finished_at INTEGER,
      ok INTEGER NOT NULL DEFAULT 0,
      units_found INTEGER NOT NULL DEFAULT 0,
      units_changed INTEGER NOT NULL DEFAULT 0,
      warnings TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_source_idx ON scrape_runs(source_slug, started_at);

    CREATE TABLE IF NOT EXISTS price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      observed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      rent INTEGER,
      market_rent INTEGER,
      status TEXT NOT NULL,
      available_on TEXT,
      lease_term_months INTEGER,
      run_id INTEGER REFERENCES scrape_runs(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS snapshots_unit_idx ON price_snapshots(unit_id, observed_at);
    CREATE INDEX IF NOT EXISTS snapshots_time_idx ON price_snapshots(observed_at);

    CREATE TABLE IF NOT EXISTS type_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      building_slug TEXT NOT NULL REFERENCES buildings(slug) ON DELETE CASCADE,
      bedrooms REAL NOT NULL,
      observed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      run_id INTEGER REFERENCES scrape_runs(id) ON DELETE SET NULL,
      available_count INTEGER NOT NULL DEFAULT 0,
      min_rent INTEGER,
      median_rent INTEGER,
      avg_rent INTEGER,
      max_rent INTEGER,
      avg_sqft INTEGER,
      median_ppsf_cents INTEGER
    );
    CREATE INDEX IF NOT EXISTS type_snapshots_building_idx
      ON type_snapshots(building_slug, bedrooms, observed_at);
    CREATE INDEX IF NOT EXISTS type_snapshots_time_idx ON type_snapshots(observed_at);
  `);
}
