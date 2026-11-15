import * as cheerio from "cheerio";
import { parseAvailableDate, parseLeaseTermMonths } from "../../../shared/src/parse";
import { chicagoDate } from "../../../shared/src/time";
import type { AlsoListed, LeaseTermPrice, UnitListing } from "../../../shared/src/types";
import { fetchRenderedHtml } from "../browser";
import { sleep } from "../http";
import { coerceBeds, coercePrice, dedupeListings, MAX_SANE_RENT, MIN_SANE_RENT } from "../normalize";
import { extractTermPrices } from "./sightmap";
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
 * from datacenter IPs is sometimes Imunify360-blocked, so live scrapes fall
 * back to Chromium; fixture mode reads the captured page directly.
 *
 * Per unit the blob gives: apartment_number, bedrooms (may be a label such as
 * "JR 1 Bedroom"), bathrooms, square_feet, rent_min/rent_max, available_date
 * (unix seconds, midnight Chicago) and available_display ("Available Now" /
 * "Available Aug 12"). `lease_terms` and `price_entity.term` exist in the
 * schema but this property leaves them empty — the site publishes one
 * "starting at" price and no lease lengths. They are read when present.
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

/** Unix seconds → the Chicago calendar day it falls on. */
function unixToChicagoDay(v: unknown): string | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\d{9,10}$/.test(v)
        ? Number.parseInt(v, 10)
        : NaN;
  if (!Number.isFinite(n) || n < 1e9) return null;
  return chicagoDate(new Date(n * 1000));
}

/** The plan key the history is charted under — stable house style. */
const planNameFor = (beds: number): string => (beds === 0 ? "Studio" : `${beds} BR`);

/**
 * The site's own unit-type label when it says more than the bed count:
 * "JR 1 Bedroom" (a junior one-bed that would otherwise pass for a full one).
 */
function planTypeFor(raw: Record<string, unknown>): string | undefined {
  const label = [raw["bedrooms_display"], raw["bedrooms"]].find(
    (v): v is string => typeof v === "string" && /[a-z]/i.test(v),
  );
  if (!label || /^\s*(studio|\d+\s*(bed|bedroom|br)s?)\s*$/i.test(label)) return undefined;
  return label.replace(/\s+/g, " ").trim();
}

function leaseTermsFrom(raw: Record<string, unknown>): LeaseTermPrice[] {
  const terms = raw["lease_terms"];
  if (!Array.isArray(terms) || terms.length === 0) return [];
  return [...extractTermPrices(terms).entries()]
    .map(([months, price]) => ({ months, price }))
    .sort((a, b) => a.months - b.months);
}

function specialsFrom(raw: Record<string, unknown>): string | undefined {
  const specials = raw["specials"];
  if (!Array.isArray(specials)) return undefined;
  const texts = specials
    .map((s) => {
      if (typeof s === "string") return s;
      if (s && typeof s === "object") {
        const o = s as Record<string, unknown>;
        return [o["title"], o["description"], o["text"]].find((v) => typeof v === "string") as
          | string
          | undefined;
      }
      return undefined;
    })
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  return texts.length > 0 ? texts.join(" · ").slice(0, 300) : undefined;
}

type JdResult = { listing: UnitListing } | { alsoListed: AlsoListed } | null;

function fromJdUnit(raw: Record<string, unknown>, baseUrl: string, ref: Date): JdResult {
  const beds = coerceBeds(raw["bedrooms"] ?? raw["bedrooms_display"]);
  const entity = raw["price_entity"] as
    | { priceLow?: unknown; priceHigh?: unknown; term?: unknown; termDisplay?: unknown }
    | undefined;
  const price =
    coercePrice(raw["rent_min"]) ?? coercePrice(entity?.priceLow) ?? coercePrice(raw["price"]);

  const apt = raw["apartment_number"];
  const title = typeof raw["title"] === "string" ? raw["title"].replace(/^#/, "").trim() : "";
  const unitNumber =
    typeof apt === "string" && /^\d{3,4}[A-Z]?$/i.test(apt.trim())
      ? apt.trim()
      : /^\d{3,4}[A-Z]?$/i.test(title)
        ? title
        : null;

  const baths = coerceFinite(raw["bathrooms"]);
  const sqftRaw = coerceFinite(raw["square_feet"]);
  const sqft = sqftRaw !== null && sqftRaw >= 150 ? Math.round(sqftRaw) : null;

  const display = typeof raw["available_display"] === "string" ? raw["available_display"] : null;
  const today = chicagoDate(ref);
  // The blob's date is when the unit became (or becomes) available. For a
  // unit the site calls "Available Now" that is a day in the past: the
  // earliest move-in is today, and the past day is how long it has sat empty.
  const siteDate = unixToChicagoDay(raw["available_date"]) ?? parseAvailableDate(display, ref);
  const saysNow = /\bnow\b/i.test(display ?? "");
  const availableNow: boolean | undefined = saysNow
    ? true
    : siteDate !== null
      ? siteDate <= today
      : undefined;
  const availableDate = availableNow === true ? today : siteDate;
  const vacantSince =
    availableNow === true && siteDate !== null && siteDate < today ? siteDate : undefined;

  const permalink = raw["permalink"];
  const href =
    typeof permalink === "string"
      ? permalink
      : unitNumber
        ? `/floorplans/${unitNumber}/`
        : null;
  const url = href ? new URL(href, baseUrl).href : undefined;

  const priced = price !== null && price >= MIN_SANE_RENT && price <= MAX_SANE_RENT;
  if (beds === null || !priced) {
    // Listed on the site but not comparable — say so instead of dropping it.
    if (unitNumber === null && title === "") return null;
    return {
      alsoListed: {
        unitNumber,
        floorplanName: beds === null ? title || "Unit" : planNameFor(beds),
        beds,
        baths,
        sqft,
        ...(priced ? { price: Math.round(price!) } : {}),
        availableDate,
        ...(availableNow !== undefined ? { availableNow } : {}),
        note: priced ? "Bed count not published" : "No price published",
        ...(url ? { url } : {}),
      },
    };
  }

  const rentMax = coercePrice(raw["rent_max"]) ?? coercePrice(entity?.priceHigh);
  const term =
    typeof entity?.term === "number" && Number.isInteger(entity.term) && entity.term > 0
      ? entity.term
      : parseLeaseTermMonths(typeof entity?.termDisplay === "string" ? entity.termDisplay : null);
  const leaseTerms = leaseTermsFrom(raw);
  const specials = specialsFrom(raw);
  const planType = planTypeFor(raw);

  return {
    listing: {
      unitNumber,
      floorplanName: planNameFor(beds),
      beds,
      ...(planType ? { planType } : {}),
      baths,
      sqft,
      price: Math.round(price!),
      ...(rentMax !== null && rentMax > price! && rentMax <= MAX_SANE_RENT
        ? { priceMax: Math.round(rentMax) }
        : {}),
      ...(term !== null ? { leaseTermMonths: term } : {}),
      ...(leaseTerms.length > 0 ? { leaseTerms } : {}),
      availableDate,
      ...(availableNow !== undefined ? { availableNow } : {}),
      ...(vacantSince ? { vacantSince } : {}),
      ...(specials ? { specials } : {}),
      ...(url ? { url } : {}),
    },
  };
}

export interface LeoPage {
  listings: UnitListing[];
  alsoListed: AlsoListed[];
  /**
   * The page carried the inventory blob with a `units` array — so an empty
   * list means "nothing available", not "we were served something else".
   */
  sawInventory: boolean;
}

/** Parse the Jonah Digital `#jd-fp-data-script-app` JSON blob. */
export function parseLeoInventory(html: string, baseUrl: string, ref: Date = new Date()): LeoPage {
  const empty: LeoPage = { listings: [], alsoListed: [], sawInventory: false };
  const $ = cheerio.load(html);
  const raw = $(`script#${DATA_SCRIPT_ID}`).first().text();
  if (!raw.trim()) return empty;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof data !== "object" || data === null) return empty;
  const units = (data as { units?: unknown }).units;
  if (!Array.isArray(units)) return empty;
  const listings: UnitListing[] = [];
  const alsoListed: AlsoListed[] = [];
  for (const u of units) {
    if (typeof u !== "object" || u === null) continue;
    const r = fromJdUnit(u as Record<string, unknown>, baseUrl, ref);
    if (!r) continue;
    if ("listing" in r) listings.push(r.listing);
    else alsoListed.push(r.alsoListed);
  }
  return { listings: dedupeListings(listings), alsoListed, sawInventory: true };
}

/** Back-compat wrapper: just the priced listings from the JSON blob. */
export function parseLeoEmbeddedData(html: string, baseUrl: string): UnitListing[] {
  return parseLeoInventory(html, baseUrl).listings;
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

/** Full parse: JSON blob first, card markup as a fallback. */
function parsePage(html: string, baseUrl: string, ref: Date): LeoPage {
  const page = parseLeoInventory(html, baseUrl, ref);
  if (page.listings.length > 0 || page.sawInventory) return page;
  return { listings: parseLeoCards(html, baseUrl), alsoListed: [], sawInventory: false };
}

export const leo: Adapter = {
  id: "leo",
  async scrape(building, ctx) {
    const url = new URL("floorplans", building.url).href;
    const ref = ctx.now?.() ?? new Date();
    const finish = (page: LeoPage): UnitListing[] => {
      for (const row of page.alsoListed) ctx.reportAlsoListed?.(row);
      if (page.listings.length === 0) {
        ctx.log("inventory blob present with no priced units — the building lists nothing right now");
      }
      return page.listings;
    };

    // Plain fetch first: hits fixtures offline, and works live whenever the
    // WAF lets a datacenter IP through.
    try {
      const res = await ctx.fetch(url);
      if (res.ok) {
        const html = await res.text();
        ctx.record?.(url, html, "text/html");
        if (!isWafPage(html)) {
          const page = parsePage(html, building.url, ref);
          // A real page with the inventory blob is authoritative even when it
          // is empty: a small building with nothing to rent is not an error.
          if (page.listings.length > 0 || page.sawInventory) return finish(page);
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
        const page = parsePage(html, building.url, ref);
        if (page.listings.length > 0 || page.sawInventory) return finish(page);
        ctx.log(`attempt ${attempt}: no floorplan data in rendered page${attempt < attempts ? "; retrying" : ""}`);
      }
      if (attempt < attempts) await sleep(3_000 * attempt);
    }
    throw new Error(`no floorplan cards parsed from ${url} — page structure may have changed or WAF blocked the browser`);
  },
};
