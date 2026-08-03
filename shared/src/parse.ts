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

/**
 * Normalize scraped availability text to an ISO date.
 * "now" / bare "available" → the reference date; "Aug 15" / "Aug. 15, 2026" →
 * ISO, inferring next year when the month/day has already passed.
 */
export function parseAvailableDate(text: string | null, ref: Date): string | null {
  if (!text) return null;
  const t = text.trim().toLowerCase().replace(/^available\s*/i, "");
  const isoRef = ref.toISOString().slice(0, 10);
  if (t === "" || t === "now" || t === "today" || t === "immediately") return isoRef;

  // Already ISO?
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return iso[0]!;

  const m = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/.exec(t);
  if (!m) return null;
  const month = MONTHS[m[1]!.slice(0, 3)];
  const day = Number.parseInt(m[2]!, 10);
  if (month === undefined || day < 1 || day > 31) return null;

  let year = m[3] ? Number.parseInt(m[3], 10) : ref.getUTCFullYear();
  if (!m[3]) {
    const candidate = Date.UTC(year, month, day);
    if (candidate < ref.getTime() - YEAR_INFERENCE_GRACE_DAYS * 86400e3) year += 1;
  }
  const d = new Date(Date.UTC(year, month, day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
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
