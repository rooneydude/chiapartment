import { chicagoDate } from "./time";
import type { LeaseTermPrice, UnitListing } from "./types";

/**
 * Listing helpers shared by the scraper pipeline and the dashboard, so
 * "available now", lease-term lookups and like-for-like comparisons mean the
 * same thing everywhere.
 */

type Availability = Pick<UnitListing, "availableDate" | "availableNow">;

/**
 * Can this unit be moved into as of `asOf` (the snapshot's timestamp)?
 *   true  — the site said so, or its move-in day is on/before that Chicago day
 *   false — its move-in day is later
 *   null  — the site gives neither a flag nor a date
 */
export function isAvailableNow(u: Availability, asOf: string | Date): boolean | null {
  if (u.availableNow === true) return true;
  if (!u.availableDate) return u.availableNow === false ? false : null;
  return u.availableDate <= chicagoDate(asOf);
}

type Priced = Pick<UnitListing, "price" | "leaseTermMonths" | "leaseTerms">;

/** The unit's lease-term table, sorted, with the advertised term folded in. */
export function leaseTermTable(u: Priced): LeaseTermPrice[] {
  const byMonths = new Map<number, number>();
  for (const t of u.leaseTerms ?? []) {
    const prev = byMonths.get(t.months);
    if (prev === undefined || t.price < prev) byMonths.set(t.months, t.price);
  }
  if (u.leaseTermMonths != null && !byMonths.has(u.leaseTermMonths)) {
    byMonths.set(u.leaseTermMonths, u.price);
  }
  return [...byMonths.entries()]
    .map(([months, price]) => ({ months, price }))
    .sort((a, b) => a.months - b.months);
}

/**
 * Monthly rent for an N-month lease, or null when the site does not publish a
 * price for that length. Never interpolates.
 */
export function priceAtTerm(u: Priced, months: number): number | null {
  const hit = u.leaseTerms?.find((t) => t.months === months);
  if (hit) return hit.price;
  if (u.leaseTermMonths === months) return u.price;
  return null;
}

/** Cheapest row of the lease-term table (shortest term wins ties), or null. */
export function cheapestTerm(u: Priced): LeaseTermPrice | null {
  let best: LeaseTermPrice | null = null;
  for (const t of leaseTermTable(u)) {
    if (!best || t.price < best.price) best = t;
  }
  return best;
}

export interface PriceComparison {
  from: number;
  to: number;
  fromTerm?: number;
  toTerm?: number;
  /** The two prices are for different lease lengths and could not be aligned. */
  termChangeOnly: boolean;
}

/**
 * Compare a unit's price across two runs LIKE FOR LIKE. Sites re-headline a
 * different lease length from day to day (18 months one day, 13 the next);
 * comparing those headline prices raw reports price moves that never
 * happened. So:
 *   1. same advertised term (or no term info on either side) → headline vs headline;
 *   2. different terms → compare at a term both sides have a price for
 *      (the old headline term, else the new one, else any shared term);
 *   3. no shared term → report the headline prices flagged `termChangeOnly`.
 */
export function comparePrices(prev: Priced, curr: Priced): PriceComparison {
  const pTerm = prev.leaseTermMonths ?? null;
  const cTerm = curr.leaseTermMonths ?? null;
  const headline = (): PriceComparison => ({
    from: prev.price,
    to: curr.price,
    ...(pTerm != null ? { fromTerm: pTerm } : {}),
    ...(cTerm != null ? { toTerm: cTerm } : {}),
    termChangeOnly: false,
  });
  if (pTerm === cTerm) return headline();
  // One side has no term information at all: nothing to align on, and no
  // evidence the term changed — treat as a plain comparison.
  if (pTerm === null || cTerm === null) return headline();

  const candidates = [pTerm, cTerm];
  for (const t of prev.leaseTerms ?? []) candidates.push(t.months);
  for (const months of candidates) {
    const a = priceAtTerm(prev, months);
    const b = priceAtTerm(curr, months);
    if (a !== null && b !== null) {
      return { from: a, to: b, fromTerm: months, toTerm: months, termChangeOnly: false };
    }
  }
  return { ...headline(), termChangeOnly: true };
}
