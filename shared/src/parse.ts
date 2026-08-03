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
