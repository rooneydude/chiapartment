import { clean, planKey as toPlanKey } from "../parse";
import { harvestPlans, harvestUnits } from "../shape";
import type { Adapter, ScrapeResult, ScrapedPlan, ScrapedUnit } from "../types";

/**
 * Yardi RENTCafé.
 *
 * RENTCafé-backed sites expose availability through `rentcafeapi.aspx`, keyed
 * by a numeric property id that the page embeds (in an iframe src, a data
 * attribute, or an inline config object). Hitting the API directly is both
 * more reliable than scraping their widget markup and much lighter on the
 * building's site — one request instead of a rendered page.
 */
export const rentCafeAdapter: Adapter = {
  id: "rentcafe",
  platform: "rentcafe",

  detect({ html }) {
    let score = 0;
    if (/rentcafe\.com|securecafe\.com|RENTCafe/i.test(html)) score += 0.5;
    if (/rentcafeapi\.aspx/i.test(html)) score += 0.3;
    if (findPropertyId(html)) score += 0.2;
    return Math.min(score, 0.95);
  },

  async scrape(ctx): Promise<ScrapeResult> {
    const warnings: string[] = [];
    const propertyId = findPropertyId(ctx.html);
    const units = new Map<string, ScrapedUnit>();
    const plans = new Map<string, ScrapedPlan>();

    if (!propertyId) {
      warnings.push(
        "Detected RENTCafé but could not find the propertyId in the page. " +
          "Find it in the availability iframe's URL and pass it with --property-id.",
      );
    } else {
      ctx.log(`RENTCafé propertyId=${propertyId}`);
      const base = "https://www.rentcafe.com/rentcafeapi.aspx";
      const requests: Array<[string, string]> = [
        ["apartmentavailability", `${base}?requestType=apartmentavailability&propertyId=${propertyId}`],
        ["floorplan", `${base}?requestType=floorplan&propertyId=${propertyId}`],
      ];

      for (const [kind, url] of requests) {
        try {
          const data = await ctx.getJson(url);
          for (const u of harvestUnits(data, { baseUrl: ctx.url })) {
            if (!units.has(u.unitCode)) units.set(u.unitCode, u);
          }
          for (const p of harvestPlans(data, { baseUrl: ctx.url })) {
            const key = toPlanKey(p.key);
            const prior = plans.get(key);
            if (!prior || (!prior.imageUrl && p.imageUrl)) {
              plans.set(key, { ...prior, ...p, key });
            }
          }
        } catch (err) {
          warnings.push(`RENTCafé ${kind} request failed: ${(err as Error).message}`);
        }
      }
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

/** The property id turns up in several places; take the first plausible one. */
function findPropertyId(html: string): string | null {
  const patterns = [
    /propertyId["'\s:=]+(\d{4,8})/i,
    /PropertyID=(\d{4,8})/i,
    /data-property-id=["'](\d{4,8})["']/i,
    /rentcafeapi\.aspx[^"']*propertyId=(\d{4,8})/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}
