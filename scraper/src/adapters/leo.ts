import * as cheerio from "cheerio";
import { parseAvailableDate } from "../../../shared/src/parse";
import type { UnitListing } from "../../../shared/src/types";
import { fetchRenderedHtml } from "../browser";
import { sleep } from "../http";
import { coerceBeds, coercePrice, dedupeListings, MAX_SANE_RENT, MIN_SANE_RENT } from "../normalize";
import type { Adapter } from "./types";

function coerceFinite(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The Leo — /floorplans is a Jonah Digital widget. The real inventory lives in
 * <script id="jd-fp-data-script-app" type="application/json"> (SSR'd). Card
 * markup (a[data-jd-fp-selector="floorplan-item"]) is a fallback. Plain HTTP
 * from datacenter IPs is Imunify360-blocked, so live scrapes go through
 * Chromium; fixture mode reads the captured page directly.
 */

const CARD_SELECTOR = 'a[data-jd-fp-selector="floorplan-item"]';
const DATA_SCRIPT_ID = "jd-fp-data-script-app";
const READY_SELECTOR = `#${DATA_SCRIPT_ID}, ${CARD_SELECTOR}`;

export function isWafPage(body: string): boolean {
  const t = body.trimStart();
  if (/imunify360|access denied by .+bot-protection/i.test(body)) return true;
  if (t.startsWith("{") && /access denied/i.test(body) && body.length < 2000) return true;
  return false;
}

function unixToIsoDate(v: unknown): string | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\d{10}$/.test(v)
        ? Number.parseInt(v, 10)
        : NaN;
  if (!Number.isFinite(n) || n < 1e9) return null;
  const iso = new Date(n * 1000).toISOString().slice(0, 10);
  return iso === "1970-01-01" ? null : iso;
}

function listingFromJdUnit(raw: Record<string, unknown>, baseUrl: string): UnitListing | null {
  const beds = coerceBeds(raw["bedrooms"] ?? raw["bedrooms_display"]);
  const price =
    coercePrice(raw["rent_min"]) ??
    coercePrice((raw["price_entity"] as { priceLow?: unknown } | undefined)?.priceLow) ??
    coercePrice(raw["price"]);
  if (beds === null || price === null || price < MIN_SANE_RENT || price > MAX_SANE_RENT) return null;

  const apt = raw["apartment_number"];
  const title = typeof raw["title"] === "string" ? raw["title"].replace(/^#/, "").trim() : "";
  const unitNumber =
    typeof apt === "string" && /^\d{3,4}$/.test(apt)
      ? apt
      : /^\d{3,4}$/.test(title)
        ? title
        : null;

  const baths = coerceFinite(raw["bathrooms"]);
  const sqft = coerceFinite(raw["square_feet"]);

  const availableDate =
    unixToIsoDate(raw["available_date"]) ??
    parseAvailableDate(typeof raw["available_display"] === "string" ? raw["available_display"] : null, new Date());

  const permalink = raw["permalink"];
  const href =
    typeof permalink === "string"
      ? permalink
      : unitNumber
        ? `/floorplans/${unitNumber}/`
        : null;

  return {
    unitNumber,
    floorplanName: beds === 0 ? "Studio" : `${beds} BR`,
    beds,
    baths,
    sqft: sqft !== null && sqft >= 150 ? Math.round(sqft) : null,
    price,
    availableDate,
    ...(href ? { url: new URL(href, baseUrl).href } : {}),
  };
}

/** Parse the Jonah Digital `#jd-fp-data-script-app` JSON blob. */
export function parseLeoEmbeddedData(html: string, baseUrl: string): UnitListing[] {
  const $ = cheerio.load(html);
  const raw = $(`script#${DATA_SCRIPT_ID}`).first().text();
  if (!raw.trim()) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null) return [];
  const units = (data as { units?: unknown }).units;
  if (!Array.isArray(units)) return [];
  const out: UnitListing[] = [];
  for (const u of units) {
    if (typeof u !== "object" || u === null) continue;
    const listing = listingFromJdUnit(u as Record<string, unknown>, baseUrl);
    if (listing) out.push(listing);
  }
  return dedupeListings(out);
}

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

export function parseLeoPage(html: string, baseUrl: string): UnitListing[] {
  const fromJson = parseLeoEmbeddedData(html, baseUrl);
  if (fromJson.length > 0) return fromJson;
  return parseLeoCards(html, baseUrl);
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
        if (!isWafPage(html)) {
          const listings = parseLeoPage(html, building.url);
          if (listings.length > 0) return listings;
        } else {
          ctx.log("plain fetch hit Imunify360 WAF; rendering");
        }
      }
    } catch (err) {
      ctx.log(`plain fetch failed (${err instanceof Error ? err.message : err}); rendering`);
    }

    // Rendered fetch: the first attempt occasionally lands on a WAF
    // interstitial. JSON is SSR'd so we wait for the data script, not
    // networkidle (HubSpot/GTM never go idle).
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const html = await fetchRenderedHtml(url, ctx, {
        waitForSelector: READY_SELECTOR,
        selectorTimeoutMs: 30_000,
        waitUntil: "domcontentloaded",
      });
      if (isWafPage(html)) {
        ctx.log(`attempt ${attempt}: WAF interstitial instead of floorplans${attempt < attempts ? "; retrying" : ""}`);
      } else {
        const listings = parseLeoPage(html, building.url);
        if (listings.length > 0) return listings;
        ctx.log(`attempt ${attempt}: no floorplan data in rendered page${attempt < attempts ? "; retrying" : ""}`);
      }
      if (attempt < attempts) await sleep(3_000 * attempt);
    }
    throw new Error(`no floorplan cards parsed from ${url} — page structure may have changed or WAF blocked the browser`);
  },
};
