import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeDelta, listingLabel } from "../../shared/src/delta";
import { SnapshotSchema, type Snapshot } from "../../shared/src/types";
import { loadConfig } from "./run";

/**
 * Compare the last two *successful* scrapes per building and produce a
 * GitHub-issue-ready markdown alert covering only the bed counts the user
 * shops for (config.focus). Writes nothing when there is nothing worth a
 * notification. Floorplan-only listings (Stead stacks) participate via
 * floorplan+beds identity.
 */

export interface AlertResult {
  markdown: string | null;
  title: string | null;
  drops: number;
  newUnits: number;
  errors: number;
}

function lastTwoOk(
  snaps: Snapshot[],
  buildingId: string,
): { prev: { timestamp: string; units: Snapshot["buildings"][number]["units"] }; curr: { timestamp: string; units: Snapshot["buildings"][number]["units"] } } | null {
  const ok: { timestamp: string; units: Snapshot["buildings"][number]["units"] }[] = [];
  for (const snap of snaps) {
    const bs = snap.buildings.find((b) => b.buildingId === buildingId);
    if (!bs || bs.status !== "ok") continue;
    ok.push({ timestamp: snap.timestamp, units: bs.units });
  }
  if (ok.length < 2) return null;
  const curr = ok[ok.length - 1]!;
  const prev = ok[ok.length - 2]!;
  return { prev, curr };
}

export function buildAlerts(root: string, snapshots?: Snapshot[]): AlertResult {
  const config = loadConfig(root);
  const focusBeds = config.focus?.beds ?? null;
  const inFocus = (beds: number) => focusBeds === null || focusBeds.includes(beds);
  const nameOf = new Map(config.buildings.map((b) => [b.id, b.name]));

  let snaps = snapshots;
  if (!snaps) {
    const dir = join(root, "data", "snapshots");
    snaps = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => SnapshotSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))))
      : [];
  }
  if (snaps.length < 2) return { markdown: null, title: null, drops: 0, newUnits: 0, errors: 0 };

  const latest = snaps[snaps.length - 1]!;

  const dropLines: string[] = [];
  const newLines: string[] = [];
  const errorLines: string[] = [];

  for (const building of config.buildings) {
    const name = nameOf.get(building.id) ?? building.id;
    const latestBs = latest.buildings.find((b) => b.buildingId === building.id);
    if (latestBs?.status === "error") {
      errorLines.push(`- ⚠ **${name}** scrape failed: ${latestBs.error ?? "unknown error"}`);
      continue;
    }

    const pair = lastTwoOk(snaps, building.id);
    if (!pair) continue;

    const delta = computeDelta(pair.prev.units, pair.curr.units, pair.prev.timestamp, pair.curr.timestamp);

    for (const c of delta.priceChanges) {
      if (!inFocus(c.beds) || c.to >= c.from) continue;
      const unit = pair.curr.units.find(
        (u) => (u.unitNumber ?? u.floorplanName) === c.unitNumber,
      );
      const label = c.unitNumber === c.floorplanName ? c.floorplanName : `#${c.unitNumber}`;
      dropLines.push(
        `- **${name}** ${label} (${c.beds === 0 ? "studio" : `${c.beds} BR`}${unit?.sqft ? `, ${unit.sqft} sqft` : ""}): $${c.from.toLocaleString()} → **$${c.to.toLocaleString()}** (▼$${(c.from - c.to).toLocaleString()})`,
      );
    }
    for (const u of delta.newUnits) {
      if (!inFocus(u.beds)) continue;
      newLines.push(
        `- **${name}** ${listingLabel(u)} (${u.beds === 0 ? "studio" : `${u.beds} BR`}${u.sqft ? `, ${u.sqft} sqft` : ""}) listed at **$${u.price.toLocaleString()}**${u.availableDate ? `, available ${u.availableDate}` : ""}`,
      );
    }
  }

  if (dropLines.length + newLines.length + errorLines.length === 0) {
    return { markdown: null, title: null, drops: 0, newUnits: 0, errors: 0 };
  }

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
