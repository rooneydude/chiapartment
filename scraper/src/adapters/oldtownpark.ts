import * as cheerio from "cheerio";
import { parseAvailableDate } from "../../../shared/src/parse";
import { chicagoDate } from "../../../shared/src/time";
import type { AlsoListed, UnitListing } from "../../../shared/src/types";
import { dedupeListings, MAX_SANE_RENT, MIN_SANE_RENT } from "../normalize";
import type { Adapter } from "./types";

/**
 * Old Town Park (Onni) — server-rendered per-tower availability pages
 * (/availability-tower-N):
 *
 *   .js-plan-group[data-plan-slug][data-cat]
 *     .yard__unit[data-unit][data-cat][data-rent-min][data-rent-max]
 *       <span class="label">Available</span>  or  <span class="label">12/18/2026</span>
 *       "Total SQFT: 1,070  Indoor: 976  Outdoor: 94"
 *       <a href="https://oldtownpark.securecafe.com/...UnitID=...">Apply Now</a>
 *
 * Each tower is its own building entry; adapterOptions.towerPath picks the page.
 *
 * Lease terms: the site prints a rent RANGE per unit and nothing else. The
 * term-by-term prices live in the leasing portal behind each "Apply Now"
 * link, which sits behind a bot challenge we do not go around — so each
 * listing carries that link and the dashboard sends the user there.
 */

function catToBeds(cat: string | undefined): number | null {
  if (!cat) return null;
  if (/conv|studio/i.test(cat)) return 0;
  const digit = /(\d)/.exec(cat);
  if (digit) return Number.parseInt(digit[1]!, 10);
  if (/one/i.test(cat)) return 1;
  if (/two/i.test(cat)) return 2;
  if (/three/i.test(cat)) return 3;
  return null; // penthouse / townhomes: the site publishes no bed count
}

/**
 * What the price slot says when the site will not quote ("Contact for
 * Pricing"). Matched against the price slot only — the action buttons say
 * "Inquire" / "Email for pricing" on perfectly priced units too.
 */
const NO_PRICE_TEXT = /contact for pricing|call for pricing|pricing (?:available )?upon request/i;

function parseCount(text: string, label: RegExp): number | null {
  const m = label.exec(text);
  if (!m) return null;
  const n = Number.parseInt(m[1]!.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

export interface OldTownParkPage {
  listings: UnitListing[];
  alsoListed: AlsoListed[];
  notices: string[];
  /** The availability container exists — an empty list means "fully leased". */
  structureOk: boolean;
}

export function parseOldTownParkPage(html: string, pageUrl: string, ref: Date): OldTownParkPage {
  const $ = cheerio.load(html);
  const today = chicagoDate(ref);
  const listings: UnitListing[] = [];
  const alsoListed: AlsoListed[] = [];

  $(".js-plan-group").each((_, group) => {
    const planSlug = $(group).attr("data-plan-slug");
    const groupCat = $(group).attr("data-cat");
    const floorplanName = planSlug ? planSlug.toUpperCase() : "?";
    const planType = $(group).find(".feature").first().text().replace(/\s+/g, " ").trim();

    $(group)
      .find("[data-unit]")
      .each((_, el) => {
        const unitNumber = $(el).attr("data-unit");
        if (!unitNumber) return;
        const rentMin = Number.parseInt($(el).attr("data-rent-min") ?? "", 10);
        const rentMax = Number.parseInt($(el).attr("data-rent-max") ?? "", 10);
        const beds = catToBeds($(el).attr("data-cat") ?? groupCat);
        const cardText = $(el).text().replace(/\s+/g, " ").trim();

        // Move-in: the label is either "Available" (now) or a M/D/YYYY date.
        // Fall back to the card's header column, never the whole card (its
        // square-footage numbers would be mistaken for dates).
        const labelText = $(el).find(".label").first().text().replace(/\s+/g, " ").trim();
        const headText = $(el).find(".yard__unit__col--1").first().text().replace(/\s+/g, " ");
        const fallback =
          /\d{1,2}\/\d{1,2}\/\d{2,4}/.exec(headText)?.[0] ??
          /available(?:\s+(?:now|[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?))?/i.exec(
            headText || cardText,
          )?.[0] ??
          null;
        const availableDate = parseAvailableDate(labelText || fallback, ref);
        const availableNow = availableDate !== null ? availableDate <= today : undefined;

        // Interior area is what other buildings quote; terraces are separate.
        const total =
          parseCount(cardText, /Total\s*SQFT:?\s*([\d,]{3,})/i) ??
          parseCount(cardText, /([\d,]{3,})\s*(?:sq\.?\s?ft|sf\b)/i);
        const indoor = parseCount(cardText, /Indoor:?\s*([\d,]{3,})/i);
        const outdoor = parseCount(cardText, /Outdoor:?\s*([\d,]+)/i);
        const interior = indoor ?? total;
        const sqft = interior !== null && interior >= 150 && interior <= 12000 ? interior : null;
        const outdoorSqft = outdoor !== null && outdoor > 0 && outdoor <= 6000 ? outdoor : undefined;

        const applyHref = $(el).find('a[href*="securecafe.com"]').first().attr("href");
        const url = applyHref && /^https:\/\//.test(applyHref) ? applyHref : pageUrl;

        // The printed price slot is the header column; when the column is
        // missing (minimal markup) fall back to the whole card.
        const priceSlot = headText.trim() ? headText : cardText;
        const priced =
          Number.isFinite(rentMin) &&
          rentMin >= MIN_SANE_RENT &&
          rentMin <= MAX_SANE_RENT &&
          !NO_PRICE_TEXT.test(priceSlot);
        const priceMax =
          priced && Number.isFinite(rentMax) && rentMax > rentMin && rentMax <= MAX_SANE_RENT
            ? rentMax
            : undefined;

        if (!priced || beds === null) {
          const noPriceNote = NO_PRICE_TEXT.exec(priceSlot)?.[0] ?? "No price published";
          alsoListed.push({
            unitNumber,
            floorplanName,
            beds,
            sqft,
            ...(outdoorSqft !== undefined ? { outdoorSqft } : {}),
            ...(priced ? { price: rentMin } : {}),
            ...(priceMax !== undefined ? { priceMax } : {}),
            availableDate,
            ...(availableNow !== undefined ? { availableNow } : {}),
            note: !priced
              ? `${planType ? `${planType} — ` : ""}${noPriceNote.replace(/^./, (c) => c.toUpperCase())}`
              : `${planType || "Plan"} — bed count not published`,
            url,
          });
          return;
        }

        listings.push({
          unitNumber,
          floorplanName,
          beds,
          baths: null,
          sqft,
          ...(outdoorSqft !== undefined ? { outdoorSqft } : {}),
          price: rentMin,
          ...(priceMax !== undefined ? { priceMax } : {}),
          availableDate,
          ...(availableNow !== undefined ? { availableNow } : {}),
          url,
        });
      });
  });

  // Site-wide promo pop-up ("Limited-Time Specials — up to a $1,000 Rent Credit").
  const notices: string[] = [];
  $(".popup--promo .content").each((_, el) => {
    const parts = $(el)
      .find("h1,h2,h3,h4")
      .toArray()
      .map((h) => $(h).text().replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0);
    const text = parts.join(" — ");
    if (text && text.length <= 300 && !notices.includes(text)) notices.push(text);
  });

  return {
    listings: dedupeListings(listings),
    alsoListed,
    notices,
    structureOk: $(".yard__availability").length > 0,
  };
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

    const page = parseOldTownParkPage(html, url, ctx.now?.() ?? new Date());
    if (page.listings.length === 0 && page.alsoListed.length === 0 && !page.structureOk) {
      // No unit rows AND no availability container: the page changed (or we
      // were served something else). A tower with the container but no rows
      // is simply fully leased — that is a legitimate empty result.
      throw new Error(`no units parsed from ${url} — page structure may have changed`);
    }
    for (const row of page.alsoListed) ctx.reportAlsoListed?.(row);
    for (const notice of page.notices) ctx.reportNotice?.(notice);
    const dated = page.listings.filter((l) => l.availableDate !== null).length;
    ctx.log(
      `${page.listings.length} units (${dated} with a move-in date), ${page.alsoListed.length} also listed`,
    );
    return page.listings;
  },
};
