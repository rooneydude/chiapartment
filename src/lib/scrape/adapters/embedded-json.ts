import { extractJsonBlobs } from "../json-blobs";
import { clean, planKey as toPlanKey } from "../parse";
import { harvestPlans, harvestUnits } from "../shape";
import type { Adapter, ScrapeResult, ScrapedPlan, ScrapedUnit } from "../types";

/**
 * Reads availability straight out of the JSON the page already embeds.
 *
 * This is the highest-value adapter for bespoke luxury-building sites, which
 * are overwhelmingly Next.js/Nuxt front-ends over a headless CMS: the entire
 * availability table is sitting in the flight data or a `__NEXT_DATA__` blob,
 * fully typed, before any DOM scraping is needed.
 */
export const embeddedJsonAdapter: Adapter = {
  id: "embedded-json",
  platform: "embedded",

  detect({ html }) {
    let score = 0;
    if (/__NEXT_DATA__|self\.__next_f\.push/.test(html)) score += 0.35;
    if (/window\.__(NUXT|APOLLO_STATE|INITIAL_STATE|PRELOADED_STATE)__/.test(html)) {
      score += 0.35;
    }
    if (/<script[^>]+type=["']application\/json["']/i.test(html)) score += 0.2;
    if (!score) return 0;

    // Only claim the page if the JSON actually contains units — otherwise a
    // Next.js marketing page with no availability would outrank the adapter
    // that can really parse it.
    const blobs = extractJsonBlobs(html);
    const units = blobs.flatMap((b) => harvestUnits(b));
    if (units.length === 0) return Math.min(score, 0.2);
    return Math.min(0.95, 0.5 + Math.min(units.length, 20) / 40);
  },

  async scrape(ctx): Promise<ScrapeResult> {
    const warnings: string[] = [];
    const blobs = extractJsonBlobs(ctx.html);
    ctx.log(`found ${blobs.length} embedded JSON blob(s)`);

    const units = new Map<string, ScrapedUnit>();
    const plans = new Map<string, ScrapedPlan>();

    for (const blob of blobs) {
      for (const u of harvestUnits(blob, { baseUrl: ctx.url })) {
        if (!units.has(u.unitCode)) units.set(u.unitCode, u);
      }
      for (const p of harvestPlans(blob, { baseUrl: ctx.url })) {
        const key = toPlanKey(p.key);
        if (!plans.has(key)) plans.set(key, { ...p, key });
      }
    }

    // Point each unit's planKey at a harvested plan when the names line up.
    const byName = new Map<string, string>();
    for (const p of plans.values()) byName.set(toPlanKey(p.name), p.key);
    for (const u of units.values()) {
      if (!u.planKey) continue;
      const k = toPlanKey(u.planKey);
      u.planKey = plans.has(k) ? k : byName.get(k) ?? k;
    }

    if (units.size === 0) {
      warnings.push(
        "Embedded JSON was present but contained no unit-shaped records. " +
          "The site probably loads availability over XHR — capture that request and add an adapter.",
      );
    }

    return {
      adapter: this.id,
      platform: this.platform,
      building: readBuildingInfo(ctx.html, blobs),
      units: [...units.values()],
      plans: [...plans.values()],
      warnings,
    };
  },
};

/** Building name/address from JSON-LD, falling back to the <title>. */
export function readBuildingInfo(html: string, blobs: unknown[]) {
  for (const blob of blobs) {
    const found = findPostalAddress(blob);
    if (found) return found;
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return { name: title ? clean(title).split(/\s*[|–—-]\s*/)[0] : undefined };
}

function findPostalAddress(
  node: unknown,
  depth = 0,
): { name?: string; address?: string; lat?: number; lng?: number } | null {
  if (depth > 8 || !node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = findPostalAddress(c, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const o = node as Record<string, unknown>;
  const type = String(o["@type"] ?? "");
  if (/ApartmentComplex|Residence|Apartment|LocalBusiness|Place|Organization/i.test(type)) {
    const addr = o.address as Record<string, unknown> | undefined;
    const geo = o.geo as Record<string, unknown> | undefined;
    const street = addr ? clean(String(addr.streetAddress ?? "")) : "";
    const city = addr ? clean(String(addr.addressLocality ?? "")) : "";
    const region = addr ? clean(String(addr.addressRegion ?? "")) : "";
    const parts = [street, city, region].filter(Boolean);
    return {
      name: o.name ? clean(String(o.name)) : undefined,
      address: parts.length ? parts.join(", ") : undefined,
      lat: geo && Number.isFinite(Number(geo.latitude)) ? Number(geo.latitude) : undefined,
      lng: geo && Number.isFinite(Number(geo.longitude)) ? Number(geo.longitude) : undefined,
    };
  }
  for (const v of Object.values(o)) {
    const hit = findPostalAddress(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}
