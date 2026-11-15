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
 *   <body class="… page-availability-tower-2 …">
 *   .js-plan-group[data-plan-slug][data-cat]            <p class="feature">Jr. 2 Bed</p>
 *     .yard__unit[data-unit][data-cat][data-rent-min][data-rent-max]
 *       .yard__unit__col--1   "#2111"  "$3,359 - $3,514"
 *                             <span class="label">Available</span> | <span class="label">12/18/2026</span>
 *       .yard__unit__col--2   "Total SQFT: 1,070  Indoor: 976  Outdoor: 94"
 *       .yard__unit__col--3   <a href="https://oldtownpark.securecafe.com/…UnitID=…">Apply Now | Inquire</a>
 *
 * Each tower is its own building entry; adapterOptions.towerPath picks the page.
 *
 * What the site does NOT publish: lease lengths. Each unit only has a rent
 * RANGE (the cheapest and dearest option in its leasing-portal price table);
 * the term-by-term prices live behind each row's portal link, which sits
 * behind a bot challenge we do not go around — so every listing carries that
 * link and the dashboard sends the user there. Bed counts for penthouse and
 * townhome plans and all bath counts are not published either.
 *
 * Known site quirk: for a handful of plans the pages alternate between two
 * pricing states (a range one minute, a different single price the next).
 * Nothing here can tell which is real; the pipeline treats a range ↔ single
 * flip as "not comparable" rather than as a price move.
 */

/** data-cat → bedrooms. Categories absent here publish no bed count. */
const BEDS_BY_CAT: Record<string, number> = {
  convertible: 0,
  studio: 0,
  "1-br": 1,
  "1-bed-flex": 1,
  "jr-2-bed": 2,
  "2-br": 2,
  "2-bed-flex": 2,
  "3-br": 3,
  "3-bed": 3,
  "4-br": 4,
  "4-bed": 4,
};

function catToBeds(cat: string | undefined): number | null {
  if (!cat) return null;
  const key = cat.trim().toLowerCase();
  if (key in BEDS_BY_CAT) return BEDS_BY_CAT[key]!;
  // Unknown spelling of a known kind ("Convertible", "2 Bed"): still usable.
  if (/penthouse|townhome/i.test(key)) return null;
  if (/conv|studio/i.test(key)) return 0;
  const digit = /(\d)/.exec(key);
  return digit ? Number.parseInt(digit[1]!, 10) : null;
}

/** "1 Bed" says nothing the bed count does not; "Jr. 2 Bed" does. */
function planTypeFor(label: string, beds: number | null): string | undefined {
  if (!label) return undefined;
  if (beds !== null && beds > 0 && /^\d\s*bed(room)?s?$/i.test(label)) return undefined;
  return label;
}

/**
 * What the price slot says when the site will not quote ("Contact for
 * Pricing"). Matched against the price slot only — the action buttons say
 * "Inquire" / "Email for pricing" on perfectly priced units too.
 */
const NO_PRICE_TEXT = /contact for pricing|call for pricing|pricing (?:available )?upon request/i;

const digits = (attr: string | undefined): number => {
  const cleaned = (attr ?? "").replace(/[^0-9]/g, "");
  return cleaned ? Number.parseInt(cleaned, 10) : Number.NaN;
};

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
  /** Unit rows on the page; listings + alsoListed should account for them all. */
  rowCount: number;
  /** "availability-tower-2" from the body class, when the page declares one. */
  pageTower: string | null;
  /** Things worth a log line (price mismatches, duplicate rows). */
  remarks: string[];
}

export function parseOldTownParkPage(html: string, pageUrl: string, ref: Date): OldTownParkPage {
  const $ = cheerio.load(html);
  const today = chicagoDate(ref);
  const listings: UnitListing[] = [];
  const alsoListed: AlsoListed[] = [];
  const remarks: string[] = [];
  let rowCount = 0;

  $(".js-plan-group").each((_, group) => {
    const planSlug = $(group).attr("data-plan-slug");
    const groupCat = $(group).attr("data-cat");
    const floorplanName = planSlug ? planSlug.toUpperCase() : "?";
    const typeLabel = $(group).find(".feature").first().text().replace(/\s+/g, " ").trim();

    $(group)
      .find("[data-unit]")
      .each((_, el) => {
        const unitNumber = $(el).attr("data-unit");
        if (!unitNumber) return;
        rowCount++;
        const attrMin = digits($(el).attr("data-rent-min"));
        const attrMax = digits($(el).attr("data-rent-max"));
        const beds = catToBeds($(el).attr("data-cat") ?? groupCat);
        const planType = planTypeFor(typeLabel, beds);
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

        // PRICE. The printed slot (the header column) is what a visitor
        // sees, so it wins; the data attributes are the fallback for markup
        // without one. "Contact for Pricing" means no price, whatever the
        // attribute carries (the penthouse row hides a number there).
        const priceSlot = headText.trim() ? headText : cardText;
        const printed = [...priceSlot.matchAll(/\$\s?([\d,]{3,})/g)]
          .map((m) => Number.parseInt(m[1]!.replace(/,/g, ""), 10))
          .filter((n) => Number.isFinite(n) && n >= MIN_SANE_RENT);
        const refused = NO_PRICE_TEXT.test(priceSlot);
        let price: number | null = null;
        let priceMax: number | undefined;
        if (!refused && printed.length > 0) {
          price = Math.min(...printed);
          const top = Math.max(...printed);
          if (top > price) priceMax = top;
          if (Number.isFinite(attrMin) && attrMin !== price) {
            remarks.push(
              `unit ${unitNumber}: page prints $${price} but its data attribute says $${attrMin} — using the printed price`,
            );
          }
        } else if (
          !refused &&
          Number.isFinite(attrMin) &&
          attrMin >= MIN_SANE_RENT &&
          attrMin <= MAX_SANE_RENT
        ) {
          price = attrMin;
          if (Number.isFinite(attrMax) && attrMax > attrMin && attrMax <= MAX_SANE_RENT) {
            priceMax = attrMax;
          }
        }

        if (price === null || beds === null) {
          const noPriceNote = NO_PRICE_TEXT.exec(priceSlot)?.[0] ?? "No price published";
          alsoListed.push({
            unitNumber,
            floorplanName,
            beds,
            sqft,
            ...(outdoorSqft !== undefined ? { outdoorSqft } : {}),
            ...(price !== null ? { price } : {}),
            ...(priceMax !== undefined ? { priceMax } : {}),
            availableDate,
            ...(availableNow !== undefined ? { availableNow } : {}),
            note:
              price === null
                ? `${typeLabel ? `${typeLabel} — ` : ""}${noPriceNote.replace(/^./, (c) => c.toUpperCase())}`
                : `${typeLabel || "Plan"} — bed count not published`,
            url,
          });
          return;
        }

        listings.push({
          unitNumber,
          floorplanName,
          beds,
          ...(planType ? { planType } : {}),
          baths: null,
          sqft,
          ...(outdoorSqft !== undefined ? { outdoorSqft } : {}),
          price,
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
      .find("h1,h2,h3,h4,p")
      .toArray()
      .map((h) => $(h).text().replace(/\s+/g, " ").trim())
      // Phone-number buttons are not part of the offer.
      .filter((t) => t.length > 0 && !/^[\d\s().+-]+$/.test(t));
    const text = parts.join(" — ");
    if (text && text.length <= 300 && !notices.includes(text)) notices.push(text);
  });

  const deduped = dedupeListings(listings);
  if (deduped.length !== listings.length) {
    remarks.push(
      `${listings.length - deduped.length} duplicate unit row(s) on the page — kept the first of each`,
    );
  }
  const pageTower = /\bpage-(availability-tower-\d+)\b/.exec($("body").attr("class") ?? "")?.[1] ?? null;

  return {
    listings: deduped,
    alsoListed,
    notices,
    structureOk: $(".yard__availability").length > 0,
    rowCount,
    pageTower,
    remarks,
  };
}

export const oldtownpark: Adapter = {
  id: "oldtownpark",
  async scrape(building, ctx) {
    const towerPath = building.adapterOptions?.["towerPath"];
    if (typeof towerPath !== "string" || !/^availability-tower-\d+$/.test(towerPath)) {
      // No silent default: tower 1's units must never be filed under another building.
      throw new Error(
        `buildings.json: ${building.id} needs adapterOptions.towerPath like "availability-tower-2"`,
      );
    }
    const url = new URL(towerPath, building.url).href;
    const res = await ctx.fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const html = await res.text();
    ctx.record?.(url, html, "text/html");

    const page = parseOldTownParkPage(html, url, ctx.now?.() ?? new Date());
    if (page.pageTower !== null && page.pageTower !== towerPath) {
      throw new Error(`${url} served the page for ${page.pageTower}, not ${towerPath}`);
    }
    if (page.listings.length === 0 && page.alsoListed.length === 0 && !page.structureOk) {
      // No unit rows AND no availability container: the page changed (or we
      // were served something else). A tower with the container but no rows
      // is fully leased OR the site's feed is down — the runner tells those
      // apart by looking at the other towers of the same run.
      throw new Error(`no units parsed from ${url} — page structure may have changed`);
    }
    for (const row of page.alsoListed) ctx.reportAlsoListed?.(row);
    for (const notice of page.notices) ctx.reportNotice?.(notice);
    for (const remark of page.remarks) ctx.log(remark);
    const accounted = page.listings.length + page.alsoListed.length;
    const dated = page.listings.filter((l) => l.availableDate !== null).length;
    ctx.log(
      `${page.rowCount} rows on the page → ${page.listings.length} units (${dated} with a move-in date), ${page.alsoListed.length} also listed${
        accounted !== page.rowCount ? ` — ${page.rowCount - accounted} NOT accounted for` : ""
      }`,
    );
    return page.listings;
  },
};
