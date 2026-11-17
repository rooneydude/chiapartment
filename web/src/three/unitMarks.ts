import { listingKey } from "../../../shared/src/delta";
import { isAvailableNow, priceAtTerm } from "../../../shared/src/listing";
import { stackFromPlan } from "../../../shared/src/parse";
import type { Vec2 } from "../../../shared/src/placement";
import type {
  AlsoListedCompiled,
  BuildingConfig,
  UnitListing,
} from "../../../shared/src/types";
import { layoutListings, type UnitMark } from "../../../shared/src/unitLayout";
import { bedsLabel, moveIn, priceLabel, type MoveIn } from "../lib/format";

/**
 * Every listed unit as a mark on the tower: what each listing looks like and
 * says. Pure data — no React, no three.js; markGeometry.ts turns the result
 * into vertex buffers and MarksLegend.tsx into the legend.
 *
 *   colour  = size (studio / 1 BR / 2 BR / 3+ BR)
 *   fill    = can be moved into now (solid) or not yet / no date (outline)
 *   grey    = listed, but not among the rows the table shows right now
 *   hatched = on the leasing site without a price (the "also listed" rows)
 * How sure the position is comes from the layout (shared/unitLayout.ts).
 */

/** Bed count bucketed at 3. */
export type SizeBucket = 0 | 1 | 2 | 3;

export const SIZE_LABELS: readonly [string, string, string, string] = [
  "Studio",
  "1 BR",
  "2 BR",
  "3+ BR",
];

/**
 * The marks' colours, defined once: the scene and the legend chips both read
 * them from here. One set for both page themes, because the tower is lit by
 * the time of day, not by the theme.
 *
 * `size` is four hues on a lightness ladder (OKLCH L 0.76 / 0.69 / 0.59 /
 * 0.53), checked for every pair with the dataviz palette validator: worst
 * pair under protan / deutan simulation dE 10.5 (target >= 8), worst pair in
 * normal vision dE 23.8 (floor 15). Blue, orange, green and red are left out
 * on purpose: they already mean the selection band, the selected-unit beacon,
 * "Now" and a price rise.
 */
export const MARK_COLORS = {
  size: ["#eda100", "#1daec2", "#d03785", "#6250d6"],
  /** A row whose bed count the site does not publish. */
  unknownSize: "#ece9df",
  /** Listed, but not in the current filter. */
  muted: "#6b7480",
  /** Dark edge that keeps a mark readable on sun-lit glass. */
  casing: "#0e131a",
  /** Hover / selection ring. */
  ring: "#ffffff",
} as const;

export function sizeBucket(beds: number | null): SizeBucket | null {
  if (beds === null) return null;
  return Math.min(Math.max(Math.floor(beds), 0), 3) as SizeBucket;
}

/**
 * solid   in the filter, can be moved into now
 * outline in the filter, a later date or none published
 * muted   not in the current filter
 * hatch   listed without a price ("also on the leasing site")
 */
export type MarkLook = "solid" | "outline" | "muted" | "hatch";

/** What a click on the mark selects — the same thing a click on its table row does. */
export type MarkSelection = { kind: "unit"; unit: string } | { kind: "plan"; plan: string };

interface MarkStateBase {
  mark: UnitMark;
  size: SizeBucket | null;
  moveIn: MoveIn;
  inFilter: boolean;
  look: MarkLook;
  /** sRGB hex the mark is drawn in. */
  color: string;
  /** null: the table has no selectable row for it — a click only shows its label. */
  select: MarkSelection | null;
}

export type MarkState = MarkStateBase &
  (
    | { source: "unit"; listing: UnitListing }
    /** A row of the "also on the leasing site" list (no price, or no bed count). */
    | { source: "also"; listing: AlsoListedCompiled }
  );

export interface MarkStatesInput {
  building: BuildingConfig;
  /** The tower's footprint in plan metres. */
  ring: Vec2[];
  /** Every unit of the latest snapshot. */
  listed: readonly UnitListing[];
  alsoListed: readonly AlsoListedCompiled[];
  /** The rows the table shows now; undefined = no filter, everything is shown. */
  shown: readonly UnitListing[] | undefined;
  /** Timestamp of the snapshot: "now" is judged against it. */
  asOf: string;
  exactFor?: (unitNumber: string) => Vec2 | undefined;
}

/** One state per listing, in layout order: `listed` first, then `alsoListed`. */
export function buildMarkStates(input: MarkStatesInput): MarkState[] {
  const { building, ring, listed, alsoListed, shown, asOf } = input;
  const marks = layoutListings({
    listings: [...listed, ...alsoListed],
    mapping: building.unitMapping,
    geometry: building.geometry,
    ring,
    ...(input.exactFor ? { exactFor: input.exactFor } : {}),
  });
  const shownKeys = shown ? new Set(shown.map(listingKey)) : null;
  const mapping = building.unitMapping;

  const colorOf = (look: MarkLook, size: SizeBucket | null): string =>
    look === "muted"
      ? MARK_COLORS.muted
      : size === null
        ? MARK_COLORS.unknownSize
        : MARK_COLORS.size[size];

  const out: MarkState[] = [];
  listed.forEach((u, i) => {
    const mark = marks[i]!;
    const size = sizeBucket(u.beds);
    const inFilter = shownKeys === null || shownKeys.has(listingKey(u));
    const look: MarkLook = !inFilter
      ? "muted"
      : isAvailableNow(u, asOf) === true
        ? "solid"
        : "outline";
    const select: MarkSelection | null = u.unitNumber
      ? { kind: "unit", unit: u.unitNumber }
      : mapping && stackFromPlan(u.floorplanName, mapping) !== null
        ? { kind: "plan", plan: u.floorplanName }
        : null;
    out.push({
      source: "unit",
      listing: u,
      mark,
      size,
      moveIn: moveIn(u, asOf),
      inFilter,
      look,
      color: colorOf(look, size),
      select,
    });
  });
  alsoListed.forEach((a, i) => {
    const mark = marks[listed.length + i]!;
    const size = sizeBucket(a.beds);
    out.push({
      source: "also",
      listing: a,
      mark,
      size,
      moveIn: moveIn(
        {
          availableDate: a.availableDate ?? null,
          ...(a.availableNow !== undefined ? { availableNow: a.availableNow } : {}),
        },
        asOf,
      ),
      // The table lists these rows whatever the filters say.
      inFilter: true,
      look: "hatch",
      color: colorOf("hatch", size),
      select: null,
    });
  });
  return out;
}

/** Is the mark drawn on the tower at all? */
export const isDrawn = (s: MarkState): boolean => s.mark.kind !== "unplaced";

/** Index of the state a unit number / a floor-plan stack belongs to, or -1. */
export function findMark(
  states: readonly MarkState[],
  what: { unit: string | null; plan?: string | null },
): number {
  if (what.unit) {
    const byUnit = states.findIndex((s) => isDrawn(s) && s.mark.unitNumber === what.unit);
    if (byUnit >= 0) return byUnit;
  }
  if (what.plan) {
    return states.findIndex(
      (s) =>
        isDrawn(s) &&
        s.source === "unit" &&
        s.mark.unitNumber === null &&
        s.listing.floorplanName === what.plan,
    );
  }
  return -1;
}

/**
 * The label shown at a mark, piece by piece: "#2906", "1 BR", "$3,831",
 * "Dec 3", "side estimated". `leaseTerm` is the table's lease-length
 * choice: the label quotes the same rent the table row does.
 *
 * Only a position taken from a unit map ("exact") goes without a qualifier.
 * Everywhere else the SIDE comes from the building's hand-made stack table,
 * which is mostly unverified — the floor is the only certain part — and the
 * label says so.
 */
export function markLabelParts(s: MarkState, leaseTerm: number | null): string[] {
  const parts: string[] = [];
  const { mark } = s;
  parts.push(mark.unitNumber ? `#${mark.unitNumber}` : s.listing.floorplanName);

  if (s.source === "unit") {
    const u = s.listing;
    parts.push(u.planType ?? bedsLabel(u.beds));
    const atTerm = leaseTerm !== null ? priceAtTerm(u, leaseTerm) : null;
    parts.push(
      atTerm !== null ? `${priceLabel(atTerm)} @${leaseTerm}mo` : priceLabel(u.price, u.priceMax),
    );
  } else {
    const a = s.listing;
    if (a.beds !== null) parts.push(bedsLabel(a.beds));
    else if (a.unitNumber) parts.push(a.floorplanName);
    parts.push(a.price !== undefined ? priceLabel(a.price, a.priceMax) : "no price published");
  }

  parts.push(s.moveIn.kind === "unknown" ? "no move-in date" : s.moveIn.label);

  if (mark.kind === "belt") parts.push(`floor ${mark.floor}, side unknown`);
  else if (mark.kind === "riser") parts.push("floor not published, side estimated");
  else if (mark.kind === "plate" && mark.confidence !== "exact") parts.push("side estimated");
  else if (mark.kind === "unplaced") parts.push("not placed on the tower");

  if (s.look === "muted") parts.push("not in the current filter");
  return parts;
}

/** "#2906 · 1 BR · $3,831 · Dec 3 · side estimated" */
export const markLabel = (s: MarkState, leaseTerm: number | null): string =>
  markLabelParts(s, leaseTerm).join(" · ");

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

export type LegendRowKind =
  | "now"
  | "later"
  | "approx"
  | "belt"
  | "riser"
  | "hatch"
  | "muted"
  | "ghost";

export interface LegendSize {
  bucket: SizeBucket;
  label: string;
  color: string;
  /** Listed units of this size. */
  count: number;
  /** ...of which the table shows now (the rest are drawn grey). */
  shown: number;
  /** Lowest advertised rent among them. */
  from: number;
}

export interface LegendRow {
  kind: LegendRowKind;
  /** What the glyph means, e.g. "move in now". */
  text: string;
  /** How many marks on the tower look like this; null where a count means nothing. */
  count: number | null;
  /** Longer explanation, for a tooltip. */
  title: string;
}

export interface LegendModel {
  /** Units in the latest snapshot (the table's "all N"). */
  listed: number;
  sizes: LegendSize[];
  /** Only the kinds of mark that occur on this tower right now. */
  rows: LegendRow[];
  /** Listings that cannot be placed, and why; null when every one is on the tower. */
  unplaced: { count: number; reasons: string[] } | null;
}

export function buildLegend(states: readonly MarkState[]): LegendModel {
  const sizes: LegendSize[] = [];
  for (const bucket of [0, 1, 2, 3] as const) {
    const ofSize = states.filter((s) => s.source === "unit" && s.size === bucket);
    if (ofSize.length === 0) continue;
    let from = Infinity;
    for (const s of ofSize) if (s.source === "unit") from = Math.min(from, s.listing.price);
    sizes.push({
      bucket,
      label: SIZE_LABELS[bucket],
      color: MARK_COLORS.size[bucket],
      count: ofSize.length,
      shown: ofSize.filter((s) => s.inFilter).length,
      from,
    });
  }

  const drawn = states.filter(isDrawn);
  const count = (test: (s: MarkState) => boolean): number => drawn.filter(test).length;
  const rows: LegendRow[] = [];
  const add = (kind: LegendRowKind, n: number | null, text: string, title: string): void => {
    if (n === null || n > 0) rows.push({ kind, text, count: n, title });
  };

  add(
    "now",
    count((s) => s.look === "solid"),
    "move in now",
    "Solid: the unit can be moved into now",
  );
  const outlines = drawn.filter((s) => s.look === "outline");
  const dated = outlines.filter((s) => s.moveIn.kind === "future").length;
  add(
    "later",
    outlines.length,
    dated === outlines.length ? "available later" : dated === 0 ? "no move-in date" : "later, or no date",
    "Outline: the unit has a later move-in date, or the leasing site publishes none",
  );
  add(
    "approx",
    count((s) => s.mark.kind === "plate" && s.mark.confidence !== "exact"),
    "side estimated",
    "Whiskers: the floor is certain, the side is an estimate — it comes from a hand-made table of this building's stacks that is mostly unverified",
  );
  add(
    "belt",
    count((s) => s.mark.kind === "belt"),
    "side unknown",
    "Dashed band around a floor: the unit is on this floor, but nothing says on which side",
  );
  add(
    "riser",
    count((s) => s.mark.kind === "riser"),
    "floor unknown",
    "Strip up a face: the leasing site lists this floor-plan stack, not a single apartment — it could be on any floor, and the side is an estimate too",
  );
  const hatched = drawn.filter((s) => s.look === "hatch");
  add(
    "hatch",
    hatched.length,
    hatched.every((s) => s.source === "also" && s.listing.price === undefined)
      ? "no price published"
      : "no price or bed count",
    "Hatched: on the leasing site, but listed without a price or without a bed count",
  );
  add(
    "muted",
    count((s) => s.look === "muted"),
    "not in the filter",
    "Grey: listed, but not in the current filter — the filters above hide it from the table",
  );
  if (drawn.length > 0) {
    add(
      "ghost",
      null,
      "on a far side",
      "Faint: the mark is on a side of the tower that is hidden from this viewpoint",
    );
  }

  const unplaced = states.filter((s) => !isDrawn(s));
  const reasons = [
    ...new Set(unplaced.map((s) => s.mark.note).filter((n): n is string => Boolean(n))),
  ];
  return {
    listed: states.filter((s) => s.source === "unit").length,
    sizes,
    rows,
    unplaced: unplaced.length > 0 ? { count: unplaced.length, reasons } : null,
  };
}
