import { clean } from "../parse";
import { harvestPlans, harvestUnits } from "../shape";
import type { Adapter, ScrapeResult, ScrapedPlan, ScrapedUnit } from "../types";

/**
 * AppFolio listing portals.
 *
 * AppFolio serves each customer at `<account>.appfolio.com/listings` and backs
 * the page with a JSON feed at the same path plus `.json`. Smaller Chicago
 * operators use it heavily; large towers rarely do, but it costs almost
 * nothing to support and it is the one platform with a genuinely stable
 * public feed.
 */
export const appFolioAdapter: Adapter = {
  id: "appfolio",
  platform: "appfolio",

  detect({ html, url }) {
    let score = 0;
    if (/appfolio\.com/i.test(url)) score += 0.5;
    if (/appfolio\.com|appfolio-listings|AppFolio/i.test(html)) score += 0.4;
    return Math.min(score, 0.95);
  },

  async scrape(ctx): Promise<ScrapeResult> {
    const warnings: string[] = [];
    const units = new Map<string, ScrapedUnit>();
    const plans = new Map<string, ScrapedPlan>();

    for (const url of feedUrls(ctx.url, ctx.html)) {
      try {
        const data = await ctx.getJson(url);
        ctx.log(`AppFolio feed ${url}`);
        for (const u of harvestUnits(data, { baseUrl: ctx.url })) {
          if (!units.has(u.unitCode)) units.set(u.unitCode, u);
        }
        for (const p of harvestPlans(data, { baseUrl: ctx.url })) {
          if (!plans.has(p.key)) plans.set(p.key, p);
        }
        if (units.size) break;
      } catch (err) {
        warnings.push(`AppFolio feed ${url}: ${(err as Error).message}`);
      }
    }

    if (units.size === 0) {
      warnings.push("AppFolio detected but no listings came back from the JSON feed.");
    }

    return {
      adapter: this.id,
      platform: this.platform,
      building: { name: clean(ctx.$("title").first().text()).split(/\s*[|–—-]\s*/)[0] || undefined },
      units: [...units.values()],
      plans: [...plans.values()],
      warnings,
    };
  },
};

function feedUrls(pageUrl: string, html: string): string[] {
  const out = new Set<string>();
  try {
    const u = new URL(pageUrl);
    const path = u.pathname.replace(/\/$/, "");
    out.add(`${u.origin}${path || "/listings"}.json`);
    out.add(`${u.origin}/listings.json`);
  } catch {
    /* ignore */
  }
  // Many sites embed the portal in an iframe pointing at the real account host.
  const iframe = html.match(/https?:\/\/[\w-]+\.appfolio\.com\/[\w/-]*listings/i);
  if (iframe) out.add(`${iframe[0].replace(/\/$/, "")}.json`);
  return [...out];
}
