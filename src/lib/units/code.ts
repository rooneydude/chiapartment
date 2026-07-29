/**
 * Unit-number parsing.
 *
 * Chicago apartment towers almost universally number units `<floor><line>`:
 * 3208 is line 08 on floor 32, 0512 is line 12 on floor 5. Once you know a
 * building's line vocabulary the split is unambiguous, and that single fact is
 * what lets an arbitrary scraped listing land in the right place in the 3D
 * model with no per-listing data entry.
 */

export interface ParsedUnit {
  /**
   * Floor as printed on the elevator button, or null when the label carries a
   * line but no floor — "PH02" names the line without saying which storey the
   * penthouse level is.
   */
  floor: number | null;
  /** Line/stack identifier, leading zeros preserved. */
  line: string;
  /** Tower or wing designator (N/S/E/W or a letter), when present. */
  wing?: string;
  /** True when the building labels the unit a penthouse. */
  penthouse: boolean;
  /** Original text, untouched. */
  raw: string;
  confidence: "exact" | "inferred" | "guess";
}

const NOISE = /^(?:apt\.?|apartment|unit|suite|ste\.?|no\.?|#)\s*/i;

/**
 * @param raw           The unit label from the listing, e.g. "Unit 3208" or "PH02".
 * @param knownLines    Line identifiers the building is known to have. When
 *                      supplied the split is checked against them, which makes
 *                      one- and three-digit lines just work.
 * @param opts.topFloor Highest floor in the building; rejects impossible splits.
 */
export function parseUnitCode(
  raw: string,
  knownLines: string[] = [],
  opts: { topFloor?: number; baseFloor?: number } = {},
): ParsedUnit | null {
  const original = raw;
  let s = raw.trim().replace(NOISE, "").trim();
  if (!s) return null;

  // No `\b` after the prefix: there is no word boundary between "PH" and "02",
  // since a letter and a digit are both word characters.
  const penthouse =
    /^(ph|pent(house)?)(?=[\s\-#]|\d|$)/i.test(s) || /\bpenthouse\b/i.test(s);
  s = s.replace(/^(pent(house)?|ph)[\s-]*/i, "");

  // Leading or trailing wing letter: "N1204", "1204N", "S-1204", "A-1204".
  let wing: string | undefined;
  // A compass letter may sit flush against the number; any other letter needs
  // a separator, so "A12" isn't mistaken for wing A of unit 12.
  const leadWing =
    s.match(/^([NSEWnsew])[\s-]*(?=\d)/) ?? s.match(/^([A-Ha-h])[\s-]+(?=\d)/);
  if (leadWing) {
    wing = leadWing[1].toUpperCase();
    s = s.slice(leadWing[0].length);
  }
  const trailWing = s.match(/[\s-]*([NSEWnsew])$/);
  if (trailWing) {
    wing = trailWing[1].toUpperCase();
    s = s.slice(0, s.length - trailWing[0].length);
  }

  // "32-08" / "32.08" / "32 08" — the split is given to us.
  const explicit = s.match(/^(\d{1,3})\s*[-._/]\s*([A-Za-z]?\d{1,3}[A-Za-z]?)$/);
  if (explicit) {
    const floor = Number(explicit[1]);
    if (!floorInRange(floor, opts)) return null;
    return {
      floor,
      line: normalizeLine(explicit[2]),
      wing,
      penthouse,
      raw: original,
      confidence: "exact",
    };
  }

  const digits = s.match(/^(\d{2,5})([A-Za-z]?)$/);
  if (!digits) {
    // Non-numeric labels ("Garden A", "Loft 2") carry no floor information.
    return null;
  }
  const num = digits[1];
  const suffix = digits[2] ?? "";

  const lineSet = new Set(knownLines.map(normalizeLine));

  // "PH02" is a line on the penthouse level, whichever storey that is. Report
  // the line and leave the floor for the caller to resolve from the massing.
  if (penthouse && num.length <= 2) {
    return {
      floor: null,
      line: normalizeLine(num + suffix),
      wing,
      penthouse,
      raw: original,
      confidence: lineSet.has(normalizeLine(num + suffix)) ? "exact" : "inferred",
    };
  }

  // Try every split, preferring ones that match a known line.
  const candidates: Array<{ floor: number; line: string; score: number }> = [];
  for (let cut = 1; cut < num.length; cut++) {
    const floor = Number(num.slice(0, cut));
    const line = normalizeLine(num.slice(cut) + suffix);
    if (!floorInRange(floor, opts)) continue;
    let score = 0;
    if (lineSet.size > 0 && lineSet.has(line)) score += 100;
    // Two-digit lines are overwhelmingly the norm.
    if (line.replace(/[A-Za-z]/g, "").length === 2) score += 10;
    // Floors below 100 are the norm; the Loop's tallest residential is ~100.
    if (floor <= 99) score += 5;
    if (floor >= 1) score += 1;
    candidates.push({ floor, line, score });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score || a.floor - b.floor);
  const best = candidates[0];
  const matchedKnownLine = lineSet.size > 0 && lineSet.has(best.line);

  return {
    floor: best.floor,
    line: best.line,
    wing,
    penthouse,
    raw: original,
    confidence: matchedKnownLine ? "exact" : lineSet.size > 0 ? "guess" : "inferred",
  };
}

/** Lines are compared as uppercase strings so "08" and "8" never collide. */
export function normalizeLine(line: string): string {
  return line.trim().toUpperCase();
}

function floorInRange(
  floor: number,
  opts: { topFloor?: number; baseFloor?: number },
): boolean {
  if (!Number.isFinite(floor)) return false;
  const base = opts.baseFloor ?? 1;
  if (floor < base) return false;
  if (opts.topFloor != null && floor > opts.topFloor) return false;
  return floor <= 200;
}

/** Rebuild a canonical unit label from its parts. */
export function formatUnitCode(
  p: Pick<ParsedUnit, "floor" | "line" | "wing" | "penthouse">,
): string {
  const prefix = p.floor == null && p.penthouse ? "PH" : String(p.floor ?? "");
  return `${p.wing ?? ""}${prefix}${p.line}`;
}
