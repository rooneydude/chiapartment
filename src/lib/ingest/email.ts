import {
  clean,
  parseAvailability,
  parseBedrooms,
  parseLeaseTerm,
  parseMoney,
  parseSqft,
} from "../scrape/parse";
import { normalizeDeg } from "../geo";
import type { Charge, ChargeKind } from "../pricing/schema";

/**
 * Parse the tour follow-up emails leasing agents send.
 *
 * These are the highest-quality data source in the whole pipeline, and the
 * only one that states a unit's orientation outright ("Southeast facing view",
 * "Views Facing South", "View: South-West facing"). A scraped listing page
 * never says which way a unit looks; the agent always does. Those statements
 * become facing observations that pin down the floor plate, which no amount of
 * scraping can.
 *
 * The format is free prose, so this is deliberately tolerant: it looks for
 * unit-shaped headings, then reads labelled facts beneath each one.
 */

export interface UnitFact {
  /** Unit label as written, e.g. "707", "3508", "1509". */
  unitCode: string;
  /** Tower/wing when the building has more than one, e.g. "OTP2". */
  wing?: string;
  planName?: string;
  bedrooms?: number;
  rent?: number;
  /** Rent with utilities folded in, when the agent quotes both. */
  allInRent?: number;
  sqft?: number;
  /** Compass bearing the unit faces, degrees from north. */
  facingDeg?: number;
  /** The words the agent used, kept verbatim for provenance. */
  facingText?: string;
  availableFrom?: string;
  availableThrough?: string;
  leaseMonths?: number;
  tourUrl?: string;
}

export interface IngestResult {
  buildingHint?: string;
  units: UnitFact[];
  charges: Charge[];
  /** Statements that clearly matter but weren't parseable into fields. */
  notes: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Compass words
// ---------------------------------------------------------------------------

const COMPASS_WORDS: Array<[RegExp, number]> = [
  [/\bnorth[\s-]*east\b|\bnortheast\b|\bNE\b/i, 45],
  [/\bnorth[\s-]*west\b|\bnorthwest\b|\bNW\b/i, 315],
  [/\bsouth[\s-]*east\b|\bsoutheast\b|\bSE\b/i, 135],
  [/\bsouth[\s-]*west\b|\bsouthwest\b|\bSW\b/i, 225],
  [/\bnorth\b|\bN\b/i, 0],
  [/\beast\b|\bE\b/i, 90],
  [/\bsouth\b|\bS\b/i, 180],
  [/\bwest\b|\bW\b/i, 270],
];

/**
 * Read a compass direction out of a phrase. Compound directions are tested
 * first so "South-West facing" doesn't match as plain south.
 */
export function parseFacing(text: string): { deg: number; text: string } | null {
  const t = clean(text);
  if (!t) return null;
  for (const [re, deg] of COMPASS_WORDS) {
    const m = t.match(re);
    if (m) return { deg: normalizeDeg(deg), text: t };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** "Unit: 707", "Unit#: 3508", "1509 Medium Two Bedroom", "OTP2 # 3508". */
const UNIT_HEADING = [
  // "OTP2  Plan B2   2 - Bedroom Unit#:  3508" — wing first, unit later.
  /(?:^|\n)\s*(?<wing>[A-Z]{2,5}\d?)?[^\n]*?\bunit\s*#?\s*:?\s*(?<unit>\d{3,5}[A-Z]?)\b/gi,
  // "1509 Medium Two Bedroom" — unit number leads a bullet.
  /(?:^|\n)\s*(?:[-*•·]\s*)?(?<unit>\d{3,5})\s+(?<plan>[A-Z][^\n:]{3,50})/g,
];

const FIELD_PATTERNS: Array<{
  key: keyof UnitFact;
  re: RegExp;
  parse: (raw: string) => unknown;
}> = [
  { key: "rent", re: /\bbase\s*rent\s*:?\s*([^\n]+)/i, parse: parseMoney },
  { key: "rent", re: /\bprice\s*:?\s*([^\n]+)/i, parse: parseMoney },
  {
    key: "allInRent",
    re: /\ball[\s-]*in[^:\n]*:?\s*([^\n]+)/i,
    parse: parseMoney,
  },
  { key: "sqft", re: /\bsize\s*:?\s*([^\n]+)/i, parse: parseSqft },
  { key: "sqft", re: /\b([\d,]{3,5})\s*(?:sq\.?\s*ft|sf)\b/i, parse: parseSqft },
  { key: "leaseMonths", re: /\blease\s*length\s*:?\s*([^\n]+)/i, parse: parseLeaseTerm },
  { key: "bedrooms", re: /\b(studio|convertible|[\d.]+\s*bed[^\n]*)/i, parse: parseBedrooms },
];

/**
 * Split the message into per-unit blocks, then read fields inside each block.
 * Block boundaries are unit headings; everything before the first one is
 * building-level text.
 */
export function parseAgentEmail(
  raw: string,
  opts: { today?: Date } = {},
): IngestResult {
  const text = raw.replace(/\r\n/g, "\n").replace(/ /g, " ");
  const warnings: string[] = [];
  const notes: string[] = [];

  const anchors = findUnitAnchors(text);
  const units: UnitFact[] = [];

  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i].index;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : text.length;
    const block = text.slice(start, end);

    const fact: UnitFact = { unitCode: anchors[i].unit };
    if (anchors[i].wing) fact.wing = anchors[i].wing;
    if (anchors[i].plan) fact.planName = anchors[i].plan;

    for (const { key, re, parse } of FIELD_PATTERNS) {
      if (fact[key] != null) continue;
      const m = block.match(re);
      if (!m) continue;
      const value = parse(m[1]);
      if (value != null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fact as any)[key] = value;
      }
    }

    // Orientation: only trust a compass word that sits near "facing"/"view",
    // otherwise a street name ("N Wells") would read as a direction.
    const facingLine = block.match(
      /([^\n]*\b(?:view[s]?|facing|exposure)\b[^\n]*)/i,
    )?.[1];
    if (facingLine) {
      const facing = parseFacing(facingLine);
      if (facing) {
        fact.facingDeg = facing.deg;
        fact.facingText = clean(facingLine);
      }
    }

    const availability = readAvailability(block, opts.today);
    Object.assign(fact, availability);

    const tour = block.match(/https?:\/\/\S*matterport\S+|https?:\/\/\S+/i)?.[0];
    if (tour) fact.tourUrl = tour.replace(/[),.]+$/, "");

    if (fact.rent == null && fact.sqft == null && fact.facingDeg == null) {
      warnings.push(`Unit ${fact.unitCode}: no rent, size or orientation found.`);
    }
    units.push(fact);
  }

  if (units.length === 0) {
    warnings.push(
      "No unit blocks recognised. Expected lines like 'Unit: 707' or '1509 Two Bedroom'.",
    );
  }

  const charges = parseCharges(text);
  const buildingHint = guessBuilding(text);
  for (const line of extractPolicyNotes(text)) notes.push(line);

  return { buildingHint, units: dedupe(units), charges, notes, warnings };
}

interface Anchor {
  index: number;
  unit: string;
  wing?: string;
  plan?: string;
}

function findUnitAnchors(text: string): Anchor[] {
  const found = new Map<number, Anchor>();

  for (const pattern of UNIT_HEADING) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const groups = m.groups ?? {};
      const unit = groups.unit;
      if (!unit) continue;
      // A four-digit number that is really a year or a price is not a unit.
      if (/^(19|20)\d{2}$/.test(unit)) continue;
      const index = m.index;
      if (!found.has(index)) {
        found.set(index, {
          index,
          unit,
          wing: groups.wing ? clean(groups.wing) : undefined,
          plan: groups.plan ? clean(groups.plan) : undefined,
        });
      }
    }
  }

  // Collapse anchors that land on the same unit within a few characters.
  const sorted = [...found.values()].sort((a, b) => a.index - b.index);
  const out: Anchor[] = [];
  for (const a of sorted) {
    const prev = out.at(-1);
    if (prev && prev.unit === a.unit && a.index - prev.index < 120) {
      prev.plan ??= a.plan;
      prev.wing ??= a.wing;
      continue;
    }
    out.push(a);
  }
  return out;
}

function readAvailability(
  block: string,
  today?: Date,
): Pick<UnitFact, "availableFrom" | "availableThrough"> {
  const out: Pick<UnitFact, "availableFrom" | "availableThrough"> = {};

  // "Lease available now through October 1st"
  const through = block.match(
    /\bavailable\b[^\n]*?\bthrough\b\s*([^\n(,]+)/i,
  );
  if (through) {
    const to = parseAvailability(through[1], today);
    if (to) out.availableThrough = to;
  }

  // "Move-in date: 8/19- 9/03", "Available for move-in: 9/6 - 9/20"
  const range = block.match(
    /\b(?:move[\s-]*in|available(?:\s+for\s+move[\s-]*in)?)\b\s*(?:date)?\s*:?\s*([^\n]+)/i,
  );
  if (range) {
    const parts = range[1].split(/\s*[-–—]\s*/);
    const from = parseAvailability(parts[0], today);
    if (from) out.availableFrom = from;
    if (parts.length > 1 && !out.availableThrough) {
      const to = parseAvailability(parts[1], today);
      if (to) out.availableThrough = to;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

interface ChargeRule {
  re: RegExp;
  kind: ChargeKind;
  label: string;
  cadence?: Charge["cadence"];
  requirement?: Charge["requirement"];
  includes?: string[];
}

// Order matters. Amount-before-label patterns are tried first because a line
// like "Application Fees: $500 admin fee and $75.00 application fee" pairs
// every amount with the *following* label, not the preceding heading — a
// label-first pattern reads both fees backwards.
const CHARGE_RULES: ChargeRule[] = [
  {
    re: /\$\s*([\d,.]+)\s*application\s*fee/i,
    kind: "application",
    label: "Application fee",
    cadence: "per_person_one_time",
  },
  {
    re: /\$\s*([\d,.]+)\s*admin(?:istrative)?\s*fee/i,
    kind: "admin",
    label: "Administrative fee",
    cadence: "one_time",
  },
  {
    // The gap is bounded so the amount can't be borrowed from a later fee.
    re: /\bapplication\s*fee[^$\n]{0,25}\$\s*([\d,.]+)/i,
    kind: "application",
    label: "Application fee",
    cadence: "per_person_one_time",
  },
  {
    re: /\badmin(?:istrative)?\s*fee[^$\n]{0,25}\$\s*([\d,.]+)/i,
    kind: "admin",
    label: "Administrative fee",
    cadence: "one_time",
  },
  {
    re: /\bparking\b[^$\n]*\$\s*([\d,.]+)\s*(?:\/|per\s*)?\s*month/i,
    kind: "parking",
    label: "Reserved parking",
    requirement: "optional",
  },
  {
    re: /\breserved\s*parking[^$\n]*\$\s*([\d,.]+)/i,
    kind: "parking",
    label: "Reserved parking",
    requirement: "optional",
  },
  {
    re: /\bev\s*(?:parking|charging)[^$\n]*\$\s*([\d,.]+)/i,
    kind: "parking",
    label: "EV parking",
    requirement: "conditional",
  },
  {
    re: /\bsmall\s*storage[^$\n]*\$\s*([\d,.]+)/i,
    kind: "storage",
    label: "Small storage",
    requirement: "optional",
  },
  {
    re: /\blarge\s*storage[^$\n]*\$\s*([\d,.]+)/i,
    kind: "storage",
    label: "Large storage",
    requirement: "optional",
  },
  {
    // Fee sheets wrap mid-sentence ("…for a fee\nof $65 per month"), so this
    // one deliberately crosses newlines, bounded so it can't reach a
    // different fee further down the page.
    re: /\binternet\b[\s\S]{0,160}?\$\s*([\d,.]+)/i,
    kind: "internet",
    label: "Internet",
    includes: ["internet"],
  },
  {
    re: /\bliability\s*waiver[^$\n]*\$\s*([\d,.]+)/i,
    kind: "insurance",
    label: "Resident liability waiver",
  },
  {
    re: /\$\s*([\d,.]+)\s*\/?\s*month[^\n]*liability\s*waiver/i,
    kind: "insurance",
    label: "Resident liability waiver",
  },
  {
    re: /\bpet\s*rent\b[^$\n]*\$\s*([\d,.]+)/i,
    kind: "pet",
    label: "Pet rent",
    requirement: "conditional",
  },
];

/** Bundled-utility fee tables: "Studio: $50", "2 Bedroom: $115". */
const UTILITY_TIER =
  /\b(studio|jr\.?\s*1\s*bed(?:room)?|convertible|(\d)\s*bedroom(?:\s*\+\s*den)?)\s*:?\s*\$\s*([\d,.]+)/gi;

const RUBS =
  /\bRUBS\b|resident\s+utility\s+billing|billed\s+through\s+the\s+building/i;

export function parseCharges(text: string): Charge[] {
  const charges: Charge[] = [];
  const seen = new Set<string>();

  const add = (c: Charge) => {
    const key = `${c.kind}:${c.label}:${c.appliesToBedrooms ?? "*"}:${c.appliesToPlanName ?? "*"}`;
    if (seen.has(key)) return;
    seen.add(key);
    charges.push(c);
  };

  for (const rule of CHARGE_RULES) {
    const m = text.match(rule.re);
    if (!m) continue;
    const amount = toAmount(m[1]);
    if (amount == null) continue;
    add({
      kind: rule.kind,
      label: rule.label,
      amount,
      cadence: rule.cadence ?? "monthly",
      requirement: rule.requirement ?? "required",
      appliesToBedrooms: null,
      appliesToPlanName: null,
      includes: rule.includes ?? [],
      source: { kind: "email" },
    });
  }

  // Per-unit-type bundled utilities.
  let m: RegExpExecArray | null;
  const tierRe = new RegExp(UTILITY_TIER.source, UTILITY_TIER.flags);
  while ((m = tierRe.exec(text))) {
    const label = clean(m[1]);
    const amount = toAmount(m[3]);
    if (amount == null) continue;
    const bedrooms = parseBedrooms(label);
    if (bedrooms == null) continue;
    // "1 Bedroom + Den" has one bedroom but its own utility tier, so the
    // bedroom count alone cannot identify it.
    const isVariant = /\+\s*den|jr\.?\s*1|convertible/i.test(label);
    add({
      kind: "utilities",
      label: `Bundled utilities (${label})`,
      amount,
      cadence: "monthly",
      requirement: "required",
      appliesToBedrooms: bedrooms,
      appliesToPlanName: isVariant ? label : null,
      includes: ["gas", "water", "sewer", "trash", "recycling"],
      source: { kind: "email" },
    });
  }

  // A RUBS split is a real required cost with no fixed amount.
  if (RUBS.test(text) && !charges.some((c) => c.kind === "utilities")) {
    add({
      kind: "utilities",
      label: "Utilities (RUBS allocation)",
      amount: null,
      cadence: "variable",
      requirement: "required",
      appliesToBedrooms: null,
      appliesToPlanName: null,
      includes: ["water", "sewer", "trash", "gas"],
      note: "Billed building-wide and split by square footage and occupancy.",
      source: { kind: "email" },
    });
  }

  // Electric is nearly always the resident's own account.
  if (/\bComEd\b|\belectric(?:ity)?\b[^\n]*\b(?:own|yourself|separate)/i.test(text)) {
    add({
      kind: "electric",
      label: "Electricity (own ComEd account)",
      amount: null,
      cadence: "variable",
      requirement: "required",
      appliesToBedrooms: null,
      appliesToPlanName: null,
      includes: [],
      note: "Set up directly with ComEd; not billed by the building.",
      source: { kind: "email" },
    });
  }

  return charges;
}

function toAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 && n < 100_000 ? n : null;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function guessBuilding(text: string): string | undefined {
  const m =
    text.match(/\b(?:visiting|touring|tour at|welcome to)\s+([A-Z][\w' ]{2,40})/i) ??
    text.match(/\b(The Leo|Old Town Park|Stead\s*\d+|Fulbrix)\b/i);
  return m ? clean(m[1]) : undefined;
}

const POLICY_HINTS = [
  /renter'?s?\s+insurance[^\n]*/i,
  /\bRUBS\b[^\n]*/i,
  /application[^\n]*screening[^\n]*/i,
  /\bnot\s+secured\s+until[^\n]*/i,
];

function extractPolicyNotes(text: string): string[] {
  const out: string[] = [];
  for (const re of POLICY_HINTS) {
    const m = text.match(re);
    if (m) out.push(clean(m[0]));
  }
  return out;
}

function dedupe(units: UnitFact[]): UnitFact[] {
  const byKey = new Map<string, UnitFact>();
  for (const u of units) {
    const key = `${u.wing ?? ""}:${u.unitCode}`;
    const prior = byKey.get(key);
    byKey.set(key, prior ? { ...prior, ...stripUndefined(u) } : u);
  }
  return [...byKey.values()];
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
