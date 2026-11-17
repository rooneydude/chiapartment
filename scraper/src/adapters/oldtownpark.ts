import * as cheerio from "cheerio";
import { parseAvailableDate } from "../../../shared/src/parse";
import { chicagoDate } from "../../../shared/src/time";
import type { AlsoListed, UnitListing } from "../../../shared/src/types";
import { dedupeListings, MAX_SANE_RENT, MIN_SANE_RENT, spacedText } from "../normalize";
import { clipNotice, throwIfRefused } from "./guard";
import type { Adapter } from "./types";

/**
 * Old Town Park (Onni) — server-rendered per-tower availability pages
 * (/availability-tower-N):
 *
 *   <body class="… page-availability-tower-2 …">
 *   .js-plan-group[data-plan-slug][data-cat]            <p class="feature">Jr. 2 Bed</p>
 *     .yard__unit[data-unit][data-cat][data-rent-min][data-rent-max]
 *       .yard__unit__col--1   <strong class="large">#2111</strong>
 *                             <div class="align-r"><strong class="large">$3,359 - $3,514</strong></div>
 *                             <span class="label">Available</span> | <span class="label">12/18/2026</span>
 *                             (an empty right-hand cell where a promo tag could go)
 *       .yard__unit__col--2   "Total SQFT: 1,070  Indoor: 976  Outdoor: 94"
 *       .yard__unit__col--3   <a href="https://oldtownpark.securecafe.com/…UnitID=…">Apply Now | Inquire</a>
 *
 * Each tower is its own building entry; adapterOptions.towerPath picks the page.
 *
 * Rules this parser keeps (each has bitten, or would):
 *   - The rent is read from the PRICE ELEMENT only — never from "any dollar
 *     amount in the row": a promo tag ("$1,000 Rent Credit") is not a rent.
 *   - A price element that prints words ("Contact for Pricing", "Call for
 *     Details") means no published price, whatever number the row's hidden
 *     data attributes carry (the penthouse row hides 23599 there).
 *   - The move-in date is the label that reads as a date or "Available";
 *     other labels (promo tags) are not dates.
 *   - Every unit row on the page must be accounted for. Rows the parser
 *     cannot read are an error ("the page changed"), not a shorter list, and
 *     "fully leased" is believed only when the page has no unit rows at all.
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
 * Nothing here can tell which is real; the runner looks twice and the
 * pipeline compares a flipped unit with its own last price in the same form.
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

/** Bed count from a category slug or a printed type label; null when it names none. */
function bedsFrom(text: string | undefined): number | null {
  if (!text) return null;
  const key = text.trim().toLowerCase();
  if (!key) return null;
  if (key in BEDS_BY_CAT) return BEDS_BY_CAT[key]!;
  // Another spelling of a known kind ("Convertible", "Jr. 2 Bed", "2 Bed + Flex").
  if (/penthouse|townhome|town home/i.test(key)) return null;
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

/** A number written in an attribute ("4096", "4,096", "4096.50"); NaN when it is not one. */
function attrNumber(attr: string | undefined): number {
  const cleaned = (attr ?? "").replace(/[$,\s]/g, "");
  return /^\d+(\.\d+)?$/.test(cleaned) ? Number.parseFloat(cleaned) : Number.NaN;
}

function parseCount(text: string, label: RegExp): number | null {
  const m = label.exec(text);
  if (!m) return null;
  const n = Number.parseInt(m[1]!.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/** Dollar amounts printed in a piece of text, as whole dollars. */
function dollarAmounts(text: string): number[] {
  return [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)]
    .map((m) => Math.round(Number.parseFloat(m[1]!.replace(/,/g, ""))))
    .filter((n) => Number.isFinite(n));
}

/** How far a printed price may differ from the row's own data before neither is believed. */
const MAX_PRICE_DISAGREEMENT = 2;

export interface OldTownParkPage {
  listings: UnitListing[];
  alsoListed: AlsoListed[];
  notices: string[];
  /** The availability container exists — with no unit rows that means "fully leased". */
  structureOk: boolean;
  /** Unit rows on the page; listings + alsoListed account for every one of them. */
  rowCount: number;
  /** Unit rows that could not be read at all (no unit number) — a changed page. */
  unreadableRows: number;
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
  let unreadableRows = 0;
  const text = (el: object | undefined): string => (el ? spacedText($, el) : "");

  // Every unit row on the page, wherever it sits — a row outside a plan
  // group, or without its data attribute, must not simply go unnoticed.
  const rows = $(".yard__unit, [data-unit]").toArray();
  for (const el of rows) {
    const col1 = $(el).find(".yard__unit__col--1").first();
    const head = col1.length ? col1 : $(el);
    const headText = text(head[0]);
    const cardText = text(el);

    const unitNumber =
      $(el).attr("data-unit")?.trim() || /#\s*([A-Za-z0-9][A-Za-z0-9-]{1,7})\b/.exec(headText)?.[1] || "";
    rowCount++;
    if (!unitNumber) {
      unreadableRows++;
      continue;
    }

    const group = $(el).closest(".js-plan-group");
    const planSlug = group.attr("data-plan-slug");
    const typeLabel = text(group.find(".feature").first()[0]);
    const floorplanName = planSlug ? planSlug.toUpperCase() : typeLabel || "Unit";
    // The category attribute first; the printed type label when it is
    // missing or unknown.
    const beds =
      bedsFrom($(el).attr("data-cat")) ?? bedsFrom(group.attr("data-cat")) ?? bedsFrom(typeLabel);
    const planType = planTypeFor(typeLabel, beds);

    // MOVE-IN: the label that reads as a date or "Available" — a promo tag
    // in a label is not a date. Failing that, a date printed in the header.
    let availableDate: string | null = null;
    for (const label of head.find(".label").toArray()) {
      availableDate = parseAvailableDate(text(label), ref);
      if (availableDate !== null) break;
    }
    if (availableDate === null && head.find(".label").length === 0) {
      const fallback =
        /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.exec(headText)?.[0] ??
        // "Available", "Available Now", "Available Dec 26" — never "Unavailable" / "Not available".
        /(?<!un)(?<!not )\bavailable\b(?:\s+(?:now|[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?))?/i.exec(
          headText,
        )?.[0] ??
        null;
      availableDate = parseAvailableDate(fallback, ref);
    }
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

    // PRICE — from the price element only: the emphasised text of the
    // right-aligned header cell, else the first emphasised header text that
    // is not the unit number. Struck-through (was) prices are not the price.
    const emphasised = head.find("strong, b").toArray();
    const priceEl =
      head.find(".align-r strong, .align-r b").first()[0] ??
      emphasised.find((s) => !/^#/.test(text(s))) ??
      undefined;
    let priceText: string | null = null;
    if (priceEl) {
      const clone = $(priceEl).clone();
      clone.find("s, del, strike").remove();
      priceText = text(clone[0]);
    }
    const attrMin = attrNumber($(el).attr("data-rent-min"));
    const attrMax = attrNumber($(el).attr("data-rent-max"));

    let price: number | null = null;
    let priceMax: number | undefined;
    /** Why there is no price, in the site's own words where it has any. */
    let noPriceNote = "No price published";
    if (priceText !== null) {
      const printed = dollarAmounts(priceText).filter((n) => n >= MIN_SANE_RENT);
      if (printed.length > 0) {
        price = Math.min(...printed);
        const top = Math.max(...printed);
        if (top > price) priceMax = top;
        if (Number.isFinite(attrMin) && attrMin >= MIN_SANE_RENT && Math.round(attrMin) !== price) {
          const ratio = price / attrMin;
          if (ratio > MAX_PRICE_DISAGREEMENT || ratio < 1 / MAX_PRICE_DISAGREEMENT) {
            // Wildly different: something else is printed where the rent
            // should be. Neither number is published as this unit's rent.
            remarks.push(
              `unit ${unitNumber}: the price slot prints $${price} but the row's own data says $${Math.round(attrMin)} — too far apart to trust either; listed without a price`,
            );
            noPriceNote = `Price unclear on the site ($${price.toLocaleString("en-US")} printed, $${Math.round(attrMin).toLocaleString("en-US")} in its data)`;
            price = null;
            priceMax = undefined;
          } else {
            remarks.push(
              `unit ${unitNumber}: page prints $${price} but its data attribute says $${Math.round(attrMin)} — using the printed price`,
            );
          }
        }
      } else if (priceText) {
        // The price slot prints words: the site is not quoting this unit.
        noPriceNote = priceText.slice(0, 60);
      }
    } else if (Number.isFinite(attrMin) && attrMin >= MIN_SANE_RENT && attrMin <= MAX_SANE_RENT) {
      // Markup with no price element at all: the data attributes are all there is.
      price = Math.round(attrMin);
      if (Number.isFinite(attrMax) && attrMax > attrMin && attrMax <= MAX_SANE_RENT) {
        priceMax = Math.round(attrMax);
      }
    }

    if (price === null || beds === null) {
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
      continue;
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
  }

  // Site-wide promo pop-up ("Limited-Time Specials — up to a $1,000 Rent Credit").
  const notices: string[] = [];
  $(".popup--promo .content").each((_, el) => {
    const parts = $(el)
      .find("h1,h2,h3,h4,p")
      .toArray()
      .map((h) => text(h))
      // Phone-number buttons are not part of the offer.
      .filter((t) => t.length > 0 && !/^[\d\s().+-]+$/.test(t));
    const notice = clipNotice(parts.join(" — "));
    if (notice && !notices.includes(notice)) notices.push(notice);
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
    unreadableRows,
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
    const html = await res.text();
    const page = parseOldTownParkPage(html, url, ctx.now?.() ?? new Date());
    if (page.rowCount === 0) throwIfRefused(url, res.status, res.headers.get("content-type"), html);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    ctx.record?.(url, html, "text/html");

    if (page.pageTower !== null && page.pageTower !== towerPath) {
      throw new Error(`${url} served the page for ${page.pageTower}, not ${towerPath}`);
    }
    if (page.rowCount === 0 && !page.structureOk) {
      // No unit rows AND no availability container: the page changed (or we
      // were served something else). A tower with the container but no rows
      // is fully leased OR the site's feed is down — the runner tells those
      // apart by looking at the other towers of the same run.
      throw new Error(`no units parsed from ${url} — page structure may have changed`);
    }
    if (page.unreadableRows > 0) {
      throw new Error(
        `${url}: ${page.unreadableRows} of ${page.rowCount} unit rows carry no unit number — page structure may have changed`,
      );
    }
    // Real rows, yet not one with a bed category or type: the page changed.
    // (A lone penthouse row without a bed count is ordinary.)
    if (page.listings.length === 0 && page.alsoListed.length >= 3 && page.alsoListed.every((a) => a.beds === null)) {
      throw new Error(
        `${url}: none of its ${page.rowCount} unit rows names a unit type — page structure may have changed`,
      );
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
