import * as cheerio from "cheerio";
import type { UnitListing } from "../../../shared/src/types";
import { dedupeListings } from "../normalize";
import type { Adapter } from "./types";

/**
 * Old Town Park (Onni) — server-rendered per-tower availability pages
 * (/availability-tower-N) with clean data attributes:
 *   .js-plan-group[data-plan-slug][data-cat] > .yard__unit[data-unit][data-rent-min][data-rent-max]
 * Each tower is its own building entry; adapterOptions.towerPath picks the page.
 */

function catToBeds(cat: string | undefined): number | null {
  if (!cat) return null;
  if (/conv|studio/i.test(cat)) return 0;
  const digit = /(\d)/.exec(cat);
  if (digit) return Number.parseInt(digit[1]!, 10);
  if (/one/i.test(cat)) return 1;
  if (/two/i.test(cat)) return 2;
  if (/three/i.test(cat)) return 3;
  return null;
}

export const oldtownpark: Adapter = {
  id: "oldtownpark",
  async scrape(building, ctx) {
    const towerPath =
      typeof building.adapterOptions?.["towerPath"] === "string"
        ? (building.adapterOptions["towerPath"] as string)
        : "availability-tower-1";
    const url = new URL(towerPath, building.url).href;
    const res = await ctx.fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const html = await res.text();
    ctx.record?.(url, html, "text/html");

    const $ = cheerio.load(html);
    const listings: UnitListing[] = [];

    $(".js-plan-group").each((_, group) => {
      const planSlug = $(group).attr("data-plan-slug");
      const groupCat = $(group).attr("data-cat");
      const floorplanName = planSlug ? planSlug.toUpperCase() : "?";

      $(group)
        .find("[data-unit]")
        .each((_, el) => {
          const unitNumber = $(el).attr("data-unit");
          const rentMin = Number.parseInt($(el).attr("data-rent-min") ?? "", 10);
          const rentMax = Number.parseInt($(el).attr("data-rent-max") ?? "", 10);
          const beds = catToBeds($(el).attr("data-cat") ?? groupCat);
          if (!unitNumber || !Number.isFinite(rentMin) || beds === null) return;

          const cardText = $(el).text().replace(/\s+/g, " ");
          const availM = /available\s*(now|[a-z]{3,9}\.?\s*\d{1,2}(?:,?\s*\d{4})?)/i.exec(cardText);
          const sqftM = /([\d,]{3,})\s*(?:sq\.?\s?ft|sf\b)/i.exec(cardText);

          listings.push({
            unitNumber,
            floorplanName,
            beds,
            baths: null,
            sqft: sqftM ? Number.parseInt(sqftM[1]!.replace(/,/g, ""), 10) : null,
            price: rentMin,
            ...(Number.isFinite(rentMax) && rentMax > rentMin ? { priceMax: rentMax } : {}),
            availableDate: availM ? availM[1]! : null,
            url,
          });
        });
    });

    if (listings.length === 0) {
      throw new Error(`no units parsed from ${url} — page structure may have changed`);
    }
    return dedupeListings(listings);
  },
};
