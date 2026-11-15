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
 * A month/day with no year. Sites print such dates for the near future, or —
 * for a few days — for a day that has just passed. So: a date within the
 * last week (this year or, around New Year, last year) is that recent day;
 * otherwise it is the next time that month/day comes round.
 */
function inferYear(monthIndex: number, day: number, refDay: string): string | null {
  const refYear = Number.parseInt(refDay.slice(0, 4), 10);
  const refMs = Date.parse(`${refDay}T00:00:00Z`);
  const candidates = [refYear - 1, refYear, refYear + 1]
    .map((y) => isoDay(y, monthIndex, day))
    .filter((d): d is string => d !== null);
  const behind = (d: string): number => (refMs - Date.parse(`${d}T00:00:00Z`)) / 86400e3;
  const justPassed = candidates.filter((d) => behind(d) >= 0 && behind(d) <= YEAR_INFERENCE_GRACE_DAYS);
  if (justPassed.length > 0) return justPassed[justPassed.length - 1]!;
  return candidates.find((d) => behind(d) < 0) ?? null;
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

  // US numeric with a year: M/D/YYYY, M/D/YY, M-D-YYYY, M.D.YYYY.
  const full = /\b(\d{1,2})([/\-.])(\d{1,2})\2(\d{4}|\d{2})\b/.exec(t);
  if (full) {
    const y = Number.parseInt(full[4]!, 10);
    return isoDay(
      full[4]!.length === 2 ? 2000 + y : y,
      Number.parseInt(full[1]!, 10) - 1,
      Number.parseInt(full[3]!, 10),
    );
  }
  // M/D with the year inferred — slashes only, and never a quantity
  // ("1-2 weeks", "1/2 month free", "2/2 bath").
  const short = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])(?!\s*(?:weeks?|days?|months?|mos?\b|beds?|baths?|br\b|ba\b|off\b))/.exec(t);
  if (short) {
    return inferYear(Number.parseInt(short[1]!, 10) - 1, Number.parseInt(short[2]!, 10), refDay);
  }

  // "Aug 15", "Dec. 26th", "December 26, 2026" — whole month names only (not
  // "Junior 1 Bedroom"), and a day that is not the start of a year
  // ("December 2026" names no day: no date, rather than an invented one).
  const m = MONTH_DAY.exec(t);
  if (!m) return /\bnow\b|\bimmediate/.test(t) ? refDay : null;
  const month = MONTHS[m[1]!.slice(0, 3)];
  const day = Number.parseInt(m[2]!, 10);
  if (month === undefined) return null;
  if (m[3]) return isoDay(Number.parseInt(m[3], 10), month, day);
  return inferYear(month, day, refDay);
}

const MONTH_DAY =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/;

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
