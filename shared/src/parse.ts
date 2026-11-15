import { chicagoDate } from "./time";
import type { UnitMapping } from "./types";

export interface ParsedUnit {
  floor: number | null;
  stack: string | null;
}

const NONE: ParsedUnit = { floor: null, stack: null };

/**
 * Derive floor + stack from a unit number string.
 * "2314" with stackDigits=2 → floor 23, stack "14".
 * Tolerant of prefixes/suffixes ("Unit 1204A" → 12 / "04").
 */
export function parseUnitNumber(
  unitNumber: string | null,
  mapping: UnitMapping,
): ParsedUnit {
  if (!unitNumber || mapping.scheme === "none") return NONE;

  if (mapping.scheme === "regex") {
    if (!mapping.regex) return NONE;
    const m = new RegExp(mapping.regex).exec(unitNumber);
    if (!m?.groups?.["floor"]) return NONE;
    const floor = Number.parseInt(m.groups["floor"], 10) + mapping.floorOffset;
    const stack = m.groups["stack"] ?? null;
    return { floor: Number.isFinite(floor) ? floor : null, stack };
  }

  // floor-prefix: first run of digits, trailing stackDigits are the stack.
  const m = /\d+/.exec(unitNumber);
  if (!m) return NONE;
  const digits = m[0];
  if (digits.length <= mapping.stackDigits) {
    // Too short to contain both floor and stack (e.g. "07" on a garden unit).
    return NONE;
  }
  const floor =
    Number.parseInt(digits.slice(0, digits.length - mapping.stackDigits), 10) +
    mapping.floorOffset;
  const stack = digits.slice(digits.length - mapping.stackDigits);
  return { floor, stack };
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Days of slack before assuming a year-less date meant next year. */
const YEAR_INFERENCE_GRACE_DAYS = 7;

/** ISO day for y/m/d, or null when it is not a real calendar date (Feb 31). */
function isoDay(year: number, monthIndex: number, day: number): string | null {
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, monthIndex, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIndex || d.getUTCDate() !== day) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * A month/day with no year: this year, unless that day is already more than
 * a week behind the reference day — then the site means next year.
 */
function inferYear(monthIndex: number, day: number, refDay: string): string | null {
  const refYear = Number.parseInt(refDay.slice(0, 4), 10);
  const thisYear = isoDay(refYear, monthIndex, day);
  if (thisYear !== null) {
    const behindDays =
      (Date.parse(`${refDay}T00:00:00Z`) - Date.parse(`${thisYear}T00:00:00Z`)) / 86400e3;
    if (behindDays <= YEAR_INFERENCE_GRACE_DAYS) return thisYear;
  }
  return isoDay(refYear + 1, monthIndex, day) ?? thisYear;
}

/** Words leasing sites use for "you can move in today". */
const NOW_WORDS = /^(now|today|immediately|immediate|available)?$/;

/**
 * Normalize scraped availability text to an ISO calendar day.
 *
 *   "Available Now" / bare "Available" / "today"  → the reference day
 *   "12/18/2026", "1/2/27", "12-18-2026"          → that day (US month/day order)
 *   "12/18"                                       → year inferred
 *   "Aug 15", "Dec 26th", "Aug. 15, 2026"         → ISO, year inferred when absent
 *   "2026-10-09"                                  → unchanged
 *
 * The reference day is the CHICAGO calendar date of `ref` (the buildings and
 * their leasing offices are in Chicago; a late-evening scrape is still
 * "today" there even though UTC has rolled over). Returns null when the text
 * carries no recognizable date — never a guess.
 */
export function parseAvailableDate(text: string | null | undefined, ref: Date): string | null {
  if (!text) return null;
  const t = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(available|availability|move[- ]?in|date available)\s*[:\-]?\s*/i, "")
    .replace(/^(on|from|starting|beginning)\s+/i, "")
    .trim();
  const refDay = chicagoDate(ref);
  if (NOW_WORDS.test(t)) return refDay;

  // Already ISO?
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) {
    return isoDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  // US numeric: M/D/YYYY, M/D/YY, M-D-YYYY, or M/D with the year inferred.
  const us = /\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{4}|\d{2}))?\b/.exec(t);
  if (us) {
    const month = Number.parseInt(us[1]!, 10) - 1;
    const day = Number.parseInt(us[2]!, 10);
    if (us[3]) {
      const y = Number.parseInt(us[3], 10);
      return isoDay(us[3].length === 2 ? 2000 + y : y, month, day);
    }
    return inferYear(month, day, refDay);
  }

  const m = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/.exec(t);
  if (!m) return /\bnow\b|\bimmediate/.test(t) ? refDay : null;
  const month = MONTHS[m[1]!.slice(0, 3)];
  const day = Number.parseInt(m[2]!, 10);
  if (month === undefined) return null;
  if (m[3]) return isoDay(Number.parseInt(m[3], 10), month, day);
  return inferYear(month, day, refDay);
}

/**
 * When floorplans are stacks (mapping.stackFromPlanRegex set), extract the
 * stack from a plan name, zero-padded to stackDigits ("Unit 1" → "01").
 */
export function stackFromPlan(floorplanName: string, mapping: UnitMapping): string | null {
  if (!mapping.stackFromPlanRegex) return null;
  const m = new RegExp(mapping.stackFromPlanRegex, "i").exec(floorplanName);
  if (!m?.[1]) return null;
  return m[1].padStart(mapping.stackDigits, "0");
}

/**
 * Lease-term label → months: "14 Months", "12-month", "Lease term: 13 mo".
 * Null when no believable term (1–36 months) is present.
 */
export function parseLeaseTermMonths(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = /(\d{1,2})\s*[- ]?\s*mo(?:nth)?s?\b/i.exec(label);
  if (!m) return null;
  const months = Number.parseInt(m[1]!, 10);
  return months >= 1 && months <= 36 ? months : null;
}
