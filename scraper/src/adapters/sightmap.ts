import { parseLeaseTermMonths } from "../../../shared/src/parse";
import type { BuildingConfig, UnitListing } from "../../../shared/src/types";
import { dedupeListings, MAX_SANE_RENT, MIN_SANE_RENT } from "../normalize";
import type { Adapter, AdapterContext } from "./types";

/**
 * SightMap (Engrain) — the interactive floorplate map many leasing sites
 * embed. Its pricing API carries every available unit with real unit number,
 * price, sqft, availability date, and specials. Used by 1225 Old Town.
 */

export interface SightmapUnit {
  id: string;
  unit_number: string;
  floor_id: string;
  floor_plan_id: string;
  price: number;
  area: number | null;
  available_on: string | null;
  specials_description?: string | null;
  /** e.g. "14 Months" — the lease term the advertised price applies to. */
  display_lease_term?: string | null;
  /** Per-unit leasing API with the full lease-term × start-date matrix. */
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
 * Dedupes to the cheapest price seen per term.
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

/**
 * The advertised price sometimes belongs to a lease longer than the user
 * shops for. Fetch the unit's leasing matrix and return the cheapest
 * {price, term} within maxMonths — or null when the matrix has nothing usable.
 */
async function cheapestWithinTerm(
  u: SightmapUnit,
  maxMonths: number,
  ctx: AdapterContext,
): Promise<{ price: number; term: number } | null> {
  if (!u.leasing_price_url) return null;
  try {
    const text = await fetchText(u.leasing_price_url, ctx, "leasing matrix");
    const byTerm = extractTermPrices(JSON.parse(text));
    let bestEntry: { price: number; term: number } | null = null;
    for (const [term, price] of byTerm) {
      if (term > maxMonths) continue;
      if (!bestEntry || price < bestEntry.price) bestEntry = { price, term };
    }
    return bestEntry;
  } catch (err) {
    ctx.log(
      `leasing matrix for unit ${u.unit_number} unavailable (${err instanceof Error ? err.message : err})`,
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

    const maxMonths = ctx.maxLeaseTermMonths;

    // Capture mode: record one unit's leasing matrix even when nothing is
    // over the cap, so the matrix shape is on file for offline validation.
    if (ctx.record && maxMonths) {
      const sample = payload.data.units.find((u) => u.leasing_price_url);
      if (sample) await cheapestWithinTerm(sample, maxMonths, ctx);
    }

    const listings: UnitListing[] = [];
    for (const u of payload.data.units) {
      const plan = plans.get(u.floor_plan_id);
      if (!plan || !u.unit_number || !Number.isFinite(u.price) || u.price <= 0) continue;

      let price = u.price;
      let term = parseLeaseTermMonths(u.display_lease_term);
      if (maxMonths && term !== null && term > maxMonths) {
        // The teaser price needs a longer lease than the user shops for —
        // re-price from the unit's leasing calendar, capped at maxMonths.
        const capped = await cheapestWithinTerm(u, maxMonths, ctx);
        if (capped) {
          ctx.log(
            `unit ${u.unit_number}: advertised $${price} @ ${term}mo → quoting $${capped.price} @ ${capped.term}mo (cap ${maxMonths}mo)`,
          );
          price = capped.price;
          term = capped.term;
        } else {
          ctx.log(
            `unit ${u.unit_number}: advertised price needs a ${term}-month lease and no ≤${maxMonths}-month price found — skipping`,
          );
          continue;
        }
      }

      listings.push({
        unitNumber: u.unit_number,
        floorplanName: cleanPlanName(plan),
        beds: plan.bedroom_count,
        baths: plan.bathroom_count || null,
        sqft: u.area && u.area > 100 ? Math.round(u.area) : null,
        price,
        leaseTermMonths: term,
        availableDate: u.available_on ?? null,
        ...(u.specials_description ? { specials: u.specials_description } : {}),
        url: building.url,
      });
    }
    return dedupeListings(listings);
  },
};
