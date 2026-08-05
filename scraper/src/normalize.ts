import * as cheerio from "cheerio";
import type { UnitListing } from "../../shared/src/types";

/**
 * Heuristic normalization of arbitrary scraped payloads (JSON from leasing
 * platform APIs, or rendered HTML) into UnitListing[]. Per-site adapters can
 * bypass this entirely; the generic adapters lean on it.
 */

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

export function coercePrice(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const m = v.replace(/[,$\s]/g, "").match(/\d+(\.\d+)?/);
    if (m) return Number.parseFloat(m[0]);
  }
  return null;
}

export function coerceBeds(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6) return v;
  if (typeof v === "string") {
    if (/studio|convertible/i.test(v)) return 0;
    const m = v.match(/\d+/);
    if (m) {
      const n = Number.parseInt(m[0], 10);
      if (n >= 0 && n <= 6) return n;
    }
  }
  return null;
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.replace(/[,\s]/g, "").match(/\d+(\.\d+)?/);
    if (m) return Number.parseFloat(m[0]);
  }
  return null;
}

/** Case-insensitive property getter over an object's own keys. */
function lowerKeyGetter(obj: Record<string, unknown>) {
  const map = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) {
    if (!map.has(k.toLowerCase())) map.set(k.toLowerCase(), v);
  }
  return (candidates: string[]): unknown => {
    for (const c of candidates) {
      const v = map.get(c);
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
  };
}

const PRICE_KEYS = [
  "minrent", "min_rent", "rentmin", "minimumrent", "startingprice", "startingat",
  "effectiverent", "marketrent", "market_rent", "bestprice", "best_price",
  "minprice", "min_price", "rent", "price", "rentamount", "rent_amount",
];
const PRICE_MAX_KEYS = ["maxrent", "max_rent", "rentmax", "maximumrent", "maxprice", "max_price"];
const BEDS_KEYS = ["beds", "bed", "bedrooms", "bedroom", "bedroomcount", "bedscount", "numberofbeds", "br"];
const BATHS_KEYS = ["baths", "bath", "bathrooms", "bathroom", "bathroomcount"];
const SQFT_KEYS = ["sqft", "sq_ft", "squarefeet", "squarefootage", "sqfeet", "area", "size"];
const UNIT_KEYS = [
  "unitnumber", "unit_number", "apartmentnumber", "apartment_number",
  "apartmentname", "unitname", "unit", "aptnumber",
];
const PLAN_KEYS = [
  "floorplanname", "floorplan_name", "floorplan", "floorplantitle", "planname",
  "plan", "modelname", "model", "fpname", "name", "title",
];
const DATE_KEYS = [
  "availabledate", "available_date", "dateavailable", "availableon", "available_on",
  "availablefrom", "availability", "moveindate", "movein",
];
const URL_KEYS = ["availabilityurl", "applyurl", "applyonlineurl", "url", "link", "permalink"];

export const MIN_SANE_RENT = 400;
export const MAX_SANE_RENT = 25000;

function looksLikeUnitNumber(v: unknown): string | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 100000) return String(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (s.length >= 1 && s.length <= 8 && /\d/.test(s) && !/\s{2,}/.test(s)) return s;
  }
  return null;
}

/** Try to interpret one JSON object as a unit/floorplan listing. */
export function toListing(obj: unknown): UnitListing | null {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const get = lowerKeyGetter(obj as Record<string, unknown>);

  const price = coercePrice(get(PRICE_KEYS));
  if (price === null || price < MIN_SANE_RENT || price > MAX_SANE_RENT) return null;
  const beds = coerceBeds(get(BEDS_KEYS));
  if (beds === null) return null;

  const priceMax = coercePrice(get(PRICE_MAX_KEYS));
  const baths = coerceNumber(get(BATHS_KEYS));
  const sqftRaw = coerceNumber(get(SQFT_KEYS));
  const sqft = sqftRaw !== null && sqftRaw >= 150 && sqftRaw <= 6000 ? Math.round(sqftRaw) : null;
  const unitNumber = looksLikeUnitNumber(get(UNIT_KEYS));

  const planRaw = get(PLAN_KEYS);
  const floorplanName =
    typeof planRaw === "string" && planRaw.trim() && planRaw.trim().length <= 60
      ? planRaw.trim()
      : beds === 0
        ? "Studio"
        : `${beds} BR`;

  const dateRaw = get(DATE_KEYS);
  const availableDate = typeof dateRaw === "string" && dateRaw.trim() ? dateRaw.trim() : null;
  const urlRaw = get(URL_KEYS);
  const url = typeof urlRaw === "string" && /^https?:\/\//.test(urlRaw) ? urlRaw : undefined;

  return {
    unitNumber,
    floorplanName,
    beds,
    baths,
    sqft,
    price,
    ...(priceMax !== null && priceMax > price ? { priceMax } : {}),
    availableDate,
    ...(url ? { url } : {}),
  };
}

/**
 * Walk an arbitrary JSON tree and harvest every array whose elements look
 * like unit/floorplan listings.
 */
export function findUnitListings(root: unknown): UnitListing[] {
  const out: UnitListing[] = [];
  const seen = new Set<unknown>();

  function walk(node: unknown, depth: number): void {
    if (depth > 10 || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      const listings = node.map(toListing).filter((l): l is UnitListing => l !== null);
      if (listings.length > 0) out.push(...listings);
      // Still recurse: arrays of wrapper objects may hold nested unit arrays.
      if (listings.length === 0) for (const el of node) walk(el, depth + 1);
      return;
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  }

  walk(root, 0);
  return dedupeListings(out);
}

export function dedupeListings(listings: UnitListing[]): UnitListing[] {
  const seen = new Set<string>();
  const out: UnitListing[] = [];
  for (const l of listings) {
    const key = l.unitNumber
      ? `u:${l.unitNumber}`
      : `f:${l.floorplanName}:${l.beds}:${l.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML fallback
// ---------------------------------------------------------------------------

const CARD_SELECTOR = "div,li,article,section,tr";

/**
 * Last-resort DOM heuristics: find small elements containing a dollar price
 * and a bedroom keyword, treat each as a listing card.
 */
/**
 * Element text with spaces between nodes — cheerio's .text() glues adjacent
 * elements together ("<h3>A1</h3><span>1 Bed</span>" → "A11 Bed"), which
 * breaks the regexes below.
 */
function spacedText($: cheerio.CheerioAPI, el: object): string {
  const parts: string[] = [];
  (function walk(node: { children?: unknown[]; type?: string; data?: string }): void {
    if (node.type === "text" && typeof node.data === "string") {
      parts.push(node.data);
      return;
    }
    for (const child of node.children ?? []) walk(child as never);
  })(el as never);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function isCardText(text: string): boolean {
  return (
    text.length >= 8 &&
    text.length <= 400 &&
    /\$\s?[\d,]{3,}/.test(text) &&
    /(studio|convertible|\bbed|\bbr\b)/i.test(text)
  );
}

export function parseHtmlListings(html: string): UnitListing[] {
  const $ = cheerio.load(html);
  const out: UnitListing[] = [];

  // Two passes: collect all matching elements, then keep only the innermost
  // ones (a wrapper containing several cards also matches the text test).
  const candidates: object[] = [];
  $(CARD_SELECTOR).each((_, el) => {
    if (isCardText(spacedText($, el))) candidates.push(el);
  });
  const candidateSet = new Set(candidates);
  const innermost = candidates.filter((el) =>
    $(el as never)
      .find(CARD_SELECTOR)
      .toArray()
      .every((d) => !candidateSet.has(d)),
  );

  for (const raw of innermost) {
    const el = raw as never;
    const text = spacedText($, el);
    const prices = [...text.matchAll(/\$\s?([\d,]{3,})/g)]
      .map((m) => Number.parseInt(m[1]!.replace(/,/g, ""), 10))
      .filter((p) => p >= MIN_SANE_RENT && p <= MAX_SANE_RENT);
    if (prices.length === 0) continue;

    const beds = coerceBeds(
      /studio|convertible/i.test(text) ? "studio" : /(\d+)\s*(?:br\b|bed)/i.exec(text)?.[1],
    );
    if (beds === null) continue;

    const sqftM = /([\d,]{3,})\s*(?:sq\.?\s?ft|sf\b)/i.exec(text);
    const sqft = sqftM ? Number.parseInt(sqftM[1]!.replace(/,/g, ""), 10) : null;
    const unitM = /(?:unit|apt|apartment|#)\s*#?\s*([A-Z]?\d{2,5}[A-Z]?)\b/i.exec(text);
    const bathsM = /([\d.]+)\s*(?:ba\b|bath)/i.exec(text);
    const heading = $(el).find("h1,h2,h3,h4,h5,strong").first().text().trim();

    out.push({
      unitNumber: unitM ? unitM[1]! : null,
      floorplanName:
        heading && heading.length <= 60 ? heading : beds === 0 ? "Studio" : `${beds} BR`,
      beds,
      baths: bathsM ? Number.parseFloat(bathsM[1]!) : null,
      sqft: sqft !== null && sqft >= 150 && sqft <= 6000 ? sqft : null,
      price: Math.min(...prices),
      availableDate: null,
    });
  }

  return dedupeListings(out);
}
