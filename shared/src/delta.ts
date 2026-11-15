import { comparePrices, isAvailableNow } from "./listing";
import { CHICAGO_TZ, chicagoDate } from "./time";
import type { FocusDelta, SnapshotDelta, UnitListing } from "./types";

export { CHICAGO_TZ, chicagoDate };

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
 *
 * Prices are compared like for like (see comparePrices): when the site only
 * switched which lease length it headlines, or flipped between a rent range
 * and a single price, the entry carries `notComparable` instead of
 * masquerading as a price move.
 *
 * `prevExtraKeys` lists identities that existed in the previous run but were
 * not in its unit list (historically: units the lease cap omitted). They are
 * not "new" when they show up now.
 */
export function computeDelta(
  prevUnits: UnitListing[] | null,
  currUnits: UnitListing[],
  from: string | null,
  to: string,
  prevExtraKeys?: Iterable<string>,
): SnapshotDelta {
  const delta: SnapshotDelta = {
    from,
    to,
    newUnits: [],
    removedUnits: [],
    priceChanges: [],
    dateChanges: [],
  };
  if (prevUnits === null) return delta; // first snapshot: nothing is "new"

  const prevByKey = new Map<string, UnitListing>();
  for (const u of prevUnits) prevByKey.set(listingKey(u), u);
  const knownBefore = new Set<string>(prevExtraKeys ?? []);

  const seen = new Set<string>();
  for (const u of currUnits) {
    const key = listingKey(u);
    seen.add(key);
    const prev = prevByKey.get(key);
    if (!prev) {
      if (!knownBefore.has(key)) delta.newUnits.push(u);
      continue;
    }
    const cmp = comparePrices(prev, u);
    // An unchanged like-for-like price is not a change at all, whatever the
    // headline did; a non-comparable pair is kept, flagged with the reason.
    if (cmp.from !== cmp.to) {
      delta.priceChanges.push({
        unitNumber: u.unitNumber ?? u.floorplanName,
        floorplanName: u.floorplanName,
        from: cmp.from,
        to: cmp.to,
        beds: u.beds,
        ...(cmp.fromTerm !== undefined ? { fromTerm: cmp.fromTerm } : {}),
        ...(cmp.toTerm !== undefined ? { toTerm: cmp.toTerm } : {}),
        ...(cmp.notComparable ? { notComparable: cmp.notComparable } : {}),
      });
    }
    const dateMoved = movedDate(prev, u, from, to);
    if (dateMoved) {
      delta.dateChanges!.push({
        unitNumber: u.unitNumber ?? u.floorplanName,
        floorplanName: u.floorplanName,
        beds: u.beds,
        from: dateMoved.from,
        to: dateMoved.to,
      });
    }
  }
  for (const [key, u] of prevByKey) {
    if (!seen.has(key)) delta.removedUnits.push(u);
  }
  return delta;
}

/**
 * Did the unit's earliest move-in day really move? "Available now" units are
 * stamped with each run's own day, so now → now is never a change; only a
 * future date that shifted (or a future date that turned into "now", or the
 * reverse) counts.
 */
function movedDate(
  prev: UnitListing,
  curr: UnitListing,
  from: string | null,
  to: string,
): { from: string | null; to: string | null } | null {
  if (!from) return null;
  let prevNow: boolean | null;
  let currNow: boolean | null;
  try {
    prevNow = isAvailableNow(prev, from);
    currNow = isAvailableNow(curr, to);
  } catch {
    return null; // unparseable run timestamps — cannot judge "now"
  }
  if (prevNow === null || currNow === null) return null; // a side has no date info
  if (prevNow && currNow) return null;
  if (!prevNow && !currNow && prev.availableDate === curr.availableDate) return null;
  return {
    from: prevNow ? null : prev.availableDate,
    to: currNow ? null : curr.availableDate,
  };
}

/** Price moves that are real (like-for-like), i.e. safe to alert on. */
export function realPriceChanges(delta: SnapshotDelta): SnapshotDelta["priceChanges"] {
  return delta.priceChanges.filter((c) => !c.notComparable);
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
    ...(delta.dateChanges
      ? { dateChanges: delta.dateChanges.filter((c) => inFocus(c.beds)) }
      : {}),
  };
}

export function computeFocusDelta(
  prevUnits: UnitListing[] | null,
  currUnits: UnitListing[],
  from: string | null,
  to: string,
  focusBeds: number[] | null,
  prevExtraKeys?: Iterable<string>,
): FocusDelta {
  const raw = computeDelta(prevUnits, currUnits, from, to, prevExtraKeys);
  const filtered = filterFocusDelta(raw, focusBeds);
  return {
    ...filtered,
    chicagoFrom: from ? chicagoDate(from) : null,
    chicagoTo: chicagoDate(to),
    focusBeds: focusBeds ?? [],
  };
}
