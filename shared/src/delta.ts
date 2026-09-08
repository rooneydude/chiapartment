import type { FocusDelta, SnapshotDelta, UnitListing } from "./types";

/** Stable identity across runs: unit number, else floorplan + beds. */
export function listingKey(
  u: Pick<UnitListing, "unitNumber" | "floorplanName" | "beds">,
): string {
  if (u.unitNumber) return `u:${u.unitNumber}`;
  return `fp:${u.beds}:${u.floorplanName}`;
}

/** Human label for briefs/alerts: "#0624" or the floorplan/stack name. */
export function listingLabel(
  u: Pick<UnitListing, "unitNumber" | "floorplanName">,
): string {
  return u.unitNumber ? `#${u.unitNumber}` : u.floorplanName;
}

export const CHICAGO_TZ = "America/Chicago";

/** YYYY-MM-DD in America/Chicago. */
export function chicagoDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CHICAGO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/**
 * Last ok run whose Chicago calendar date is strictly before `latest`.
 * Same-day extra refreshes therefore still compare to yesterday, not to
 * the 10am scrape.
 */
export function priorChicagoDayRun<T extends { timestamp: string }>(
  okRuns: T[],
  latest: T,
): T | null {
  const latestDay = chicagoDate(latest.timestamp);
  for (let i = okRuns.length - 1; i >= 0; i--) {
    const run = okRuns[i]!;
    if (chicagoDate(run.timestamp) < latestDay) return run;
  }
  return null;
}

/**
 * Diff two unit lists for one building. Units are keyed by unitNumber when
 * present; floorplan-only listings (Stead stacks) use floorplanName + beds
 * so removals and price moves can alert.
 */
export function computeDelta(
  prevUnits: UnitListing[] | null,
  currUnits: UnitListing[],
  from: string | null,
  to: string,
): SnapshotDelta {
  const delta: SnapshotDelta = {
    from,
    to,
    newUnits: [],
    removedUnits: [],
    priceChanges: [],
  };
  if (prevUnits === null) return delta; // first snapshot: nothing is "new"

  const prevByKey = new Map<string, UnitListing>();
  for (const u of prevUnits) prevByKey.set(listingKey(u), u);

  const seen = new Set<string>();
  for (const u of currUnits) {
    const key = listingKey(u);
    seen.add(key);
    const prev = prevByKey.get(key);
    if (!prev) {
      delta.newUnits.push(u);
    } else if (prev.price !== u.price) {
      delta.priceChanges.push({
        unitNumber: u.unitNumber ?? u.floorplanName,
        floorplanName: u.floorplanName,
        from: prev.price,
        to: u.price,
        beds: u.beds,
      });
    }
  }
  for (const [key, u] of prevByKey) {
    if (!seen.has(key)) delta.removedUnits.push(u);
  }
  return delta;
}

export function filterFocusDelta(
  delta: SnapshotDelta,
  focusBeds: number[] | null,
): SnapshotDelta {
  if (focusBeds === null) return delta;
  const inFocus = (beds: number) => focusBeds.includes(beds);
  return {
    ...delta,
    newUnits: delta.newUnits.filter((u) => inFocus(u.beds)),
    removedUnits: delta.removedUnits.filter((u) => inFocus(u.beds)),
    priceChanges: delta.priceChanges.filter((c) => inFocus(c.beds)),
  };
}

export function computeFocusDelta(
  prevUnits: UnitListing[] | null,
  currUnits: UnitListing[],
  from: string | null,
  to: string,
  focusBeds: number[] | null,
): FocusDelta {
  const raw = computeDelta(prevUnits, currUnits, from, to);
  const filtered = filterFocusDelta(raw, focusBeds);
  return {
    ...filtered,
    chicagoFrom: from ? chicagoDate(from) : null,
    chicagoTo: chicagoDate(to),
    focusBeds: focusBeds ?? [],
  };
}
