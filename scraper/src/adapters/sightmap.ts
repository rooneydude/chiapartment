import { parseLeaseTermMonths } from "../../../shared/src/parse";
import { chicagoDate, isIsoDay } from "../../../shared/src/time";
import type { BuildingConfig, LeaseTermPrice, UnitListing } from "../../../shared/src/types";
import { dedupeListings, MAX_SANE_RENT, MIN_SANE_RENT } from "../normalize";
import type { Adapter, AdapterContext } from "./types";

/**
 * SightMap (Engrain) — the interactive floorplate map many leasing sites
 * embed. Its pricing API carries every available unit with real unit number,
 * price, sqft, availability date, and specials; a per-unit leasing API adds
 * the full lease-term price table. Used by 1225 Old Town.
 *
 * Every unit the API lists is recorded — at the price and lease term the site
 * itself headlines, with the whole lease-term table attached. Nothing is
 * filtered or re-priced here: choosing which lease length to look at is the
 * dashboard's job, not the scraper's.
 */

export interface SightmapUnit {
  id: string;
  unit_number: string;
  floor_id: string;
  floor_plan_id: string;
  price: number;
  area: number | null;
  /** Earliest move-in day (YYYY-MM-DD); today's date for a vacant unit. */
  available_on: string | null;
  /** "Available Now" or "Available Dec 26th". */
  display_available_on?: string | null;
  specials_description?: string | null;
  /** e.g. "18 Months" — the lease term the advertised price applies to. */
  display_lease_term?: string | null;
  /**
   * Per-unit leasing API: lease term → price for ONE move-in day, chosen with
   * a `date=YYYY-MM-DD` query parameter. Without it the API assumes today and
   * answers `{"options": []}` for any unit that is not vacant yet.
   */
  leasing_price_url?: string | null;
}

export interface SightmapPayload {
  data: {
    id: string;
    floors: { id: string; filter_short_label: string }[];
    floor_plans: {
      id: string;
      name: string;
      bedroom_count: number;
      bathroom_count: number;
      bedroom_label?: string | null;
    }[];
    units: SightmapUnit[];
    unit_map?: { url?: string };
  };
}

/** Plan names are sometimes serialized JSON junk — clean or fall back. */
export function cleanPlanName(
  plan: { name: string; bedroom_count: number },
): string {
  let name = plan.name?.trim() ?? "";
  if (name.startsWith("{")) {
    try {
      const parsed = JSON.parse(name) as { name?: string };
      name = parsed.name?.trim() ?? "";
    } catch {
      name = "";
    }
  }
  name = name.replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > 40) {
    return plan.bedroom_count === 0 ? "Studio" : `${plan.bedroom_count} BR`;
  }
  return name;
}

async function fetchText(url: string, ctx: AdapterContext, kind: string): Promise<string> {
  const res = await ctx.fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${kind} ${url}`);
  const text = await res.text();
  ctx.record?.(url, text, res.headers.get("content-type") ?? "text/html");
  return text;
}

/**
 * Resolve the pricing-API URL: pinned adapterOptions.sightmapApiUrl, else
 * discover the embed on the site's floorplans page, then the API path inside
 * the embed. Every hop is recorded in capture mode.
 */
export async function resolveSightmapApiUrl(
  building: BuildingConfig,
  ctx: AdapterContext,
): Promise<string> {
  const pinned = building.adapterOptions?.["sightmapApiUrl"];
  if (typeof pinned === "string" && pinned.length > 0) return pinned;

  const pageUrl = new URL("floorplans", building.url).href;
  const html = await fetchText(pageUrl, ctx, "floorplans page");
  const embed = /https:\/\/sightmap\.com\/embed\/(\w+)/.exec(html);
  if (!embed) throw new Error(`no SightMap embed found on ${pageUrl}`);

  const embedHtml = await fetchText(embed[0], ctx, "SightMap embed");
  const api = /app\/api\/v1\/\w+\/sightmaps\/\d+/.exec(embedHtml);
  if (!api) throw new Error(`no SightMap API path found in embed ${embed[0]}`);
  return `https://sightmap.com/${api[0]}`;
}

const TERM_KEY = /^(lease_)?term(_months|_length)?$|^months$|^lease_months$/i;
const PRICE_KEY = /^(price|rent|amount|rate|monthly_price|base_rent)$/i;

/**
 * Pull {term, price} pairs out of a leasing-matrix payload without assuming
 * its exact shape: any object carrying a plausible term field and a plausible
 * price field counts. Terms labeled as strings ("14 Months") work too.
 * Dedupes to the cheapest price seen per term. Fallback for payloads that do
 * not match the documented `data.options[]` shape (see parseLeaseTable).
 */
export function extractTermPrices(json: unknown): Map<number, number> {
  const best = new Map<number, number>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    let term: number | null = null;
    let price: number | null = null;
    for (const [k, v] of Object.entries(obj)) {
      if (term === null && TERM_KEY.test(k)) {
        if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 36) term = v;
        else if (typeof v === "string") term = parseLeaseTermMonths(v);
      }
      if (price === null && PRICE_KEY.test(k)) {
        const n =
          typeof v === "number"
            ? v
            : typeof v === "string"
              ? Number.parseFloat(v.replace(/[^0-9.]/g, ""))
              : NaN;
        if (Number.isFinite(n) && n >= MIN_SANE_RENT && n <= MAX_SANE_RENT) price = Math.round(n);
      }
    }
    if (term !== null && price !== null) {
      const prev = best.get(term);
      if (prev === undefined || price < prev) best.set(term, price);
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(json);
  return best;
}

/** The leasing-API URL for one move-in day (see SightmapUnit.leasing_price_url). */
export function leasingUrlForDate(leasingUrl: string, moveInDay: string | null): string {
  if (!moveInDay || !isIsoDay(moveInDay)) return leasingUrl;
  try {
    const u = new URL(leasingUrl);
    u.searchParams.set("date", moveInDay);
    return u.href;
  } catch {
    return leasingUrl;
  }
}

export interface LeaseTable {
  terms: LeaseTermPrice[];
  /** lease term → the site's own "apply for this unit at this term" link. */
  applyUrls: Map<number, string>;
}

/**
 * Parse a leasing-API payload into a sorted lease-term table. The documented
 * shape is `{data: {options: [{lease_term, price, apply_url}]}}`; anything
 * else falls back to the shape-agnostic extractor.
 */
export function parseLeaseTable(json: unknown): LeaseTable {
  const byTerm = new Map<number, number>();
  const applyUrls = new Map<number, string>();
  const options = (json as { data?: { options?: unknown } } | null)?.data?.options;
  if (Array.isArray(options)) {
    for (const raw of options) {
      if (raw === null || typeof raw !== "object") continue;
      const opt = raw as { lease_term?: unknown; price?: unknown; apply_url?: unknown };
      const months = typeof opt.lease_term === "number" ? opt.lease_term : Number.NaN;
      const price = typeof opt.price === "number" ? opt.price : Number.NaN;
      if (!Number.isInteger(months) || months < 1 || months > 36) continue;
      if (!Number.isFinite(price) || price < MIN_SANE_RENT || price > MAX_SANE_RENT) continue;
      byTerm.set(months, Math.round(price));
      if (typeof opt.apply_url === "string" && opt.apply_url.startsWith("https://")) {
        applyUrls.set(months, opt.apply_url);
      }
    }
  }
  const source = byTerm.size > 0 ? byTerm : extractTermPrices(json);
  const terms = [...source.entries()]
    .map(([months, price]) => ({ months, price }))
    .sort((a, b) => a.months - b.months);
  return { terms, applyUrls };
}

/**
 * Fetch a unit's lease-term table for its earliest move-in day. Null when the
 * unit has no leasing URL, the request fails, or the table is empty — the
 * unit is still recorded, just without the table.
 */
async function fetchLeaseTable(
  u: SightmapUnit,
  moveInDay: string | null,
  ctx: AdapterContext,
): Promise<LeaseTable | null> {
  if (!u.leasing_price_url) return null;
  try {
    const url = leasingUrlForDate(u.leasing_price_url, moveInDay);
    const table = parseLeaseTable(JSON.parse(await fetchText(url, ctx, "leasing matrix")));
    return table.terms.length > 0 ? table : null;
  } catch (err) {
    ctx.log(
      `lease terms for unit ${u.unit_number} unavailable (${err instanceof Error ? err.message : err})`,
    );
    return null;
  }
}

export async function fetchSightmapPayload(
  building: BuildingConfig,
  ctx: AdapterContext,
): Promise<SightmapPayload> {
  const apiUrl = await resolveSightmapApiUrl(building, ctx);
  const text = await fetchText(apiUrl, ctx, "SightMap API");
  return JSON.parse(text) as SightmapPayload;
}

export const sightmap: Adapter = {
  id: "sightmap",
  async scrape(building, ctx) {
    const payload = await fetchSightmapPayload(building, ctx);
    const plans = new Map(payload.data.floor_plans.map((p) => [p.id, p]));
    const today = chicagoDate(ctx.now?.() ?? new Date());

    const listings: UnitListing[] = [];
    let withTerms = 0;
    for (const u of payload.data.units) {
      const plan = plans.get(u.floor_plan_id);
      if (!plan || !u.unit_number || !Number.isFinite(u.price) || u.price <= 0) continue;

      const availableOn = u.available_on && isIsoDay(u.available_on) ? u.available_on : null;
      const saysNow = /\bnow\b/i.test(u.display_available_on ?? "");
      const availableNow = saysNow || (availableOn !== null && availableOn <= today);
      const availableDate = availableOn ?? (saysNow ? today : null);

      // The lease-term table is quoted for the unit's own earliest move-in
      // day; asking without a date returns nothing for units not yet vacant.
      const term = parseLeaseTermMonths(u.display_lease_term);
      await ctx.pause?.(250);
      const table = await fetchLeaseTable(u, availableDate, ctx);
      if (table) {
        withTerms++;
        const atTerm = term !== null ? table.terms.find((t) => t.months === term) : undefined;
        if (atTerm && Math.abs(atTerm.price - u.price) > 1) {
          ctx.log(
            `unit ${u.unit_number}: site headlines $${u.price} @ ${term}mo but its lease table says $${atTerm.price} for that term`,
          );
        }
      }
      const applyUrl = term !== null ? table?.applyUrls.get(term) : undefined;

      listings.push({
        unitNumber: u.unit_number,
        floorplanName: cleanPlanName(plan),
        beds: plan.bedroom_count,
        baths: plan.bathroom_count || null,
        sqft: u.area && u.area > 100 ? Math.round(u.area) : null,
        price: Math.round(u.price),
        leaseTermMonths: term,
        ...(table ? { leaseTerms: table.terms } : {}),
        availableDate,
        ...(availableDate !== null ? { availableNow } : {}),
        ...(u.specials_description ? { specials: u.specials_description } : {}),
        url: applyUrl ?? building.url,
      });
    }
    if (listings.length > 0) {
      ctx.log(`${withTerms}/${listings.length} units have a lease-term price table`);
    }
    return dedupeListings(listings);
  },
};
