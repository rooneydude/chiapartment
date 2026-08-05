import * as cheerio from "cheerio";
import type { UnitListing } from "../../../shared/src/types";
import {
  coerceBeds,
  dedupeListings,
  MAX_SANE_RENT,
  MIN_SANE_RENT,
  parseHtmlListings,
} from "../normalize";
import type { Adapter, AdapterContext } from "./types";

/**
 * Stead 220 — custom front-end over RentCafe. /floorplans renders
 * .floorplan-card entries (name, meta, starting price, /floorplans/N link).
 * Floorplans are named "Unit 01".."Unit 13" — they are stacks, one plan per
 * riser. Per-plan pages may list actual available units; when they don't
 * (client-rendered), we record honest floorplan-level listings instead.
 */

async function fetchText(url: string, ctx: AdapterContext): Promise<string | null> {
  try {
    const res = await ctx.fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    ctx.record?.(url, text, "text/html");
    return text;
  } catch {
    return null;
  }
}

export const stead220: Adapter = {
  id: "stead220",
  async scrape(building, ctx) {
    const listUrl = new URL("/floorplans", building.url).href;
    const html = await fetchText(listUrl, ctx);
    if (!html) throw new Error(`failed to fetch ${listUrl}`);

    const $ = cheerio.load(html);
    const listings: UnitListing[] = [];

    interface PlanCard {
      floorplanName: string;
      beds: number;
      baths: number | null;
      price: number;
      available: boolean;
      href: string | null;
      /** Set when the "plan" is a single real unit (PH plans: "UNIT 2802"). */
      unitNumber: string | null;
      tag: string | null;
    }
    const cards: PlanCard[] = [];

    $(".floorplan-card").each((_, el) => {
      const name = $(el).find(".fp-card-name").first().text().trim(); // "STUDIO"
      const meta = $(el).find(".fp-card-meta").first().text().trim(); // "LARGE · UNIT 01 · 1 BATH"
      const priceText = $(el).find(".fp-card-price-amount").first().text();
      const price = Number.parseInt(priceText.replace(/[^0-9]/g, ""), 10);
      const beds = coerceBeds(name);
      if (!name || !Number.isFinite(price) || beds === null) return;
      // "$0" / placeholder pricing means unpriceable — skip the card.
      if (price < MIN_SANE_RENT || price > MAX_SANE_RENT) return;

      const bathsM = /(\d+(?:\.\d+)?)\s*BATH/i.exec(meta);
      const unitTagM = /UNIT\s*(\d+)/i.exec(meta);
      const aria = $(el).find("[aria-label]").first().attr("aria-label") ?? "";
      const ariaName = aria.replace(/\s*preview.*$/i, "").trim();
      const availLabel = $(el).find(".fp-availability-label").first().text().trim();

      const tag = unitTagM ? unitTagM[1]! : null;
      cards.push({
        floorplanName:
          ariaName || (tag ? `${name} - Unit ${tag}` : `${name} (${meta})`),
        beds,
        baths: bathsM ? Number.parseFloat(bathsM[1]!) : null,
        price,
        available: !/waitlist|unavailable/i.test(availLabel),
        href: $(el).find('a[href^="/floorplans/"]').first().attr("href") ?? null,
        // Stacks are tagged "UNIT 01".."UNIT 13"; a 3-4 digit tag ("UNIT 2802")
        // is a single physical unit (floor 28, stack 02).
        unitNumber: tag && /^\d{3,4}$/.test(tag) ? tag : null,
        tag,
      });
    });

    if (cards.length === 0) {
      throw new Error(`no floorplan cards parsed from ${listUrl} — page structure may have changed`);
    }

    // Other cards' tags must never be mistaken for unit rows on a plan page
    // (plan pages can echo sibling plan cards in related sections).
    const allTags = new Set(cards.map((c) => c.tag).filter((t): t is string => t !== null));

    // Try to resolve real units from each plan's page.
    for (const card of cards) {
      if (!card.available) continue;
      let units: UnitListing[] = [];
      if (card.href && card.unitNumber === null) {
        const planHtml = await fetchText(new URL(card.href, building.url).href, ctx);
        if (planHtml && planHtml !== html) {
          units = parseHtmlListings(planHtml)
            .filter(
              (u) =>
                u.unitNumber !== null &&
                /^\d{3,4}[A-Z]?$/i.test(u.unitNumber) &&
                !allTags.has(u.unitNumber),
            )
            .map((u) => ({
              ...u,
              floorplanName: card.floorplanName,
              beds: card.beds,
              baths: u.baths ?? card.baths,
            }));
        }
      }
      if (units.length > 0) {
        listings.push(...units);
      } else {
        listings.push({
          unitNumber: card.unitNumber,
          floorplanName: card.floorplanName,
          beds: card.beds,
          baths: card.baths,
          sqft: null,
          price: card.price,
          availableDate: null,
          ...(card.href ? { url: new URL(card.href, building.url).href } : {}),
        });
      }
    }

    return dedupeListings(listings);
  },
};
