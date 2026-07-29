import {
  parseAvailability,
  parseBathrooms,
  parseBedrooms,
  parseLeaseTerm,
  parseMoney,
  parseSqft,
  clean,
} from "./parse";
import type { ScrapedUnit } from "./types";

/**
 * Shape-based unit recognition.
 *
 * Every leasing platform ships the same handful of fields under different
 * names — `unitNumber` / `UnitNumber` / `apartment_name` / `name`, `rent` /
 * `MarketRent` / `minRent` / `price`. Rather than write that mapping N times,
 * adapters hand arbitrary objects to `asUnit()` and it recognises them by
 * shape. This is what makes a brand-new bespoke site usually work on the first
 * try, and it is the single most-tested piece of the scraper.
 */

const UNIT_KEYS = [
  "unitnumber", "unit_number", "unitname", "unit_name", "unit", "apartmentnumber",
  "apartment_number", "apartmentname", "apartment_name", "number", "name",
  "unitid", "unit_id", "displayname", "display_name", "unitmarketingname",
];

const RENT_KEYS = [
  "rent", "price", "minrent", "min_rent", "marketrent", "market_rent",
  "effectiverent", "effective_rent", "baserent", "base_rent", "startingat",
  "starting_at", "minimumrent", "rentamount", "rent_amount", "monthlyrent",
  "askingrent", "netrent", "bestprice", "lowestrent",
];

const MARKET_RENT_KEYS = [
  "marketrent", "market_rent", "baserent", "base_rent", "originalrent",
  "original_rent", "streetrent", "listprice", "wasprice", "maxrent",
];

const SQFT_KEYS = [
  "sqft", "sq_ft", "squarefeet", "square_feet", "squarefootage",
  "square_footage", "size", "minsqft", "min_sqft", "area", "unitsqft",
];

const BED_KEYS = [
  "beds", "bedrooms", "bed", "bedroomcount", "bedroom_count", "numberofbedrooms",
  "br", "bedroomtype",
];

const BATH_KEYS = [
  "baths", "bathrooms", "bath", "bathroomcount", "bathroom_count",
  "numberofbathrooms", "ba",
];

const AVAIL_KEYS = [
  "availabledate", "available_date", "dateavailable", "date_available",
  "availableon", "available_on", "availability", "availabledatetime",
  "moveindate", "move_in_date", "readydate", "available",
];

const PLAN_KEYS = [
  "floorplan", "floor_plan", "floorplanname", "floor_plan_name", "planname",
  "plan_name", "floorplanid", "floor_plan_id", "planid", "plan_id", "layout",
  "floorplancode", "unittype", "unit_type",
];

const URL_KEYS = ["url", "link", "href", "detailsurl", "permalink", "applyurl"];

const TERM_KEYS = ["leaseterm", "lease_term", "term", "leaselength", "months"];

/** Normalized key lookup: case- and separator-insensitive. */
function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  const norm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) {
    norm.set(k.toLowerCase().replace(/[^a-z0-9]/g, ""), v);
  }
  for (const key of keys) {
    const v = norm.get(key.replace(/[^a-z0-9]/g, ""));
    if (v != null && v !== "") return v;
  }
  return undefined;
}

function scalar(v: unknown): unknown {
  // Platforms love wrapping values: {value: 2395}, {amount: "2395"}, [2395].
  if (Array.isArray(v)) return v.length ? scalar(v[0]) : undefined;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["value", "amount", "text", "name", "label", "min", "display"]) {
      if (o[k] != null) return scalar(o[k]);
    }
    return undefined;
  }
  return v;
}

/**
 * A unit label must contain a digit and be short. This rejects the very common
 * false positive of a *plan* object (whose `name` is "The Wells") being read as
 * a unit, while still accepting "3208", "PH02" and "Unit 1104".
 */
export function looksLikeUnitCode(v: unknown): v is string {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 && v < 100_000;
  if (typeof v !== "string") return false;
  const s = clean(v);
  if (!s || s.length > 12) return false;
  if (!/\d/.test(s)) return false;
  // Reject strings that are obviously prices, sqft or dates.
  if (/^\$/.test(s)) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  return /^[A-Za-z#]{0,6}[\s.#-]?\d{1,5}[A-Za-z]?$/.test(s);
}

export interface ShapeOptions {
  /** Resolve relative listing URLs. */
  baseUrl?: string;
  /** Injected for deterministic date rollover in tests. */
  today?: Date;
}

/**
 * Try to read an arbitrary object as a unit. Returns null when the object
 * doesn't carry at least a plausible unit code plus one other signal — an
 * object with only a name is a plan, a nav item, or an image.
 */
export function asUnit(
  input: unknown,
  opts: ShapeOptions = {},
): ScrapedUnit | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;

  const codeRaw = scalar(pick(obj, UNIT_KEYS));
  if (!looksLikeUnitCode(codeRaw)) return null;
  const unitCode = clean(String(codeRaw));

  const rent = parseMoney(scalar(pick(obj, RENT_KEYS)));
  const marketRentRaw = parseMoney(scalar(pick(obj, MARKET_RENT_KEYS)));
  const sqft = parseSqft(scalar(pick(obj, SQFT_KEYS)));
  const bedrooms = parseBedrooms(scalar(pick(obj, BED_KEYS)));
  const bathrooms = parseBathrooms(scalar(pick(obj, BATH_KEYS)));
  const availableOn = parseAvailability(scalar(pick(obj, AVAIL_KEYS)), opts.today);
  const leaseTermMonths = parseLeaseTerm(scalar(pick(obj, TERM_KEYS)));

  // Require corroboration: a unit code alone is too weak a signal.
  const signals = [rent, sqft, bedrooms, availableOn].filter((v) => v != null).length;
  if (signals === 0) return null;

  const planRaw = scalar(pick(obj, PLAN_KEYS));
  const planKeyValue =
    planRaw != null && String(planRaw).trim() !== ""
      ? clean(String(planRaw))
      : undefined;

  let listingUrl: string | undefined;
  const urlRaw = scalar(pick(obj, URL_KEYS));
  if (typeof urlRaw === "string" && opts.baseUrl) {
    try {
      listingUrl = new URL(urlRaw, opts.baseUrl).toString();
    } catch {
      /* ignore unparseable links */
    }
  }

  // Only treat the market rent as distinct when it is actually higher —
  // many payloads set both fields to the same number.
  const marketRent =
    marketRentRaw != null && rent != null && marketRentRaw > rent
      ? marketRentRaw
      : undefined;

  return {
    unitCode,
    rent,
    marketRent,
    bedrooms,
    bathrooms,
    sqft,
    availableOn,
    leaseTermMonths,
    planKey: planKeyValue,
    listingUrl,
    status: "available",
  };
}

/**
 * Walk an arbitrary JSON tree and collect everything that reads as a unit.
 * Depth-limited so a pathological payload can't hang the scraper.
 */
export function harvestUnits(
  root: unknown,
  opts: ShapeOptions = {},
  maxDepth = 12,
): ScrapedUnit[] {
  const out = new Map<string, ScrapedUnit>();
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number) => {
    if (depth > maxDepth || node == null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const unit = asUnit(node, opts);
    if (unit) {
      // Prefer the richest record when the same unit appears twice.
      const prior = out.get(unit.unitCode);
      if (!prior || score(unit) > score(prior)) out.set(unit.unitCode, unit);
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      walk(value, depth + 1);
    }
  };

  walk(root, 0);
  return [...out.values()];
}

function score(u: ScrapedUnit): number {
  return (
    (u.rent != null ? 4 : 0) +
    (u.sqft != null ? 2 : 0) +
    (u.bedrooms != null ? 2 : 0) +
    (u.availableOn != null ? 2 : 0) +
    (u.planKey != null ? 1 : 0) +
    (u.bathrooms != null ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------
// Floor plans
// ---------------------------------------------------------------------------

const PLAN_NAME_KEYS = [
  "floorplanname", "floor_plan_name", "planname", "plan_name", "name", "title",
  "marketingname", "displayname", "floorplan",
];

const PLAN_IMAGE_KEYS = [
  "floorplanimage", "floor_plan_image", "planimage", "image", "imageurl",
  "image_url", "src", "media", "floorplanimageurl", "photo", "thumbnail",
  "floorplanimagename", "imagealttext",
];

const PLAN_ID_KEYS = [
  "floorplanid", "floor_plan_id", "planid", "plan_id", "id", "code",
  "floorplancode", "slug",
];

/**
 * Read an object as a floor plan. Plans are recognised by having a name plus
 * bed/bath/sqft but *not* a unit-shaped code, which is what separates them
 * from the unit records that sit alongside them in the same payload.
 */
export function asPlan(
  input: unknown,
  opts: ShapeOptions = {},
): import("./types").ScrapedPlan | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;

  const nameRaw = scalar(pick(obj, PLAN_NAME_KEYS));
  if (typeof nameRaw !== "string" && typeof nameRaw !== "number") return null;
  const name = clean(String(nameRaw));
  if (!name || name.length > 80) return null;

  const bedrooms = parseBedrooms(scalar(pick(obj, BED_KEYS)));
  const bathrooms = parseBathrooms(scalar(pick(obj, BATH_KEYS)));
  const sqft = parseSqft(scalar(pick(obj, SQFT_KEYS)));
  // A plan needs at least a bed count or a size, otherwise every nav link and
  // amenity blurb in the payload would qualify.
  if (bedrooms == null && sqft == null) return null;

  const idRaw = scalar(pick(obj, PLAN_ID_KEYS));
  const key =
    idRaw != null && String(idRaw).trim() !== ""
      ? clean(String(idRaw))
      : name;

  let imageUrl: string | undefined;
  const imgRaw = scalar(pick(obj, PLAN_IMAGE_KEYS));
  if (typeof imgRaw === "string" && /\.(png|jpe?g|webp|gif|svg|pdf)|\/image|\/media/i.test(imgRaw)) {
    try {
      imageUrl = opts.baseUrl ? new URL(imgRaw, opts.baseUrl).toString() : imgRaw;
    } catch {
      /* ignore */
    }
  }

  return { key, name, bedrooms, bathrooms, sqft, imageUrl };
}

export function harvestPlans(
  root: unknown,
  opts: ShapeOptions = {},
  maxDepth = 12,
): import("./types").ScrapedPlan[] {
  const out = new Map<string, import("./types").ScrapedPlan>();
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number) => {
    if (depth > maxDepth || node == null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    // Skip anything that reads as a unit — those are handled by harvestUnits.
    if (!looksLikeUnitCode(scalar(pick(node as Record<string, unknown>, UNIT_KEYS)))) {
      const plan = asPlan(node, opts);
      if (plan) {
        const prior = out.get(plan.key);
        if (!prior || planScore(plan) > planScore(prior)) out.set(plan.key, plan);
      }
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      walk(value, depth + 1);
    }
  };

  walk(root, 0);
  return [...out.values()];
}

function planScore(p: import("./types").ScrapedPlan): number {
  return (
    (p.imageUrl ? 4 : 0) +
    (p.sqft != null ? 2 : 0) +
    (p.bedrooms != null ? 2 : 0) +
    (p.bathrooms != null ? 1 : 0)
  );
}
