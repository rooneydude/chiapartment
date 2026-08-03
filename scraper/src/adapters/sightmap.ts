import type { BuildingConfig, UnitListing } from "../../../shared/src/types";
import { dedupeListings } from "../normalize";
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

    const listings: UnitListing[] = [];
    for (const u of payload.data.units) {
      const plan = plans.get(u.floor_plan_id);
      if (!plan || !u.unit_number || !Number.isFinite(u.price) || u.price <= 0) continue;
      listings.push({
        unitNumber: u.unit_number,
        floorplanName: cleanPlanName(plan),
        beds: plan.bedroom_count,
        baths: plan.bathroom_count || null,
        sqft: u.area && u.area > 100 ? Math.round(u.area) : null,
        price: u.price,
        availableDate: u.available_on ?? null,
        ...(u.specials_description ? { specials: u.specials_description } : {}),
        url: building.url,
      });
    }
    return dedupeListings(listings);
  },
};
