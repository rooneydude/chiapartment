import type { UnitListing } from "../../../shared/src/types";
import { dedupeListings, findUnitListings, parseHtmlListings } from "../normalize";
import type { Adapter, AdapterContext } from "./types";

/**
 * Generic adapter for server-rendered or JSON-friendly leasing sites:
 *  1. If the entry URL (or adapterOptions.endpoint) returns JSON → normalize.
 *  2. JSON-LD blocks in the HTML.
 *  3. JSON endpoints discovered in the page source (availability/floorplan APIs).
 *  4. Availability-ish pages linked from the entry page (one level deep).
 *  5. Raw DOM heuristics.
 */

function looksLikeJson(body: string): boolean {
  const t = body.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

export function fromJsonLd(html: string): UnitListing[] {
  const out: UnitListing[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      out.push(...findUnitListings(JSON.parse(m[1]!)));
    } catch {
      // malformed JSON-LD — skip
    }
  }
  return out;
}

const ENDPOINT_HINT = /avail|floor-?plan|units|pricing|sightmap|api\//i;
const PAGE_HINT = /avail|floor-?plan|residence|apartments/i;

/** Quoted URLs in page source that look like data endpoints. */
export function discoverUrls(html: string, baseUrl: string): { json: string[]; pages: string[] } {
  const json = new Set<string>();
  const pages = new Set<string>();
  for (const m of html.matchAll(/["']([^"'\s<>{}]{4,300})["']/g)) {
    const raw = m[1]!;
    if (!/^(https?:\/\/|\/)/.test(raw)) continue;
    let resolved: string;
    try {
      resolved = new URL(raw, baseUrl).href;
    } catch {
      continue;
    }
    if (/\.(css|js|png|jpe?g|webp|svg|gif|woff2?|ico|mp4)(\?|$)/i.test(resolved)) continue;
    if (ENDPOINT_HINT.test(resolved) && (/\.json(\?|$)/i.test(resolved) || /api\//i.test(resolved))) {
      json.add(resolved);
    } else if (PAGE_HINT.test(resolved) && new URL(resolved).host === new URL(baseUrl).host) {
      pages.add(resolved);
    }
  }
  return { json: [...json], pages: [...pages] };
}

async function harvest(url: string, ctx: AdapterContext): Promise<{ listings: UnitListing[]; html: string | null }> {
  const res = await ctx.fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ct = res.headers.get("content-type") ?? "";
  const body = await res.text();
  ctx.record?.(url, body, ct || (looksLikeJson(body) ? "application/json" : "text/html"));

  if (ct.includes("json") || looksLikeJson(body)) {
    try {
      return { listings: findUnitListings(JSON.parse(body)), html: null };
    } catch {
      // fall through to HTML handling
    }
  }
  return { listings: fromJsonLd(body), html: body };
}

export const generic: Adapter = {
  id: "generic",
  async scrape(building, ctx) {
    const endpoint = building.adapterOptions?.["endpoint"];
    const entry =
      typeof endpoint === "string" ? new URL(endpoint, building.url).href : building.url;

    const collected: UnitListing[] = [];
    const { listings, html } = await harvest(entry, ctx);
    collected.push(...listings);

    if (collected.length === 0 && html) {
      const { json, pages } = discoverUrls(html, entry);
      for (const u of json.slice(0, 6)) {
        try {
          const r = await harvest(u, ctx);
          collected.push(...r.listings);
          if (collected.length > 0) break;
        } catch (err) {
          ctx.log(`endpoint ${u} failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      // One level of availability-ish page crawling.
      if (collected.length === 0) {
        for (const u of pages.slice(0, 3)) {
          try {
            const r = await harvest(u, ctx);
            collected.push(...r.listings);
            if (collected.length === 0 && r.html) collected.push(...parseHtmlListings(r.html));
            if (collected.length > 0) break;
          } catch (err) {
            ctx.log(`page ${u} failed: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      if (collected.length === 0) collected.push(...parseHtmlListings(html));
    }

    return dedupeListings(collected);
  },
};
