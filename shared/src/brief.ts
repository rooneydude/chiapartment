import {
  chicagoDate,
  computeFocusDelta,
  listingLabel,
  priorChicagoDayRun,
} from "./delta";
import type {
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

function toBriefListing(u: UnitListing): BriefListing {
  return {
    label: listingLabel(u),
    unitNumber: u.unitNumber,
    floorplanName: u.floorplanName,
    beds: u.beds,
    price: u.price,
    availableDate: u.availableDate,
    ...(u.leaseTermMonths != null ? { leaseTermMonths: u.leaseTermMonths } : {}),
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
  const omitted = (history.omitted ?? []).map(toBriefOmitted);
  const warnings: DataWarning[] = history.warnings ?? [];

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
      focusAvailable: history.latest?.units.filter((u) =>
        focusBeds === null ? true : focusBeds.includes(u.beds),
      ).length ?? 0,
      new: [],
      removed: [],
      drops: [],
      omitted,
      warnings,
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
      focusAvailable: 0,
      new: [],
      removed: [],
      drops: [],
      omitted,
      warnings,
    };
  }

  const inFocus = (beds: number) => focusBeds === null || focusBeds.includes(beds);
  const drops: BriefDrop[] = fd.priceChanges
    .filter((c) => c.to < c.from && inFocus(c.beds))
    .map((c) => {
      const isFloorplan = c.unitNumber === c.floorplanName;
      return {
        label: isFloorplan ? c.floorplanName : `#${c.unitNumber}`,
        unitNumber: isFloorplan ? null : c.unitNumber,
        floorplanName: c.floorplanName,
        beds: c.beds,
        from: c.from,
        to: c.to,
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
    focusAvailable: history.latest.units.filter((u) => inFocus(u.beds)).length,
    new: fd.newUnits.map(toBriefListing),
    removed: fd.removedUnits.map(toBriefListing),
    drops,
    omitted: omitted.filter((o) => inFocus(o.beds)),
    warnings,
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
    },
    buildings: rows,
  };
}

export function focusDeltaFromRuns(
  okRuns: { timestamp: string; units: UnitListing[] }[],
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
  );
}
