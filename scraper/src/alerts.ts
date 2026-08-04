import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeDelta } from "../../shared/src/delta";
import { SnapshotSchema, type Snapshot } from "../../shared/src/types";
import { loadConfig } from "./run";

/**
 * Compare the two latest snapshots and produce a GitHub-issue-ready markdown
 * alert covering only the bed counts the user shops for (config.focus).
 * Writes nothing when there is nothing worth a notification.
 */

export interface AlertResult {
  markdown: string | null;
  title: string | null;
  drops: number;
  newUnits: number;
  errors: number;
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
  const prev = snaps[snaps.length - 2]!;

  const dropLines: string[] = [];
  const newLines: string[] = [];
  const errorLines: string[] = [];

  for (const bs of latest.buildings) {
    const name = nameOf.get(bs.buildingId) ?? bs.buildingId;
    if (bs.status === "error") {
      errorLines.push(`- ⚠ **${name}** scrape failed: ${bs.error ?? "unknown error"}`);
      continue;
    }
    const prevBs = prev.buildings.find((b) => b.buildingId === bs.buildingId);
    if (!prevBs || prevBs.status !== "ok") continue;

    const bedsByUnit = new Map(
      bs.units.filter((u) => u.unitNumber).map((u) => [u.unitNumber!, u]),
    );
    const delta = computeDelta(prevBs.units, bs.units, prev.timestamp, latest.timestamp);

    for (const c of delta.priceChanges) {
      const unit = bedsByUnit.get(c.unitNumber);
      if (!unit || !inFocus(unit.beds) || c.to >= c.from) continue;
      dropLines.push(
        `- **${name}** #${c.unitNumber} (${unit.beds === 0 ? "studio" : `${unit.beds} BR`}${unit.sqft ? `, ${unit.sqft} sqft` : ""}): $${c.from.toLocaleString()} → **$${c.to.toLocaleString()}** (▼$${(c.from - c.to).toLocaleString()})`,
      );
    }
    for (const u of delta.newUnits) {
      if (!inFocus(u.beds)) continue;
      newLines.push(
        `- **${name}** #${u.unitNumber} (${u.beds === 0 ? "studio" : `${u.beds} BR`}${u.sqft ? `, ${u.sqft} sqft` : ""}) listed at **$${u.price.toLocaleString()}**${u.availableDate ? `, available ${u.availableDate}` : ""}`,
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
    `\n[Open the dashboard](https://rooneydude.github.io/chiapartment/) · snapshot ${latest.timestamp}`,
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
