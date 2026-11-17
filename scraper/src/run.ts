import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listingKey, listingLabel } from "../../shared/src/delta";
import {
  AlsoListedSchema,
  BuildingSnapshotSchema,
  BuildingsConfigSchema,
  SnapshotSchema,
  UnitListingSchema,
  type AlsoListed,
  type BuildingConfig,
  type BuildingsConfig,
  type BuildingSnapshot,
  type Snapshot,
  type UnitListing,
} from "../../shared/src/types";
import { resolveAdapter } from "./adapters/index";
import { SiteBlockedError, type Adapter, type AdapterContext } from "./adapters/types";
import { makeFixtureFetch, makeRecorder } from "./fixtures";
import { httpFetch, sleep } from "./http";

export interface RefreshOptions {
  fixtures: boolean;
  capture: boolean;
  commit: boolean;
  buildings: string[] | null; // null = all
}

const POLITE_DELAY_MS = 1500;
/** How long to wait before looking again at a page that changed pricing form. */
const STABILITY_RECHECK_MS = 75_000;
/** How many of the newest snapshot files to search for a building's last ok run. */
const PREVIOUS_LOOKBACK_FILES = 12;

export function loadConfig(root: string): BuildingsConfig {
  const path = join(root, "buildings.json");
  if (!existsSync(path)) {
    throw new Error(`buildings.json not found at ${path} — run from the repo root`);
  }
  return BuildingsConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export type ScrapeResult = Omit<BuildingSnapshot, "buildingId">;

/**
 * Keep only what fits the snapshot format. A row an adapter got wrong (a
 * null bed count, a price of 0) must cost that one row — moved to the
 * also-listed list when it can be named — never the whole run: the snapshot
 * is validated before it is written, and a single bad row would otherwise
 * throw away every building's data for the day.
 */
export function sanitizeListings(
  units: readonly unknown[],
  alsoListed: readonly unknown[],
  log: (msg: string) => void,
): { units: UnitListing[]; alsoListed: AlsoListed[] } {
  const goodUnits: UnitListing[] = [];
  const goodAlso: AlsoListed[] = [];
  for (const row of alsoListed) {
    const parsed = AlsoListedSchema.safeParse(row);
    if (parsed.success) goodAlso.push(parsed.data);
    else log(`dropped a malformed also-listed row (${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message})`);
  }
  for (const row of units) {
    const parsed = UnitListingSchema.safeParse(row);
    if (parsed.success) {
      goodUnits.push(parsed.data);
      continue;
    }
    const issue = parsed.error.issues[0];
    const why = `${issue?.path.join(".") || "row"}: ${issue?.message ?? "invalid"}`;
    const r = (row ?? {}) as Record<string, unknown>;
    const unitNumber = typeof r["unitNumber"] === "string" && r["unitNumber"] ? r["unitNumber"] : null;
    const floorplanName = typeof r["floorplanName"] === "string" && r["floorplanName"] ? r["floorplanName"] : "Unit";
    log(`unit ${unitNumber ?? floorplanName}: the scraper produced a row that does not fit the format (${why}) — kept in the also-listed list`);
    goodAlso.push({
      unitNumber,
      floorplanName,
      beds: null,
      note: "Listed, but its details could not be read",
    });
  }
  return { units: goodUnits, alsoListed: goodAlso };
}

/**
 * Last line of defence before writing: a building entry that still does not
 * fit the format becomes that building's scrape error, so the others land.
 */
export function quarantineInvalidBuildings(snapshot: Snapshot): string[] {
  const bad: string[] = [];
  snapshot.buildings = snapshot.buildings.map((b) => {
    const parsed = BuildingSnapshotSchema.safeParse(b);
    if (parsed.success) return b;
    const issue = parsed.error.issues[0];
    bad.push(b.buildingId);
    return {
      buildingId: b.buildingId,
      status: "error" as const,
      error: `the scraper produced data that does not fit the snapshot format (${issue?.path.join(".")}: ${issue?.message})`,
      source: { adapter: b.source?.adapter ?? "unknown", fetchedUrl: b.source?.fetchedUrl ?? "" },
      units: [],
    };
  });
  return bad;
}

export async function scrapeOne(
  root: string,
  building: BuildingConfig,
  opts: RefreshOptions,
  /** The adapter to run; tests pass their own. */
  adapter: Adapter = resolveAdapter(building.adapter),
): Promise<ScrapeResult> {
  const fixtureDir = join(root, "scraper", "fixtures", building.id);
  const recorder = opts.capture ? makeRecorder(fixtureDir) : null;
  const alsoListed: AlsoListed[] = [];
  const notices: string[] = [];
  const gaps: string[] = [];
  // What was actually requested, so a snapshot says where its numbers came from.
  const requested: string[] = [];
  const baseFetch = opts.fixtures ? makeFixtureFetch(fixtureDir) : httpFetch;
  const trackedFetch: typeof fetch = (input, init) => {
    requested.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return baseFetch(input, init);
  };
  const source = (): BuildingSnapshot["source"] => ({
    adapter: adapter.id,
    fetchedUrl: requested[0] ?? building.url,
    ...(requested.length > 0 ? { requests: requested.length } : {}),
  });
  const ctx: AdapterContext = {
    fetch: trackedFetch,
    log: (msg) => console.log(`  [${building.id}] ${msg}`),
    ...(recorder ? { record: recorder.record } : {}),
    // Fixture runs are offline — no need to be polite to a directory.
    ...(opts.fixtures ? {} : { pause: sleep }),
    reportAlsoListed: (row) => alsoListed.push(row),
    reportNotice: (text) => {
      if (!notices.includes(text)) notices.push(text);
    },
    reportGap: (text) => {
      if (!gaps.includes(text)) gaps.push(text);
    },
  };
  console.log(`Scraping ${building.name} (${adapter.id})...`);
  try {
    const scraped = await adapter.scrape(building, ctx);
    const clean = sanitizeListings(scraped, alsoListed, ctx.log);
    console.log(
      `  → ${clean.units.length} listings${clean.alsoListed.length ? ` (+${clean.alsoListed.length} listed without a price / bed count)` : ""}`,
    );
    return {
      status: "ok",
      source: source(),
      units: clean.units,
      // Always written, even when empty: "this run looked and found none" is
      // what lets the next run say a row without a price is new.
      alsoListed: clean.alsoListed,
      ...(notices.length > 0 ? { notices } : {}),
      ...(gaps.length > 0 ? { gaps } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const blocked = err instanceof SiteBlockedError;
    console.error(`  → ${blocked ? "BLOCKED" : "FAILED"}: ${message}`);
    return {
      status: "error",
      error: message,
      ...(blocked ? { blocked: true } : {}),
      source: source(),
      units: [],
    };
  } finally {
    recorder?.flush();
  }
}

/**
 * The last successful scrape of each wanted building, looked up in the
 * newest snapshot files. Used only to sanity-check a fresh scrape — nothing
 * is ever copied forward from it.
 */
export function loadPreviousOk(root: string, buildingIds: string[]): Map<string, UnitListing[]> {
  const found = new Map<string, UnitListing[]>();
  const dir = join(root, "data", "snapshots");
  if (!existsSync(dir)) return found;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, PREVIOUS_LOOKBACK_FILES);
  for (const f of files) {
    if (buildingIds.every((id) => found.has(id))) break;
    // A half-written or empty file must not stop today's scrape.
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      console.warn(`Skipping unreadable snapshot ${f} while looking up the previous run.`);
      continue;
    }
    const parsed = SnapshotSchema.safeParse(raw);
    if (!parsed.success) continue;
    for (const b of parsed.data.buildings) {
      if (b.status === "ok" && buildingIds.includes(b.buildingId) && !found.has(b.buildingId)) {
        found.set(b.buildingId, b.units);
      }
    }
  }
  return found;
}

/**
 * Units whose quote changed FORM since the previous run — a rent range one
 * time, a different single price the other. Old Town Park's site alternates
 * between two such pricing states for some plans, minutes apart, with no
 * real change behind it.
 */
export function priceFormFlips(prev: UnitListing[] | null, curr: UnitListing[]): string[] {
  if (!prev) return [];
  const before = new Map(prev.map((u) => [listingKey(u), u]));
  const flips: string[] = [];
  for (const u of curr) {
    const was = before.get(listingKey(u));
    if (!was) continue;
    const formChanged = (was.priceMax !== undefined) !== (u.priceMax !== undefined);
    if (formChanged && was.price !== u.price) flips.push(listingLabel(u));
  }
  return flips;
}

/**
 * Two observations of the same page taken a minute apart, when the first
 * showed units flipping pricing form. If the second agrees with the previous
 * run more than the first does, the first caught the site mid-flip: keep the
 * second. If both agree with each other the change is real: keep the later
 * one. A failed second look never replaces a good first one.
 */
export function pickStableObservation(
  prev: UnitListing[] | null,
  first: ScrapeResult,
  second: ScrapeResult,
): { result: ScrapeResult; picked: "first" | "second"; flips: [number, number] } {
  const keepFirst = (): ReturnType<typeof pickStableObservation> => ({
    result: first,
    picked: "first",
    flips: [priceFormFlips(prev, first.units).length, -1],
  });
  if (second.status !== "ok" || second.units.length === 0) return keepFirst();
  // A second look that returned only part of the page has fewer units to
  // flip — it must not win for that. Short of ~the same page, keep the first.
  if (second.units.length < first.units.length * 0.8) return keepFirst();
  // Judge both looks on the units they have in common.
  const inFirst = new Set(first.units.map(listingKey));
  const inSecond = new Set(second.units.map(listingKey));
  const f1 = priceFormFlips(prev, first.units.filter((u) => inSecond.has(listingKey(u)))).length;
  const f2 = priceFormFlips(prev, second.units.filter((u) => inFirst.has(listingKey(u)))).length;
  return f2 <= f1
    ? { result: second, picked: "second", flips: [f1, f2] }
    : { result: first, picked: "first", flips: [f1, f2] };
}

/**
 * A tower whose page lists nothing is fully leased. EVERY tower of a complex
 * listing nothing in the same run is the complex's availability feed being
 * down (2026-10-01: all three Old Town Park pages were empty and back the
 * next day). Record that as a failed scrape — which keeps yesterday's data on
 * the dashboard, flagged — instead of as three sold-out buildings whose
 * units would all be announced as "new" tomorrow. Returns the ids it flagged.
 */
export function flagGroupOutages(
  buildings: BuildingConfig[],
  results: Snapshot["buildings"],
): string[] {
  const groups = new Map<string, BuildingConfig[]>();
  for (const b of buildings) {
    if (!b.group) continue;
    groups.set(b.group, [...(groups.get(b.group) ?? []), b]);
  }
  const flagged: string[] = [];
  for (const [group, members] of groups) {
    if (members.length < 2) continue;
    const entries = members.map((m) => results.find((r) => r.buildingId === m.id));
    // Not judged from a partial run: every tower must have been scraped.
    if (entries.some((e) => e === undefined)) continue;
    const emptyOk = (e: Snapshot["buildings"][number]): boolean =>
      e.status === "ok" && e.units.length === 0 && (e.alsoListed?.length ?? 0) === 0;
    // Down = no tower lists anything, and at least one answered with an empty
    // page (a tower whose request failed outright counts as "nothing" too —
    // a feed outage does not fail every request the same way).
    const down =
      entries.every((e) => e!.status === "error" || emptyOk(e!)) && entries.some((e) => emptyOk(e!));
    if (!down) continue;
    for (const e of entries) {
      if (!e || !emptyOk(e)) continue;
      e.status = "error";
      e.error = `all ${members.length} "${group}" pages listed nothing in the same run — the site's availability feed is probably down (one empty tower alone would be recorded as fully leased)`;
      delete e.notices;
      delete e.gaps;
      flagged.push(e.buildingId);
    }
  }
  return flagged;
}

/** What one run achieved, for the CI summary page and the workflow's health check. */
export function describeRun(snap: Snapshot): {
  ok: number;
  total: number;
  /** Ids of the buildings that could not be read. */
  failed: string[];
  markdown: string;
} {
  const okCount = snap.buildings.filter((b) => b.status === "ok").length;
  const failed = snap.buildings.filter((b) => b.status !== "ok").map((b) => b.buildingId);
  const cell = (text: string): string =>
    text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim().slice(0, 300);
  const rows = snap.buildings.map((b) =>
    b.status === "ok"
      ? `| ${b.buildingId} | ok | ${b.units.length} listed${b.alsoListed?.length ? `, ${b.alsoListed.length} without a price` : ""} | ${b.source.requests ?? "?"} |`
      : `| ${b.buildingId} | ${b.blocked ? "refused by the site" : "FAILED"} | ${cell(b.error ?? "unknown error")} | ${b.source.requests ?? "?"} |`,
  );
  const markdown = [
    `### Scrape ${snap.timestamp}: ${okCount}/${snap.buildings.length} buildings ok`,
    "",
    "| Building | Result | Detail | Requests |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "",
  ].join("\n");
  return { ok: okCount, total: snap.buildings.length, failed, markdown };
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
  const previous = opts.fixtures
    ? new Map<string, UnitListing[]>()
    : loadPreviousOk(root, targets.map((b) => b.id));

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
      result = await scrapeOne(root, building, opts);

      // A page caught between two pricing states gets a second look.
      const prevUnits = previous.get(building.id) ?? null;
      const flips = result.status === "ok" ? priceFormFlips(prevUnits, result.units) : [];
      if (!opts.fixtures && flips.length > 0) {
        console.log(
          `  [${building.id}] ${flips.length} unit(s) switched between a rent range and a single price since the last run (${flips.slice(0, 6).join(", ")}${flips.length > 6 ? ", …" : ""}); this site flips between two pricing states — looking again in ${STABILITY_RECHECK_MS / 1000}s`,
        );
        await sleep(STABILITY_RECHECK_MS);
        const second = await scrapeOne(root, building, opts);
        const pick = pickStableObservation(prevUnits, result, second);
        console.log(
          `  [${building.id}] kept the ${pick.picked} observation (${pick.flips[0]} vs ${pick.flips[1] < 0 ? "failed" : pick.flips[1]} form flips against the last run)`,
        );
        result = pick.result;
      }

      if (cacheKey) groupCache.set(cacheKey, result);
      if (!opts.fixtures && building !== targets[targets.length - 1]) {
        await sleep(POLITE_DELAY_MS);
      }
    } else {
      console.log(`Scraping ${building.name}: reusing group "${building.group}" result`);
    }
    snapshot.buildings.push({ buildingId: building.id, ...result });
  }

  const reportOutage = (ids: string[]): void => {
    if (ids.length > 0) {
      console.error(
        `Every page of a multi-building complex was empty (${ids.join(", ")}) — treating it as a site outage, not a sell-out.`,
      );
    }
  };
  reportOutage(flagGroupOutages(config.buildings, snapshot.buildings));

  // One retry pass for buildings that failed for an ordinary reason (a
  // timeout, a 5xx). A building whose site answered with its bot protection
  // is NOT asked again — it said no; the next scheduled run will ask afresh.
  // Skipped in fixture mode — fixtures are deterministic.
  if (!opts.fixtures) {
    const refused = snapshot.buildings.filter((b) => b.status === "error" && b.blocked);
    if (refused.length > 0) {
      console.log(
        `Not retrying ${refused.map((b) => b.buildingId).join(", ")}: refused by the site's bot protection.`,
      );
    }
    const failed = snapshot.buildings.filter((b) => b.status === "error" && !b.blocked);
    if (failed.length > 0) {
      console.log(`Retrying ${failed.length} failed building(s) after a pause...`);
      await sleep(8_000);
      for (const [i, fail] of failed.entries()) {
        const building = targets.find((b) => b.id === fail.buildingId);
        if (!building) continue;
        const result = await scrapeOne(root, building, opts);
        const idx = snapshot.buildings.findIndex((b) => b.buildingId === fail.buildingId);
        if (idx >= 0) snapshot.buildings[idx] = { buildingId: building.id, ...result };
        if (i < failed.length - 1) await sleep(POLITE_DELAY_MS);
      }
      reportOutage(flagGroupOutages(config.buildings, snapshot.buildings));
    }
  }

  const quarantined = quarantineInvalidBuildings(snapshot);
  if (quarantined.length > 0) {
    console.error(`Recorded as failed (their data did not fit the snapshot format): ${quarantined.join(", ")}`);
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
