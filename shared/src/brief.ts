import {
  chicagoDate,
  computeFocusDelta,
  listingKey,
  listingLabel,
  priorChicagoDayRun,
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
    price: u.price,
    ...(u.priceMax !== undefined ? { priceMax: u.priceMax } : {}),
    availableDate: u.availableDate,
    ...(now !== null ? { availableNow: now } : {}),
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
    new: fd.newUnits.map((u) => toBriefListing(u, fd.to)),
    removed: fd.removedUnits.map((u) => toBriefListing(u, fd.from ?? fd.to)),
    drops,
    omitted: omitted.filter((o) => inFocus(o.beds)),
    warnings,
    listings,
    listingsAsOf: history.latest.timestamp,
    dateChanges: fd.dateChanges ?? [],
    alsoListed,
    notices,
  };
}

export function assembleWeekdayBrief(
  buildings: BriefBuildingInput[],
  focusBeds: number[] | null,
  generated: string,
): WeekdayBrief {
  const rows = buildings.map((b) => briefBuilding(b, focusBeds));
  const chicagoDates = rows
    .map((r) => r.chicagoTo)
    .filter((d): d is string => d !== null)
    .sort();
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

export function focusDeltaFromRuns(
  okRuns: { timestamp: string; units: UnitListing[]; omitted?: OmittedListing[] }[],
  focusBeds: number[] | null,
) {
  const latest = okRuns[okRuns.length - 1];
  if (!latest) return null;
  const prev = priorChicagoDayRun(okRuns, latest);
  return computeFocusDelta(
    prev ? prev.units : null,
    latest.units,
    prev ? prev.timestamp : null,
    latest.timestamp,
    focusBeds,
    // Units the old lease cap hid on the comparison day were on the market
    // then too — do not report them as new.
    (prev?.omitted ?? []).map(listingKey),
  );
}
