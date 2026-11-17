/**
 * Calendar-day helpers. Every building is in Chicago, and leasing sites speak
 * in Chicago calendar days ("Available Now", "12/18/2026"), so "today" always
 * means the Chicago date — never the UTC date of the machine that scraped.
 */

export const CHICAGO_TZ = "America/Chicago";

const chicagoFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CHICAGO_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD in America/Chicago for an instant (ISO string or Date). */
export function chicagoDate(when: string | Date): string {
  return chicagoFormatter.format(typeof when === "string" ? new Date(when) : when);
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day written YYYY-MM-DD (rejects 2026-02-31). */
export function isIsoDay(value: string): boolean {
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Whole days from ISO day `from` to ISO day `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400e3);
}
