import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeFocusDelta,
  deltaContextFor,
  isRelisted,
  listingKey,
  pricedAgainInfo,
  type DeltaRun,
} from "../../shared/src/delta";
import { isAvailableNow, priceAtTerm, uniformReprice } from "../../shared/src/listing";
import { chicagoDate } from "../../shared/src/time";
import { SnapshotSchema, type Snapshot, type UnitListing } from "../../shared/src/types";
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
 * which lease length it headlines is not a drop, and every unit moving by the
 * same ratio at once is reported as what it almost certainly is — a
 * concession, not a rent cut.
 */

export interface AlertResult {
  markdown: string | null;
  title: string | null;
  drops: number;
  newUnits: number;
  errors: number;
}

/** Every successful scrape of one building, oldest first. */
function okRunsOf(snaps: Snapshot[], buildingId: string): DeltaRun[] {
  const ok: DeltaRun[] = [];
  for (const snap of snaps) {
    const bs = snap.buildings.find((b) => b.buildingId === buildingId);
    if (!bs || bs.status !== "ok") continue;
    ok.push({
      timestamp: snap.timestamp,
      units: bs.units,
      omitted: bs.omitted ?? [],
      // Left undefined on runs that did not record such rows (before 15 Nov 2026).
      alsoListed: bs.alsoListed,
    });
  }
  return ok;
}

/** The building's most recent consecutive failures: how many, and how many were refusals. */
function failureStreak(snaps: Snapshot[], buildingId: string): { failed: number; refused: number } {
  let failed = 0;
  let refused = 0;
  for (let i = snaps.length - 1; i >= 0; i--) {
    const bs = snaps[i]!.buildings.find((b) => b.buildingId === buildingId);
    if (!bs) continue;
    if (bs.status === "ok") break;
    failed++;
    // Only an unbroken run of refusals counts as "refused N times".
    if (bs.blocked && refused === failed - 1) refused++;
  }
  return { failed, refused };
}

const shortDay = (iso: string): string =>
  new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: iso.length === 10 ? "UTC" : "America/Chicago",
  });

const bedsText = (beds: number): string => (beds === 0 ? "studio" : `${beds} BR`);
const usd = (n: number): string => `$${n.toLocaleString("en-US")}`;

/**
 * Text that came from a leasing site (or an error message), made safe to
 * paste into a markdown list item: one line, no markup of its own.
 */
export function plain(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/<!--|-->/g, "")
    .replace(/[\\`*_[\]<>|#]/g, (c) => `\\${c}`)
    .trim();
}

/** "#0624" or the floor-plan name, with the site's text made safe. */
const labelOf = (u: Pick<UnitListing, "unitNumber" | "floorplanName">): string =>
  u.unitNumber ? `#${plain(u.unitNumber)}` : plain(u.floorplanName);

/** "move-in now" / "move-in Dec 26, 2026" / "" when the site gives no date. */
function moveInText(u: UnitListing, asOf: string): string {
  const now = isAvailableNow(u, asOf);
  if (now === true) return "move-in now";
  if (u.availableDate) return `move-in ${shortDay(u.availableDate)}`;
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
    // One unreadable file — bad JSON or bad shape — must not silence alerting
    // for everything else.
    try {
      const parsed = SnapshotSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (parsed.success) out.push(parsed.data);
      else console.warn(`alerts: skipping invalid snapshot ${f}`);
    } catch (err) {
      console.warn(`alerts: skipping unreadable snapshot ${f} (${err instanceof Error ? err.message : err})`);
    }
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function buildAlerts(root: string, snapshots?: Snapshot[]): AlertResult {
  const config = loadConfig(root);
  const focusBeds = config.focus?.beds ?? null;
  const compareTerm = config.focus?.compareLeaseTermMonths ?? 12;
  const nameOf = new Map(config.buildings.map((b) => [b.id, b.name]));
  const none: AlertResult = { markdown: null, title: null, drops: 0, newUnits: 0, errors: 0 };

  const snaps = snapshots ?? loadSnapshots(root);
  if (snaps.length < 2) return none;

  const latest = snaps[snaps.length - 1]!;

  const dropLines: string[] = [];
  // Drops that are part of an across-the-board repricing: a concession.
  const concessionLines: string[] = [];
  const newLines: string[] = [];
  const errorLines: string[] = [];
  // Move-in date changes ride along with an alert; alone they do not raise one.
  const dateLines: string[] = [];

  for (const building of config.buildings) {
    const name = plain(nameOf.get(building.id) ?? building.id);
    const latestBs = latest.buildings.find((b) => b.buildingId === building.id);
    // Not part of this run (single-building refresh): nothing new to say.
    if (!latestBs) continue;
    const okRuns = okRunsOf(snaps, building.id);
    if (latestBs.status === "error") {
      const streak = failureStreak(snaps, building.id);
      const lastGood = okRuns[okRuns.length - 1];
      const since = lastGood ? ` Showing data from ${shortDay(lastGood.timestamp)}.` : "";
      if (latestBs.blocked) {
        // One refusal by a site's bot protection is routine and fixes itself
        // on the next run; only a streak is worth a notification.
        if (streak.failed >= 2) {
          errorLines.push(
            streak.refused === streak.failed
              ? `- ⚠ **${name}**: the site's bot protection has refused the last ${streak.refused} scrapes.${since}`
              : `- ⚠ **${name}**: the last ${streak.failed} scrapes failed (the latest was refused by the site's bot protection).${since}`,
          );
        }
      } else {
        errorLines.push(
          `- ⚠ **${name}** scrape failed${streak.failed > 1 ? ` (${streak.failed} runs in a row)` : ""}: ${plain(latestBs.error ?? "unknown error")}${since}`,
        );
      }
      continue;
    }

    if (okRuns.length < 2) continue;
    const pair = { prev: okRuns[okRuns.length - 2]!, curr: okRuns[okRuns.length - 1]! };
    if (pair.curr.timestamp !== latest.timestamp) continue;

    const delta = computeFocusDelta(
      pair.prev.units,
      pair.curr.units,
      pair.prev.timestamp,
      pair.curr.timestamp,
      focusBeds,
      deltaContextFor(okRuns, pair.prev, pair.curr),
    );
    // Every unit moving by the same ratio at once: a concession netted into
    // (or taken out of) the advertised rents, not a change in base rent.
    const concession = uniformReprice(pair.prev.units, pair.curr.units);
    const reclassified = new Set(delta.reclassifiedKeys ?? []);
    const concessionLinesBefore = concessionLines.length;

    for (const c of delta.priceChanges) {
      if (c.to >= c.from || c.notComparable) continue;
      const unit = pair.curr.units.find(
        (u) => (u.unitNumber ?? u.floorplanName) === c.unitNumber,
      );
      const label = c.unitNumber === c.floorplanName ? plain(c.floorplanName) : `#${plain(c.unitNumber)}`;
      const termBit =
        c.fromTerm !== undefined && c.fromTerm === c.toTerm
          ? `${c.fromTerm}-mo lease`
          : c.fromTerm !== undefined && c.toTerm !== undefined
            ? `advertised lease ${c.fromTerm} → ${c.toTerm} mo`
            : "";
      const detail = [
        bedsText(c.beds),
        unit?.sqft ? `${unit.sqft} sqft` : "",
        termBit,
        unit ? moveInText(unit, pair.curr.timestamp) : "",
      ].filter(Boolean);
      // Stead 220's page trails its price edits by days: say when the
      // building itself set the price, not just when the tracker saw it.
      const setOn = c.sourceUpdatedAt ? ` — set by the building on ${shortDay(c.sourceUpdatedAt)}` : "";
      // Measured from an earlier run when the unit was printed in another form in between.
      const since = c.since ? ` (since ${shortDay(c.since)})` : "";
      (concession ? concessionLines : dropLines).push(
        `- **${name}** ${label} (${detail.join(", ")}): ${usd(c.from)} → **${usd(c.to)}** (▼${usd(c.from - c.to)})${since}${setOn}`,
      );
    }
    if (concession && concessionLines.length > concessionLinesBefore) {
      const notices = (latestBs.notices ?? []).map((n) => `“${plain(n)}”`).join(" ");
      concessionLines.push(
        `  - _All ${concession.units} ${name} units listed in both runs moved by the same ${concession.ratio < 1 ? "−" : "+"}${(Math.abs(concession.ratio - 1) * 100).toFixed(1)}% at once._${notices ? ` The site says: ${notices}` : ""}`,
      );
    }

    for (const u of delta.newUnits) {
      const detail = [u.planType ? plain(u.planType) : bedsText(u.beds), u.sqft ? `${u.sqft} sqft` : ""].filter(Boolean);
      const tail = [leaseText(u, compareTerm), moveInText(u, pair.curr.timestamp)].filter(Boolean);
      const range = u.priceMax !== undefined ? `–${usd(u.priceMax)}` : "";
      const again = pricedAgainInfo(delta, u);
      // What kind of "new": a first appearance, back after an absence, a
      // price published for a listing that had none, or a unit that now
      // counts among the sizes being shopped for.
      let verb = "listed at";
      let was = "";
      if (again) {
        verb = again.lastPrice !== undefined ? "has a price again:" : "now has a price:";
        if (again.lastPrice !== undefined && again.lastPricedAt) {
          const diff = u.price - again.lastPrice;
          was = ` (was ${usd(again.lastPrice)} on ${shortDay(again.lastPricedAt)}${diff !== 0 ? `, ${diff < 0 ? "▼" : "▲"}${usd(Math.abs(diff))}` : ""})`;
        }
      } else if (reclassified.has(listingKey(u))) {
        verb = `now counted as a ${bedsText(u.beds)}:`;
      } else if (isRelisted(delta, u)) {
        verb = "back on the site at";
      }
      newLines.push(
        `- **${name}** ${labelOf(u)} (${detail.join(", ")}) ${verb} **${usd(u.price)}${range}**${was}${tail.length ? ` · ${tail.join(" · ")}` : ""}`,
      );
    }
    for (const row of delta.newAlsoListed ?? []) {
      const label = row.unitNumber ? `#${plain(row.unitNumber)} ${plain(row.floorplanName)}` : plain(row.floorplanName);
      newLines.push(
        `- **${name}** ${label}${row.beds !== null ? ` (${bedsText(row.beds)})` : ""} appeared without a price — ${plain(row.note)}`,
      );
    }
    for (const c of delta.dateChanges ?? []) {
      const label = c.unitNumber === c.floorplanName ? plain(c.floorplanName) : `#${plain(c.unitNumber)}`;
      const day = (d: string | null): string => (d ? shortDay(d) : "now");
      dateLines.push(`- **${name}** ${label} (${bedsText(c.beds)}): move-in ${day(c.from)} → **${day(c.to)}**`);
    }
  }

  const drops = dropLines.length + concessionLines.filter((l) => l.startsWith("- ")).length;
  if (drops + newLines.length + errorLines.length === 0) return none;

  const parts: string[] = [];
  if (dropLines.length) parts.push(`## 📉 Price drops\n${dropLines.join("\n")}`);
  if (concessionLines.length) {
    parts.push(
      `## 🏷 Repriced across the board — probably a concession, not a rent cut\n${concessionLines.join("\n")}`,
    );
  }
  if (newLines.length) parts.push(`## 🆕 New listings\n${newLines.join("\n")}`);
  if (dateLines.length) parts.push(`## 📅 Move-in dates changed\n${dateLines.join("\n")}`);
  if (errorLines.length) parts.push(`## Scrape problems\n${errorLines.join("\n")}`);
  parts.push(
    `\n[Open the dashboard](https://rooneydude.github.io/chiapartment/) · snapshot ${latest.timestamp} · weekday brief: [brief.json](https://rooneydude.github.io/chiapartment/data/brief.json)`,
  );

  const titleBits: string[] = [];
  if (drops) titleBits.push(`${drops} drop${drops > 1 ? "s" : ""}`);
  if (newLines.length) titleBits.push(`${newLines.length} new`);
  if (errorLines.length) titleBits.push(`${errorLines.length} error${errorLines.length > 1 ? "s" : ""}`);

  return {
    markdown: parts.join("\n\n"),
    // The day in Chicago, where the buildings and their shopper are.
    title: `Price alert ${chicagoDate(latest.timestamp)}: ${titleBits.join(", ")}`,
    drops,
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
