import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeDelta, listingKey, listingLabel } from "../../shared/src/delta";
import { isAvailableNow, priceAtTerm } from "../../shared/src/listing";
import {
  SnapshotSchema,
  type OmittedListing,
  type Snapshot,
  type UnitListing,
} from "../../shared/src/types";
import { loadConfig } from "./run";

/**
 * Compare the last two *successful* scrapes per building and produce a
 * GitHub-issue-ready markdown alert covering only the bed counts the user
 * shops for (config.focus). Writes nothing when there is nothing worth a
 * notification. Floorplan-only listings (Stead stacks) participate via
 * floorplan+beds identity.
 *
 * Only buildings the LATEST snapshot actually scraped are considered, so a
 * manual single-building refresh never re-announces yesterday's changes for
 * every other building. Price moves are like-for-like: the site switching
 * which lease length it headlines is not a drop.
 */

export interface AlertResult {
  markdown: string | null;
  title: string | null;
  drops: number;
  newUnits: number;
  errors: number;
}

interface OkRun {
  timestamp: string;
  units: UnitListing[];
  omitted: OmittedListing[];
}

function lastTwoOk(snaps: Snapshot[], buildingId: string): { prev: OkRun; curr: OkRun } | null {
  const ok: OkRun[] = [];
  for (const snap of snaps) {
    const bs = snap.buildings.find((b) => b.buildingId === buildingId);
    if (!bs || bs.status !== "ok") continue;
    ok.push({ timestamp: snap.timestamp, units: bs.units, omitted: bs.omitted ?? [] });
  }
  if (ok.length < 2) return null;
  return { prev: ok[ok.length - 2]!, curr: ok[ok.length - 1]! };
}

const bedsText = (beds: number): string => (beds === 0 ? "studio" : `${beds} BR`);
const usd = (n: number): string => `$${n.toLocaleString("en-US")}`;

/** "move-in now" / "move-in Dec 26, 2026" / "" when the site gives no date. */
function moveInText(u: UnitListing, asOf: string): string {
  const now = isAvailableNow(u, asOf);
  if (now === true) return "move-in now";
  if (u.availableDate) {
    const d = new Date(`${u.availableDate}T12:00:00Z`);
    return `move-in ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  }
  return "";
}

/** "18-mo lease; 12-mo $4,955" — whatever the site publishes about terms. */
function leaseText(u: UnitListing, compareTerm: number): string {
  const bits: string[] = [];
  if (u.leaseTermMonths != null) bits.push(`${u.leaseTermMonths}-mo lease`);
  const atCompare = priceAtTerm(u, compareTerm);
  if (atCompare !== null && u.leaseTermMonths !== compareTerm) {
    bits.push(`${compareTerm}-mo ${usd(atCompare)}`);
  }
  return bits.join("; ");
}

export function loadSnapshots(root: string): Snapshot[] {
  const dir = join(root, "data", "snapshots");
  if (!existsSync(dir)) return [];
  const out: Snapshot[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    // One unreadable file must not silence alerting for everything else.
    const parsed = SnapshotSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    if (parsed.success) out.push(parsed.data);
    else console.warn(`alerts: skipping invalid snapshot ${f}`);
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function buildAlerts(root: string, snapshots?: Snapshot[]): AlertResult {
  const config = loadConfig(root);
  const focusBeds = config.focus?.beds ?? null;
  const compareTerm = config.focus?.compareLeaseTermMonths ?? 12;
  const inFocus = (beds: number) => focusBeds === null || focusBeds.includes(beds);
  const nameOf = new Map(config.buildings.map((b) => [b.id, b.name]));
  const none: AlertResult = { markdown: null, title: null, drops: 0, newUnits: 0, errors: 0 };

  const snaps = snapshots ?? loadSnapshots(root);
  if (snaps.length < 2) return none;

  const latest = snaps[snaps.length - 1]!;

  const dropLines: string[] = [];
  const newLines: string[] = [];
  const errorLines: string[] = [];

  for (const building of config.buildings) {
    const name = nameOf.get(building.id) ?? building.id;
    const latestBs = latest.buildings.find((b) => b.buildingId === building.id);
    // Not part of this run (single-building refresh): nothing new to say.
    if (!latestBs) continue;
    if (latestBs.status === "error") {
      errorLines.push(`- ⚠ **${name}** scrape failed: ${latestBs.error ?? "unknown error"}`);
      continue;
    }

    const pair = lastTwoOk(snaps, building.id);
    if (!pair || pair.curr.timestamp !== latest.timestamp) continue;

    const delta = computeDelta(
      pair.prev.units,
      pair.curr.units,
      pair.prev.timestamp,
      pair.curr.timestamp,
      pair.prev.omitted.map(listingKey),
    );

    for (const c of delta.priceChanges) {
      if (!inFocus(c.beds) || c.to >= c.from || c.notComparable) continue;
      const unit = pair.curr.units.find(
        (u) => (u.unitNumber ?? u.floorplanName) === c.unitNumber,
      );
      const label = c.unitNumber === c.floorplanName ? c.floorplanName : `#${c.unitNumber}`;
      const detail = [
        bedsText(c.beds),
        unit?.sqft ? `${unit.sqft} sqft` : "",
        c.fromTerm !== undefined && c.fromTerm === c.toTerm ? `${c.fromTerm}-mo lease` : "",
        unit ? moveInText(unit, pair.curr.timestamp) : "",
      ].filter(Boolean);
      dropLines.push(
        `- **${name}** ${label} (${detail.join(", ")}): ${usd(c.from)} → **${usd(c.to)}** (▼${usd(c.from - c.to)})`,
      );
    }
    for (const u of delta.newUnits) {
      if (!inFocus(u.beds)) continue;
      const detail = [bedsText(u.beds), u.sqft ? `${u.sqft} sqft` : ""].filter(Boolean);
      const tail = [leaseText(u, compareTerm), moveInText(u, pair.curr.timestamp)].filter(Boolean);
      const range = u.priceMax !== undefined ? `–${usd(u.priceMax)}` : "";
      newLines.push(
        `- **${name}** ${listingLabel(u)} (${detail.join(", ")}) listed at **${usd(u.price)}${range}**${tail.length ? ` · ${tail.join(" · ")}` : ""}`,
      );
    }
  }

  if (dropLines.length + newLines.length + errorLines.length === 0) return none;

  const parts: string[] = [];
  if (dropLines.length) parts.push(`## 📉 Price drops\n${dropLines.join("\n")}`);
  if (newLines.length) parts.push(`## 🆕 New listings\n${newLines.join("\n")}`);
  if (errorLines.length) parts.push(`## Scrape problems\n${errorLines.join("\n")}`);
  parts.push(
    `\n[Open the dashboard](https://rooneydude.github.io/chiapartment/) · snapshot ${latest.timestamp} · weekday brief: [brief.json](https://rooneydude.github.io/chiapartment/data/brief.json)`,
  );

  const titleBits: string[] = [];
  if (dropLines.length) titleBits.push(`${dropLines.length} drop${dropLines.length > 1 ? "s" : ""}`);
  if (newLines.length) titleBits.push(`${newLines.length} new`);
  if (errorLines.length) titleBits.push(`${errorLines.length} error${errorLines.length > 1 ? "s" : ""}`);

  return {
    markdown: parts.join("\n\n"),
    title: `Price alert ${latest.timestamp.slice(0, 10)}: ${titleBits.join(", ")}`,
    drops: dropLines.length,
    newUnits: newLines.length,
    errors: errorLines.length,
  };
}

/** CLI entry: write body/title files for the workflow when alerts exist. */
export function runAlerts(root: string, outDir: string): boolean {
  const result = buildAlerts(root);
  if (!result.markdown) {
    console.log("No alerts — nothing changed worth a notification.");
    return false;
  }
  writeFileSync(join(outDir, "alert-body.md"), result.markdown);
  writeFileSync(join(outDir, "alert-title.txt"), result.title!);
  console.log(
    `Alert: ${result.title} (${result.drops} drops, ${result.newUnits} new, ${result.errors} errors)`,
  );
  return true;
}
