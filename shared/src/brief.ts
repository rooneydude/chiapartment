import {
  chicagoDate,
  computeFocusDelta,
  deltaContextFor,
  isRelisted,
  listingKey,
  listingLabel,
  pricedAgainInfo,
  priorChicagoDayRun,
  type DeltaRun,
} from "./delta";
import { isAvailableNow } from "./listing";
import type {
  AlsoListed,
  BriefDrop,
  BriefListing,
  BriefOmitted,
  BuildingHistory,
  DataWarning,
  OmittedListing,
  UnitListing,
  WeekdayBrief,
  WeekdayBriefBuilding,
} from "./types";

function toBriefListing(u: UnitListing, asOf: string): BriefListing {
  const now = isAvailableNow(u, asOf);
  return {
    label: listingLabel(u),
    unitNumber: u.unitNumber,
    floorplanName: u.floorplanName,
    beds: u.beds,
    ...(u.planType ? { planType: u.planType } : {}),
    price: u.price,
    ...(u.priceMax !== undefined ? { priceMax: u.priceMax } : {}),
    ...(u.monthlyFees ? { monthlyFees: u.monthlyFees } : {}),
    availableDate: u.availableDate,
    ...(now !== null ? { availableNow: now } : {}),
    ...(u.vacantSince ? { vacantSince: u.vacantSince } : {}),
    ...(u.leaseTermMonths != null ? { leaseTermMonths: u.leaseTermMonths } : {}),
    ...(u.leaseTerms && u.leaseTerms.length > 0 ? { leaseTerms: u.leaseTerms } : {}),
    ...(u.sqft != null ? { sqft: u.sqft } : {}),
    ...(u.url ? { url: u.url } : {}),
  };
}

function toBriefOmitted(o: OmittedListing): BriefOmitted {
  return {
    label: listingLabel(o),
    unitNumber: o.unitNumber,
    floorplanName: o.floorplanName,
    beds: o.beds,
    advertisedPrice: o.advertisedPrice,
    leaseTermMonths: o.leaseTermMonths,
    reason: "over-cap",
  };
}

export interface BriefBuildingInput {
  id: string;
  name: string;
  history: BuildingHistory;
}

/**
 * One building's weekday-brief row. On a failed latest scrape we report the
 * error and do not replay last-good inventory as "everything gone."
 */
export function briefBuilding(
  input: BriefBuildingInput,
  focusBeds: number[] | null,
): WeekdayBriefBuilding {
  const { id, name, history } = input;
  const inFocus = (beds: number) => focusBeds === null || focusBeds.includes(beds);
  const omitted = (history.omitted ?? []).map(toBriefOmitted);
  const warnings: DataWarning[] = history.warnings ?? [];
  // Unpriced / unclassified rows: keep those in focus, plus those whose bed
  // count the site does not publish (they might be in focus).
  const alsoListed: AlsoListed[] = (history.alsoListed ?? []).filter(
    (a) => a.beds === null || inFocus(a.beds),
  );
  const notices = history.notices ?? [];
  const listings = history.latest
    ? history.latest.units
        .filter((u) => inFocus(u.beds))
        .map((u) => toBriefListing(u, history.latest!.timestamp))
    : [];

  if (history.lastAttempt?.status === "error") {
    return {
      id,
      name,
      status: "error",
      error: history.lastAttempt.error ?? "unknown error",
      ...(history.lastAttempt.blocked ? { blocked: true } : {}),
      from: null,
      to: history.lastAttempt.timestamp,
      chicagoFrom: null,
      chicagoTo: chicagoDate(history.lastAttempt.timestamp),
      focusAvailable: listings.length,
      new: [],
      removed: [],
      drops: [],
      omitted,
      warnings,
      // Last-good inventory, clearly dated by `listingsAsOf`.
      listings,
      listingsAsOf: history.latest?.timestamp ?? null,
      dateChanges: [],
      alsoListed,
      notices,
    };
  }

  const fd = history.focusDelta;
  const concession = warnings.some((w) => w.code === "uniform-reprice");
  if (!history.latest || !fd) {
    return {
      id,
      name,
      status: history.latest ? "ok" : "missing",
      from: null,
      to: history.latest?.timestamp ?? null,
      chicagoFrom: null,
      chicagoTo: history.latest ? chicagoDate(history.latest.timestamp) : null,
      focusAvailable: listings.length,
      new: [],
      removed: [],
      drops: [],
      omitted,
      warnings,
      listings,
      listingsAsOf: history.latest?.timestamp ?? null,
      dateChanges: [],
      alsoListed,
      notices,
    };
  }

  const drops: BriefDrop[] = fd.priceChanges
    // A switch in which lease length the site headlines is not a price drop.
    .filter((c) => c.to < c.from && inFocus(c.beds) && !c.notComparable)
    .map((c) => {
      const isFloorplan = c.unitNumber === c.floorplanName;
      return {
        label: isFloorplan ? c.floorplanName : `#${c.unitNumber}`,
        unitNumber: isFloorplan ? null : c.unitNumber,
        floorplanName: c.floorplanName,
        beds: c.beds,
        from: c.from,
        to: c.to,
        ...(c.fromTerm !== undefined && c.fromTerm === c.toTerm
          ? { leaseTermMonths: c.fromTerm }
          : {}),
        ...(c.since ? { since: c.since } : {}),
        // Every unit moved by the same ratio at once: a concession netted
        // into the advertised rents, not a cut in base rent.
        ...(concession ? { concessionLikely: true } : {}),
      };
    });

  return {
    id,
    name,
    status: "ok",
    from: fd.from,
    to: fd.to,
    chicagoFrom: fd.chicagoFrom,
    chicagoTo: fd.chicagoTo,
    focusAvailable: listings.length,
    new: fd.newUnits.map((u) => {
      const row = toBriefListing(u, fd.to);
      const firstSeen = history.perUnitMeta[u.unitNumber ?? listingKey(u)]?.firstSeen;
      const again = pricedAgainInfo(fd, u);
      // What kind of "new" this is — a first appearance needs no annotation.
      if (again) {
        return {
          ...row,
          pricedAgain: true,
          ...(again.lastPrice !== undefined ? { lastPrice: again.lastPrice } : {}),
          ...(again.lastPricedAt ? { lastPricedAt: again.lastPricedAt } : {}),
          ...(firstSeen ? { firstSeen } : {}),
        };
      }
      if (fd.reclassifiedKeys?.includes(listingKey(u))) {
        return { ...row, reclassified: true, ...(firstSeen ? { firstSeen } : {}) };
      }
      if (isRelisted(fd, u)) return { ...row, relisted: true, ...(firstSeen ? { firstSeen } : {}) };
      return row;
    }),
    removed: fd.removedUnits.map((u) => toBriefListing(u, fd.from ?? fd.to)),
    drops,
    omitted: omitted.filter((o) => inFocus(o.beds)),
    warnings,
    listings,
    listingsAsOf: history.latest.timestamp,
    dateChanges: fd.dateChanges ?? [],
    alsoListed,
    notices,
    ...(fd.newAlsoListed && fd.newAlsoListed.length > 0 ? { newUnpriced: fd.newAlsoListed } : {}),
  };
}

/**
 * A building the newest run did not scrape (a single-building refresh) has
 * nothing new to report today: keep what it lists, clearly dated, but do not
 * replay yesterday's new / removed / drops as if they were today's.
 */
function withoutEvents(row: WeekdayBriefBuilding): WeekdayBriefBuilding {
  const { newUnpriced: _dropped, ...rest } = row;
  return { ...rest, stale: true, new: [], removed: [], drops: [], dateChanges: [] };
}

export function assembleWeekdayBrief(
  buildings: BriefBuildingInput[],
  focusBeds: number[] | null,
  generated: string,
): WeekdayBrief {
  const built = buildings.map((b) => briefBuilding(b, focusBeds));
  const chicagoDates = built
    .map((r) => r.chicagoTo)
    .filter((d): d is string => d !== null)
    .sort();
  const newestDay = chicagoDates[chicagoDates.length - 1] ?? null;
  const rows = built.map((r) =>
    r.status === "ok" && r.chicagoTo !== null && newestDay !== null && r.chicagoTo < newestDay
      ? withoutEvents(r)
      : r,
  );
  const chicagoFromDates = rows
    .map((r) => r.chicagoFrom)
    .filter((d): d is string => d !== null)
    .sort();
  return {
    schemaVersion: 1,
    timezone: "America/Chicago",
    generated,
    focusBeds: focusBeds ?? [],
    chicagoFrom: chicagoFromDates[0] ?? null,
    chicagoTo: chicagoDates[chicagoDates.length - 1] ?? null,
    summary: {
      drops: rows.reduce((s, r) => s + r.drops.length, 0),
      newListings: rows.reduce((s, r) => s + r.new.length, 0),
      removed: rows.reduce((s, r) => s + r.removed.length, 0),
      scrapeErrors: rows.filter((r) => r.status === "error").length,
      omittedOverCap: rows.reduce((s, r) => s + r.omitted.length, 0),
      focusAvailable: rows.reduce((s, r) => s + r.focusAvailable, 0),
      availableNow: rows.reduce(
        (s, r) => s + (r.listings ?? []).filter((l) => l.availableNow === true).length,
        0,
      ),
      moveInDateChanges: rows.reduce((s, r) => s + (r.dateChanges?.length ?? 0), 0),
    },
    buildings: rows,
  };
}

export function focusDeltaFromRuns(okRuns: DeltaRun[], focusBeds: number[] | null) {
  const latest = okRuns[okRuns.length - 1];
  if (!latest) return null;
  const prev = priorChicagoDayRun(okRuns, latest);
  return computeFocusDelta(
    prev ? prev.units : null,
    latest.units,
    prev ? prev.timestamp : null,
    latest.timestamp,
    focusBeds,
    // What the two unit lists cannot say: rows that were / are on the site
    // without a price (not new, not removed), units the old lease cap hid on
    // the comparison day, and which units have been listed before.
    deltaContextFor(okRuns, prev, latest),
  );
}
