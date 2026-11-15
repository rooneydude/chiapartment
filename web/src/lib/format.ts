import { isAvailableNow } from "../../../shared/src/listing";
import { chicagoDate, daysBetween } from "../../../shared/src/time";
import type { UnitListing } from "../../../shared/src/types";

export const money = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A calendar day ("2026-12-18") has no time zone. `new Date("2026-12-18")` is
 * midnight UTC — the evening of the 17th in Chicago — so formatting it in
 * Chicago time shows every move-in date a day early. Calendar days are
 * therefore formatted as themselves, pinned to noon UTC.
 */
function calendarDay(isoDay: string): Date | null {
  const m = ISO_DAY.exec(isoDay);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

function format(iso: string, withYear: boolean): string {
  const day = calendarDay(iso);
  return (day ?? new Date(iso)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: day ? "UTC" : "America/Chicago",
  });
}

/** "Dec 18" — accepts a full timestamp (shown in Chicago time) or a calendar day. */
export const shortDate = (iso: string): string => format(iso, false);

/** "Dec 18, 2026" — accepts a full timestamp or a calendar day. */
export const longDate = (iso: string): string => format(iso, true);

/** "Dec 18", with the year only when it is not `asOf`'s year ("Jan 19, 2027"). */
export const dayLabel = (isoDay: string, asOf: string): string =>
  format(isoDay, isoDay.slice(0, 4) !== chicagoDate(asOf).slice(0, 4));

/** Date and time of a scrape in Chicago, e.g. "Nov 15, 7:55 AM". */
export const dateTime = (iso: string): string =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });

export const bedsLabel = (beds: number): string => (beds === 0 ? "Studio" : `${beds} BR`);

export const daysSince = (iso: string): number =>
  Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400e3));

export const hoursSince = (iso: string): number =>
  Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3600e3));

/** Compact age for scrape status, e.g. "3h ago" / "2d ago". */
export const ageLabel = (iso: string): string => {
  const hours = hoursSince(iso);
  if (hours < 1) return "just now";
  if (hours < 48) return `${hours}h ago`;
  return `${daysSince(iso)}d ago`;
};

/**
 * The daily refresh should land once a day; past this the dashboard is
 * showing yesterday's (or older) prices and must say so.
 */
export const STALE_AFTER_HOURS = 40;
export const isStale = (iso: string): boolean => hoursSince(iso) >= STALE_AFTER_HOURS;

/** "$2,457" or "$2,457–$2,478" when the site prints a range. */
export const priceLabel = (price: number, priceMax?: number): string =>
  priceMax !== undefined && priceMax > price ? `${money(price)}–${money(priceMax)}` : money(price);

export interface MoveIn {
  /** "Now", "Dec 18", "Jan 19, 2027" or "—". */
  label: string;
  /** now | future | unknown — drives styling and filtering. */
  kind: "now" | "future" | "unknown";
  /** Days from the snapshot day to the move-in day (0 for now); null if unknown. */
  days: number | null;
  /** Longer explanation for a tooltip. */
  title: string;
}

/** Everything the UI needs to say about when a unit can be moved into. */
export function moveIn(
  u: Pick<UnitListing, "availableDate" | "availableNow" | "vacantSince">,
  asOf: string,
): MoveIn {
  const now = isAvailableNow(u, asOf);
  const snapshotDay = chicagoDate(asOf);
  if (now === true) {
    // Newer snapshots say when the unit became vacant; older Leo snapshots
    // carried that day in availableDate.
    const sinceDay =
      u.vacantSince ?? (u.availableDate && u.availableDate < snapshotDay ? u.availableDate : null);
    const since =
      sinceDay && sinceDay < snapshotDay
        ? ` — vacant since ${longDate(sinceDay)} (${daysBetween(sinceDay, snapshotDay)} days)`
        : "";
    return { label: "Now", kind: "now", days: 0, title: `Available to move in now${since}` };
  }
  if (u.availableDate) {
    const days = daysBetween(snapshotDay, u.availableDate);
    return {
      label: dayLabel(u.availableDate, asOf),
      kind: "future",
      days,
      title: `Earliest move-in ${longDate(u.availableDate)} (${days} day${days === 1 ? "" : "s"} after this snapshot)`,
    };
  }
  return {
    label: "—",
    kind: "unknown",
    days: null,
    title: "The leasing site does not give a move-in date for this listing",
  };
}
