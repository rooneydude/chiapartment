import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Storage model.
 *
 * The important shape here is that `units` holds the *current* state of a
 * listing while `priceSnapshots` is append-only. Rent on these buildings moves
 * daily — sometimes twice a day — so the history is the product, not a
 * side-effect. Nothing in the pipeline ever updates a snapshot row.
 */

const now = sql`(unixepoch())`;

export const buildings = sqliteTable("buildings", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  websiteUrl: text("website_url"),
  address: text("address"),
  neighborhood: text("neighborhood"),
  lat: real("lat"),
  lng: real("lng"),
  /** Detected leasing platform, e.g. "entrata", "rentcafe". */
  platform: text("platform"),
  /** Serialized BuildingSpec — the 3D massing. Null until inferred. */
  specJson: text("spec_json"),
  /** Serialized FloorPlate[] — how units tile a floor. Null until inferred. */
  plateJson: text("plate_json"),
  /** How much of the spec is measured vs inferred vs guessed. */
  specConfidence: text("spec_confidence"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const sources = sqliteTable(
  "sources",
  {
    slug: text("slug").primaryKey(),
    buildingSlug: text("building_slug")
      .notNull()
      .references(() => buildings.slug, { onDelete: "cascade" }),
    /** Page the adapter starts from. */
    url: text("url").notNull(),
    platform: text("platform"),
    /** Adapter id resolved at --add time; re-detected when parsing fails. */
    adapter: text("adapter"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Result of the last robots.txt check. Scrapes refuse to run when false. */
    robotsAllowed: integer("robots_allowed", { mode: "boolean" }),
    robotsCheckedAt: integer("robots_checked_at"),
    /** Politeness: minimum seconds between requests to this host. */
    crawlDelaySec: real("crawl_delay_sec").notNull().default(2),
    notes: text("notes"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("sources_building_idx").on(t.buildingSlug)],
);

export const floorplans = sqliteTable(
  "floorplans",
  {
    id: text("id").primaryKey(), // `${buildingSlug}:${planKey}`
    buildingSlug: text("building_slug")
      .notNull()
      .references(() => buildings.slug, { onDelete: "cascade" }),
    /** The building's own name for the plan, e.g. "The Wells" or "A2". */
    name: text("name").notNull(),
    bedrooms: real("bedrooms"),
    bathrooms: real("bathrooms"),
    sqft: integer("sqft"),
    /** Remote floorplan image, as advertised on the listing page. */
    imageUrl: text("image_url"),
    /** Local path once downloaded, relative to the data directory. */
    imagePath: text("image_path"),
    /** Serialized UnitPlan produced by the tracer. Null until traced. */
    planJson: text("plan_json"),
    tracedAt: integer("traced_at"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("floorplans_building_idx").on(t.buildingSlug)],
);

export const units = sqliteTable(
  "units",
  {
    id: text("id").primaryKey(), // `${buildingSlug}:${unitCode}`
    buildingSlug: text("building_slug")
      .notNull()
      .references(() => buildings.slug, { onDelete: "cascade" }),
    /** Unit label exactly as the building publishes it. */
    unitCode: text("unit_code").notNull(),
    /** Parsed from unitCode; null when the label carries no floor info. */
    floor: integer("floor"),
    line: text("line"),
    wing: text("wing"),
    floorplanId: text("floorplan_id").references(() => floorplans.id, {
      onDelete: "set null",
    }),
    bedrooms: real("bedrooms"),
    bathrooms: real("bathrooms"),
    sqft: integer("sqft"),
    /** Compass bearing the unit's main windows face, once the plate is solved. */
    facingDeg: real("facing_deg"),
    /** 0-100 view score from the occlusion model. */
    viewScore: real("view_score"),

    // --- current listing state (overwritten every run) ---
    status: text("status", {
      enum: ["available", "leased", "unknown"],
    })
      .notNull()
      .default("unknown"),
    rent: integer("rent"),
    /** Rent before concessions/specials, when the site shows both. */
    marketRent: integer("market_rent"),
    availableOn: text("available_on"), // ISO date
    leaseTermMonths: integer("lease_term_months"),
    listingUrl: text("listing_url"),

    firstSeenAt: integer("first_seen_at").notNull().default(now),
    lastSeenAt: integer("last_seen_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("units_building_code_idx").on(t.buildingSlug, t.unitCode),
    index("units_building_idx").on(t.buildingSlug),
    index("units_status_idx").on(t.status),
  ],
);

/**
 * Append-only price history. One row per (unit, observation) where anything
 * material changed — writing a row on every run would bloat the table without
 * adding information, so the runner diffs against the last snapshot first.
 */
export const priceSnapshots = sqliteTable(
  "price_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    unitId: text("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    observedAt: integer("observed_at").notNull().default(now),
    rent: integer("rent"),
    marketRent: integer("market_rent"),
    status: text("status").notNull(),
    availableOn: text("available_on"),
    leaseTermMonths: integer("lease_term_months"),
    /** Which scrape run produced this observation. */
    runId: integer("run_id").references(() => scrapeRuns.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("snapshots_unit_idx").on(t.unitId, t.observedAt),
    index("snapshots_time_idx").on(t.observedAt),
  ],
);

export const scrapeRuns = sqliteTable(
  "scrape_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceSlug: text("source_slug").notNull(),
    adapter: text("adapter"),
    startedAt: integer("started_at").notNull().default(now),
    finishedAt: integer("finished_at"),
    ok: integer("ok", { mode: "boolean" }).notNull().default(false),
    unitsFound: integer("units_found").notNull().default(0),
    unitsChanged: integer("units_changed").notNull().default(0),
    /** Non-fatal parse complaints, JSON array of strings. */
    warnings: text("warnings"),
    error: text("error"),
  },
  (t) => [index("runs_source_idx").on(t.sourceSlug, t.startedAt)],
);

/**
 * Per-bedroom-type market rollup, written once per scrape run.
 *
 * Unit-level history answers "what happened to 3208". This answers the
 * question you actually shop on — "what does a 2-bed at this building cost
 * right now, and is that up or down" — without re-aggregating the whole
 * snapshot table on every page load. One row per (building, bedrooms, run).
 */
export const typeSnapshots = sqliteTable(
  "type_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildingSlug: text("building_slug")
      .notNull()
      .references(() => buildings.slug, { onDelete: "cascade" }),
    /** 0 = studio, 1 = one bed, and so on. */
    bedrooms: real("bedrooms").notNull(),
    observedAt: integer("observed_at").notNull().default(now),
    runId: integer("run_id").references(() => scrapeRuns.id, {
      onDelete: "set null",
    }),

    availableCount: integer("available_count").notNull().default(0),
    minRent: integer("min_rent"),
    medianRent: integer("median_rent"),
    avgRent: integer("avg_rent"),
    maxRent: integer("max_rent"),
    avgSqft: integer("avg_sqft"),
    /** Median rent per square foot, in cents to keep it an integer. */
    medianPpsfCents: integer("median_ppsf_cents"),
  },
  (t) => [
    index("type_snapshots_building_idx").on(t.buildingSlug, t.bedrooms, t.observedAt),
    index("type_snapshots_time_idx").on(t.observedAt),
  ],
);

export type Building = typeof buildings.$inferSelect;
export type TypeSnapshot = typeof typeSnapshots.$inferSelect;
export type NewBuilding = typeof buildings.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type Floorplan = typeof floorplans.$inferSelect;
export type Unit = typeof units.$inferSelect;
export type NewUnit = typeof units.$inferInsert;
export type PriceSnapshot = typeof priceSnapshots.$inferSelect;
export type ScrapeRun = typeof scrapeRuns.$inferSelect;
