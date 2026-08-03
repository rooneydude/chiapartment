import * as cheerio from "cheerio";
import type { UnitListing } from "../../../shared/src/types";
import { fetchRenderedHtml } from "../browser";
import { coerceBeds, dedupeListings } from "../normalize";
import type { Adapter } from "./types";

/**
 * The Leo — /floorplans renders unit-level cards
 * (a[data-jd-fp-selector="floorplan-item"]): title = unit number, info spans
 * = beds/baths/sqft, price in [data-jd-fp-adp="display"]. Plain HTTP from
 * datacenter IPs is Imunify360-blocked, so live scrapes go through Chromium;
 * fixture mode reads the captured page directly.
 */

const CARD_SELECTOR = 'a[data-jd-fp-selector="floorplan-item"]';

export function parseLeoCards(html: string, baseUrl: string): UnitListing[] {
  const $ = cheerio.load(html);
  const out: UnitListing[] = [];

  $(CARD_SELECTOR).each((_, el) => {
    const title = $(el).find(".jd-fp-card-info__title").first().text().trim();
    const info = $(el).find("p.jd-fp-card-info__text").first().text().replace(/\s+/g, " ");
    const priceText = $(el).find('[data-jd-fp-adp="display"]').first().text();
    const price = Number.parseInt(priceText.replace(/[^0-9]/g, ""), 10);
    const beds = coerceBeds(/studio/i.test(info) ? "studio" : /(\d+)\s*bed/i.exec(info)?.[1]);
    if (!Number.isFinite(price) || price < 500 || beds === null) return;

    const bathsM = /(\d+(?:\.\d+)?)\s*bath/i.exec(info);
    const sqftM = /([\d,]{3,})\s*sq/i.exec(info);
    const href = $(el).attr("href");

    out.push({
      unitNumber: /^\d{3,4}$/.test(title) ? title : null,
      floorplanName: beds === 0 ? "Studio" : `${beds} BR`,
      beds,
      baths: bathsM ? Number.parseFloat(bathsM[1]!) : null,
      sqft: sqftM ? Number.parseInt(sqftM[1]!.replace(/,/g, ""), 10) : null,
      price,
      availableDate: null,
      ...(href ? { url: new URL(href, baseUrl).href } : {}),
    });
  });

  return dedupeListings(out);
}

export const leo: Adapter = {
  id: "leo",
  async scrape(building, ctx) {
    const url = new URL("floorplans", building.url).href;

    // Plain fetch first: hits fixtures offline, and would work live if the
    // WAF ever relaxes.
    try {
      const res = await ctx.fetch(url);
      if (res.ok) {
        const html = await res.text();
        ctx.record?.(url, html, "text/html");
        const listings = parseLeoCards(html, building.url);
        if (listings.length > 0) return listings;
      }
    } catch (err) {
      ctx.log(`plain fetch failed (${err instanceof Error ? err.message : err}); rendering`);
    }

    const html = await fetchRenderedHtml(url, ctx);
    const listings = parseLeoCards(html, building.url);
    if (listings.length === 0) {
      throw new Error(`no floorplan cards parsed from ${url} — page structure may have changed`);
    }
    return listings;
  },
};
