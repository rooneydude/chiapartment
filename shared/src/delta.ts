import { comparePrices, isAvailableNow } from "./listing";
import { CHICAGO_TZ, chicagoDate } from "./time";
import type { AlsoListed, FocusDelta, OmittedListing, SnapshotDelta, UnitListing } from "./types";

export { CHICAGO_TZ, chicagoDate };

/** Stable identity across runs: unit number, else floorplan + beds. */
export function listingKey(
  u: Pick<UnitListing, "unitNumber" | "floorplanName" | "beds">,
): string {
  if (u.unitNumber) return `u:${u.unitNumber}`;
  return `fp:${u.beds}:${u.floorplanName}`;
}

/**
 * Identities of rows a site lists without a price or bed count, in the same
 * key space as `listingKey` (rows whose bed count is unknown and that have no
 * unit number cannot be keyed and are skipped).
 */
export function alsoListedKeys(rows: readonly AlsoListed[] | undefined): string[] {
  const keys: string[] = [];
  for (const r of rows ?? []) {
    if (r.unitNumber) keys.push(`u:${r.unitNumber}`);
    else if (r.beds !== null) keys.push(`fp:${r.beds}:${r.floorplanName}`);
  }
  return keys;
}

/** What a diff may know about the runs beyond their two unit lists. */
export interface DeltaContext {
  /**
   * Identities that were on the site in the previous run without being in
   * its unit list: units the old lease cap omitted, rows listed without a
   * price. They are not "new" when they appear in the list now.
   */
  prevAlsoKnown?: Iterable<string>;
  /**
   * Identities still on the site in this run without being in its unit list
   * (still listed, price withdrawn). They are not "removed".
   */
  currStillListed?: Iterable<string>;
  /**
   * Identities listed in ANY earlier run. A unit that is new against the
   * previous run but known from before is a re-listing: it stays in
   * `newUnits` and its key is also reported in `relistedKeys`.
   */
  seenBefore?: Iterable<string>;
}

/** One successful scrape of a building, as far as a diff is concerned. */
export interface DeltaRun {
  timestamp: string;
  units: UnitListing[];
  /** Historical: units the old lease cap left out of `units`. */
  omitted?: OmittedListing[];
  alsoListed?: AlsoListed[];
}

/**
 * Everything a diff between `prev` and `curr` should know from the building's
 * run history (`runs` = its successful scrapes, any order).
 */
export function deltaContextFor(
  runs: readonly DeltaRun[],
  prev: DeltaRun | null,
  curr: DeltaRun,
): DeltaContext {
  if (!prev) return {};
  const seenBefore = new Set<string>();
  for (const r of runs) {
    if (r.timestamp >= prev.timestamp) continue;
    for (const u of r.units) seenBefore.add(listingKey(u));
    for (const o of r.omitted ?? []) seenBefore.add(listingKey(o));
    for (const k of alsoListedKeys(r.alsoListed)) seenBefore.add(k);
  }
  return {
    prevAlsoKnown: [...(prev.omitted ?? []).map(listingKey), ...alsoListedKeys(prev.alsoListed)],
    currStillListed: alsoListedKeys(curr.alsoListed),
    seenBefore,
  };
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
 * `ctx` carries what the two unit lists alone cannot say — see DeltaContext:
 * rows that were / still are on the site outside the unit list (never "new",
 * never "removed"), and which identities have been listed before (a
 * re-listing is not a first appearance).
 */
export function computeDelta(
  prevUnits: UnitListing[] | null,
  currUnits: UnitListing[],
  from: string | null,
  to: string,
  ctx: DeltaContext = {},
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
  const knownBefore = new Set<string>(ctx.prevAlsoKnown ?? []);
  const stillListed = new Set<string>(ctx.currStillListed ?? []);
  const seenBefore = new Set<string>(ctx.seenBefore ?? []);
  const relisted: string[] = [];

  const seen = new Set<string>();
  for (const u of currUnits) {
    const key = listingKey(u);
    seen.add(key);
    const prev = prevByKey.get(key);
    if (!prev) {
      if (!knownBefore.has(key)) {
        delta.newUnits.push(u);
        if (seenBefore.has(key)) relisted.push(key);
      }
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
        ...(u.sourceUpdatedAt ? { sourceUpdatedAt: u.sourceUpdatedAt } : {}),
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
    if (!seen.has(key) && !stillListed.has(key)) delta.removedUnits.push(u);
  }
  if (relisted.length > 0) delta.relistedKeys = relisted;
  return delta;
}

/** Is this unit of `delta.newUnits` a re-listing rather than a first appearance? */
export function isRelisted(delta: Pick<SnapshotDelta, "relistedKeys">, u: UnitListing): boolean {
  return delta.relistedKeys?.includes(listingKey(u)) ?? false;
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
    ...(delta.relistedKeys
      ? {
          relistedKeys: delta.newUnits
            .filter((u) => inFocus(u.beds))
            .map(listingKey)
            .filter((k) => delta.relistedKeys!.includes(k)),
        }
      : {}),
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
  ctx: DeltaContext = {},
): FocusDelta {
  const raw = computeDelta(prevUnits, currUnits, from, to, ctx);
  const filtered = filterFocusDelta(raw, focusBeds);
  return {
    ...filtered,
    chicagoFrom: from ? chicagoDate(from) : null,
    chicagoTo: chicagoDate(to),
    focusBeds: focusBeds ?? [],
  };
}
