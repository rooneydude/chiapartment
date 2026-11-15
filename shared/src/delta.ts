import { comparePrices, isAvailableNow, type PriceComparison } from "./listing";
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
 * Identity of a row a site lists without a price or bed count, in the same
 * key space as `listingKey`. Null when the row has neither a unit number nor
 * a bed count — it cannot be followed from run to run.
 */
export function alsoListedKey(r: Pick<AlsoListed, "unitNumber" | "floorplanName" | "beds">): string | null {
  if (r.unitNumber) return `u:${r.unitNumber}`;
  return r.beds !== null ? `fp:${r.beds}:${r.floorplanName}` : null;
}

/** Keys of all the rows that can be keyed. */
export function alsoListedKeys(rows: readonly AlsoListed[] | undefined): string[] {
  const keys: string[] = [];
  for (const r of rows ?? []) {
    const key = alsoListedKey(r);
    if (key !== null) keys.push(key);
  }
  return keys;
}

/** What a diff may know about the two runs beyond their unit lists. */
export interface DeltaContext {
  /**
   * Historical: units the old lease cap left out of the previous run's list.
   * They were on the site, priced, all along — not "new" when listed now.
   */
  prevOmittedKeys?: Iterable<string>;
  /**
   * Rows the previous run listed without a price or bed count. `undefined`
   * means that run did not record such rows at all (snapshots before 15 Nov
   * 2026), so nothing can be concluded about them.
   */
  prevAlsoListed?: readonly AlsoListed[] | undefined;
  /** Rows this run lists without a price or bed count (same convention). */
  currAlsoListed?: readonly AlsoListed[] | undefined;
  /**
   * Historical replays: units the old cap left out of THIS run's list. They
   * are still on the site, so not "removed".
   */
  currOmittedKeys?: Iterable<string>;
  /**
   * Identities listed in ANY earlier run. A unit that is new against the
   * previous run but known from before is a re-listing: it stays in
   * `newUnits` and its key is also reported in `relistedKeys`.
   */
  seenBefore?: Iterable<string>;
  /** The price a listing last carried in an earlier run, and when. */
  lastPriced?: (key: string) => { price: number; at: string } | undefined;
  /**
   * The listing's most recent observation BEFORE the previous run that was
   * printed in the given form (a rent range, or a single price). Lets a unit
   * that flips between the two forms be compared with itself in the same
   * form instead of losing every price move that coincides with a flip.
   */
  sameFormBefore?: (key: string, range: boolean) => { unit: UnitListing; at: string } | undefined;
}

/** One successful scrape of a building, as far as a diff is concerned. */
export interface DeltaRun {
  timestamp: string;
  units: UnitListing[];
  /** Historical: units the old lease cap left out of `units`. */
  omitted?: OmittedListing[] | undefined;
  /** Absent on runs that did not record such rows. */
  alsoListed?: AlsoListed[] | undefined;
}

/** How many earlier runs a range ↔ single flip is followed back through. */
const FORM_LOOKBACK_RUNS = 10;

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
  // Newest first, strictly before the previous run.
  const earlier = runs
    .filter((r) => r.timestamp < prev.timestamp)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const seenBefore = new Set<string>();
  for (const r of earlier) {
    for (const u of r.units) seenBefore.add(listingKey(u));
    for (const o of r.omitted ?? []) seenBefore.add(listingKey(o));
    for (const k of alsoListedKeys(r.alsoListed)) seenBefore.add(k);
  }
  const find = (r: DeltaRun, key: string): UnitListing | undefined =>
    r.units.find((u) => listingKey(u) === key);
  return {
    prevOmittedKeys: (prev.omitted ?? []).map(listingKey),
    prevAlsoListed: prev.alsoListed,
    currAlsoListed: curr.alsoListed,
    currOmittedKeys: (curr.omitted ?? []).map(listingKey),
    seenBefore,
    lastPriced: (key) => {
      for (const r of earlier) {
        const u = find(r, key);
        if (u) return { price: u.price, at: r.timestamp };
      }
      return undefined;
    },
    sameFormBefore: (key, range) => {
      for (const r of earlier.slice(0, FORM_LOOKBACK_RUNS)) {
        const u = find(r, key);
        if (u && (u.priceMax !== undefined) === range) return { unit: u, at: r.timestamp };
      }
      return undefined;
    },
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

const isRange = (u: Pick<UnitListing, "priceMax">): boolean => u.priceMax !== undefined;

/**
 * Compare a unit with its previous observation, following a range ↔ single
 * flip back to the last time the price was printed in today's form.
 *
 * Old Town Park prints some units as a rent range on one visit and as one
 * price on the next. Comparing across the two forms is meaningless — but so
 * is dropping the comparison: a real cut that lands on a flip day would then
 * never be reported (it happened: three 2-bedrooms, 23 Aug 2026). So when
 * the form changed, today's price is compared with the last one seen in the
 * SAME form; equal means the flip was just the site, different means a real
 * move since then. A move the other form already showed (and reported) at
 * the previous run is not reported a second time.
 */
function compareWithHistory(
  key: string,
  prev: UnitListing,
  curr: UnitListing,
  ctx: DeltaContext,
): { cmp: PriceComparison; since?: string } {
  if (isRange(prev) === isRange(curr)) return { cmp: comparePrices(prev, curr) };
  const base = ctx.sameFormBefore?.(key, isRange(curr));
  if (!base) return { cmp: comparePrices(prev, curr) };
  const cmp = comparePrices(base.unit, curr);
  if (cmp.from !== cmp.to && !cmp.notComparable) {
    const prevBase = ctx.sameFormBefore?.(key, isRange(prev));
    if (prevBase) {
      const already = Math.sign(prev.price - prevBase.unit.price);
      if (already !== 0 && already === Math.sign(cmp.to - cmp.from)) {
        return { cmp: { ...cmp, to: cmp.from } }; // reported when the other form showed it
      }
    }
  }
  return { cmp, since: base.at };
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
 * `ctx` carries what the two unit lists alone cannot say — see DeltaContext.
 * With it:
 *   - a unit the old lease cap hid at the previous run is not "new";
 *   - a listing that was on the site without a price and has one now is
 *     reported (in `newUnits` and `pricedAgain`), with the price it last had;
 *   - a listing whose price was withdrawn is still on the site, not "removed";
 *   - a unit that left and came back is a re-listing (`relistedKeys`);
 *   - rows listed without a price that appear or disappear are reported in
 *     `newAlsoListed` / `removedAlsoListed`.
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

  // On the site at the previous run, outside its unit list.
  const pricedBefore = new Set<string>(ctx.prevOmittedKeys ?? []);
  const unpricedBefore = new Set<string>();
  for (const row of ctx.prevAlsoListed ?? []) {
    const key = alsoListedKey(row);
    if (key === null) continue;
    (row.price !== undefined ? pricedBefore : unpricedBefore).add(key);
  }
  // On the site in this run, outside its unit list.
  const stillListed = new Set<string>([
    ...alsoListedKeys(ctx.currAlsoListed),
    ...(ctx.currOmittedKeys ?? []),
  ]);
  const seenBefore = new Set<string>(ctx.seenBefore ?? []);
  const relisted: string[] = [];
  const pricedAgain: NonNullable<SnapshotDelta["pricedAgain"]> = [];

  const pushPriceChange = (u: UnitListing, cmp: PriceComparison, since?: string): void => {
    // An unchanged like-for-like price is not a change at all, whatever the
    // headline did; a non-comparable pair is kept, flagged with the reason.
    if (cmp.from === cmp.to) return;
    delta.priceChanges.push({
      unitNumber: u.unitNumber ?? u.floorplanName,
      floorplanName: u.floorplanName,
      from: cmp.from,
      to: cmp.to,
      beds: u.beds,
      ...(cmp.fromTerm !== undefined ? { fromTerm: cmp.fromTerm } : {}),
      ...(cmp.toTerm !== undefined ? { toTerm: cmp.toTerm } : {}),
      ...(cmp.notComparable ? { notComparable: cmp.notComparable } : {}),
      ...(since ? { since } : {}),
      ...(u.sourceUpdatedAt ? { sourceUpdatedAt: u.sourceUpdatedAt } : {}),
    });
  };

  const seen = new Set<string>();
  for (const u of currUnits) {
    const key = listingKey(u);
    seen.add(key);
    const prev = prevByKey.get(key);
    if (!prev) {
      if (pricedBefore.has(key)) continue; // listed and priced all along
      delta.newUnits.push(u);
      if (unpricedBefore.has(key)) {
        const last = ctx.lastPriced?.(key);
        pricedAgain.push({
          key,
          ...(last ? { lastPrice: last.price, lastPricedAt: last.at } : {}),
        });
      } else if (seenBefore.has(key)) {
        relisted.push(key);
      }
      continue;
    }
    const { cmp, since } = compareWithHistory(key, prev, u, ctx);
    pushPriceChange(u, cmp, since);
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

  // A floor-plan row's identity includes its bed count. When only that count
  // was reclassified, the plan is still the same listing — not one removed
  // and another new.
  for (const gone of [...delta.removedUnits]) {
    if (gone.unitNumber !== null) continue;
    const twin = delta.newUnits.find(
      (n) => n.unitNumber === null && n.floorplanName === gone.floorplanName,
    );
    if (!twin) continue;
    const twinKey = listingKey(twin);
    delta.removedUnits.splice(delta.removedUnits.indexOf(gone), 1);
    delta.newUnits.splice(delta.newUnits.indexOf(twin), 1);
    if (relisted.includes(twinKey)) relisted.splice(relisted.indexOf(twinKey), 1);
    const again = pricedAgain.findIndex((p) => p.key === twinKey);
    if (again >= 0) pricedAgain.splice(again, 1);
    pushPriceChange(twin, comparePrices(gone, twin));
  }

  if (relisted.length > 0) delta.relistedKeys = relisted;
  if (pricedAgain.length > 0) delta.pricedAgain = pricedAgain;

  // Rows without a price: only between two runs that both record them.
  if (ctx.prevAlsoListed !== undefined && ctx.currAlsoListed !== undefined) {
    const onSiteBefore = new Set<string>([...prevByKey.keys(), ...pricedBefore, ...unpricedBefore]);
    const added = ctx.currAlsoListed.filter((row) => {
      const key = alsoListedKey(row);
      return key !== null && !onSiteBefore.has(key);
    });
    const gone = ctx.prevAlsoListed.filter((row) => {
      const key = alsoListedKey(row);
      return key !== null && !seen.has(key) && !stillListed.has(key);
    });
    if (added.length > 0) delta.newAlsoListed = added;
    if (gone.length > 0) delta.removedAlsoListed = gone;
  }
  return delta;
}

/** Is this unit of `delta.newUnits` a re-listing rather than a first appearance? */
export function isRelisted(delta: Pick<SnapshotDelta, "relistedKeys">, u: UnitListing): boolean {
  return delta.relistedKeys?.includes(listingKey(u)) ?? false;
}

/**
 * Was this unit of `delta.newUnits` already on the site at the previous run,
 * only without a price? Returns what is known about its earlier price.
 */
export function pricedAgainInfo(
  delta: Pick<SnapshotDelta, "pricedAgain">,
  u: UnitListing,
): NonNullable<SnapshotDelta["pricedAgain"]>[number] | undefined {
  const key = listingKey(u);
  return delta.pricedAgain?.find((p) => p.key === key);
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
  // A row whose bed count the site does not publish might be in focus: keep it.
  const maybeInFocus = (beds: number | null) => beds === null || inFocus(beds);
  const newUnits = delta.newUnits.filter((u) => inFocus(u.beds));
  const kept = new Set(newUnits.map(listingKey));
  const out: SnapshotDelta = {
    ...delta,
    newUnits,
    removedUnits: delta.removedUnits.filter((u) => inFocus(u.beds)),
    priceChanges: delta.priceChanges.filter((c) => inFocus(c.beds)),
    ...(delta.dateChanges
      ? { dateChanges: delta.dateChanges.filter((c) => inFocus(c.beds)) }
      : {}),
  };
  delete out.relistedKeys;
  delete out.pricedAgain;
  delete out.newAlsoListed;
  delete out.removedAlsoListed;
  const relisted = (delta.relistedKeys ?? []).filter((k) => kept.has(k));
  const pricedAgain = (delta.pricedAgain ?? []).filter((p) => kept.has(p.key));
  const added = (delta.newAlsoListed ?? []).filter((r) => maybeInFocus(r.beds));
  const gone = (delta.removedAlsoListed ?? []).filter((r) => maybeInFocus(r.beds));
  if (relisted.length > 0) out.relistedKeys = relisted;
  if (pricedAgain.length > 0) out.pricedAgain = pricedAgain;
  if (added.length > 0) out.newAlsoListed = added;
  if (gone.length > 0) out.removedAlsoListed = gone;
  return out;
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

  // A unit listed in both runs whose bed count was reclassified into (or out
  // of) the sizes being shopped for has, for the shopper, just appeared (or
  // gone) — say so instead of letting it slip in unannounced.
  if (focusBeds !== null && prevUnits !== null) {
    const inFocus = (beds: number) => focusBeds.includes(beds);
    const prevByKey = new Map(prevUnits.map((u) => [listingKey(u), u]));
    const reclassified: string[] = [];
    for (const u of currUnits) {
      const key = listingKey(u);
      const was = prevByKey.get(key);
      if (!was || inFocus(was.beds) === inFocus(u.beds)) continue;
      reclassified.push(key);
      if (inFocus(u.beds)) filtered.newUnits = [...filtered.newUnits, u];
      else filtered.removedUnits = [...filtered.removedUnits, was];
    }
    if (reclassified.length > 0) filtered.reclassifiedKeys = reclassified;
  }

  return {
    ...filtered,
    chicagoFrom: from ? chicagoDate(from) : null,
    chicagoTo: chicagoDate(to),
    focusBeds: focusBeds ?? [],
  };
}
