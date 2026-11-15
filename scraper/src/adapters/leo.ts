import * as cheerio from "cheerio";
import { parseAvailableDate, parseLeaseTermMonths } from "../../../shared/src/parse";
import { chicagoDate } from "../../../shared/src/time";
import type { AlsoListed, LeaseTermPrice, UnitListing } from "../../../shared/src/types";
import { coerceBeds, coercePrice, dedupeListings, MAX_SANE_RENT, MIN_SANE_RENT } from "../normalize";
import { extractTermPrices, parseMarketingPage } from "./sightmap";
import { SiteBlockedError, type Adapter } from "./types";

/**
 * The Leo — https://leochicago.com/floorplans/ is a Jonah Digital widget.
 *
 * Source of truth: the RAW page's <script id="jd-fp-data-script-app"
 * type="application/json">, one entry per available apartment. (The site's
 * own script deletes that node once it has read it, so a rendered DOM never
 * contains it — only the raw HTML does.) Per unit it gives apartment_number,
 * bedrooms (a number, "Studio", or a label such as "JR 1 Bedroom"),
 * bathrooms, square_feet, rent_min / rent_max ("Starting at …"),
 * available_date (unix seconds, midnight Chicago) and available_display
 * ("Available Now" / "Available Aug 12").
 *
 * Read from the same page, at no extra request:
 *   - the bedroom-filter labels each unit is filed under (Studio / Jr 1
 *     Bedroom / 1 Bedroom + Den / 1 Bedroom / 2 Bedroom) — the site's own
 *     unit types;
 *   - the JSON-LD catalogue of every apartment in the building (bedroom count
 *     per plan, how many are available): it classifies non-numeric bedroom
 *     labels the way the site does (a "JR 1 Bedroom" is 0 bedrooms there) and
 *     confirms that an empty list really means "nothing available";
 *   - the building-wide special and the "prices may include concessions" line.
 *
 * Not published by this site: lease lengths. `lease_terms` is always empty
 * and every price is one flat "starting at" rent. They are read if they ever
 * appear.
 *
 * The site's bot protection (Imunify360) sometimes refuses datacenter
 * addresses. That is recorded as a blocked scrape and left alone: no browser
 * workaround and no hammering — the next scheduled run simply asks again.
 */

const DATA_SCRIPT_ID = "jd-fp-data-script-app";
const CARD_SELECTOR = 'a[data-jd-fp-selector="floorplan-item"]';
const CHALLENGE =
  /imunify360|bot-protection|access denied|just a moment|one moment, please|verif(y|ying) you are (a )?human|captcha|attention required/i;
/** A real page is ~300 KB; challenge and refusal pages are a few KB at most. */
const SMALL_BODY = 20_000;

/**
 * Is this body a bot-protection / challenge page instead of the site? Never
 * true for a page that carries the inventory, whatever else it mentions.
 */
export function isWafPage(body: string, status = 200): boolean {
  if (body.includes(DATA_SCRIPT_ID)) return false;
  const refused = status === 401 || status === 403 || status === 429;
  return (refused || body.length < SMALL_BODY) && CHALLENGE.test(body);
}

function coerceFinite(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Unix seconds → the Chicago calendar day it falls on (sane years only). */
function unixToChicagoDay(v: unknown): string | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\d{9,10}$/.test(v.trim())
        ? Number.parseInt(v, 10)
        : Number.NaN;
  // 2001-09-09 … 2100: anything else is not a seconds timestamp.
  if (!Number.isFinite(n) || n < 1e9 || n > 4.1e9) return null;
  return chicagoDate(new Date(n * 1000));
}

/** "Studio", "1 bed", "2 Bedroom" — a label that says nothing beyond the count. */
function plainBeds(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v <= 6 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^studio$/i.test(s)) return 0;
  const m = /^(\d)\s*(?:bed(?:room)?s?|br)?$/i.exec(s);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return n <= 6 ? n : null;
}

/** The plan key the history is charted under for ordinary unit types. */
const planNameFor = (beds: number): string => (beds === 0 ? "Studio" : `${beds} BR`);

const tidy = (s: string): string => s.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Page-level context: catalogue, filter labels, notices
// ---------------------------------------------------------------------------

interface CataloguePlan {
  beds: number | null;
  available: number | null;
}

/** The JSON-LD list of every apartment in the building, keyed by plan name. */
function parseCatalogue(html: string): Map<string, CataloguePlan> {
  const out = new Map<string, CataloguePlan>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const plans = obj["accommodationFloorPlan"];
    if (Array.isArray(plans)) {
      for (const p of plans) {
        if (p === null || typeof p !== "object") continue;
        const rec = p as Record<string, unknown>;
        const name = typeof rec["name"] === "string" ? rec["name"].trim() : "";
        if (!name) continue;
        const beds = rec["numberOfBedrooms"];
        const avail = rec["numberOfAvailableAccommodationUnits"];
        out.set(name, {
          beds: typeof beds === "number" && Number.isInteger(beds) && beds >= 0 && beds <= 6 ? beds : null,
          available: typeof avail === "number" && Number.isFinite(avail) && avail >= 0 ? avail : null,
        });
      }
    }
    for (const [k, v] of Object.entries(obj)) if (k !== "accommodationFloorPlan") visit(v);
  };
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse(m[1]!));
    } catch {
      // a malformed JSON-LD block is not our problem
    }
  }
  return out;
}

/** Bedroom-filter id → the label the site prints for it ("12" → "Jr 1 Bedroom"). */
function parseFilterLabels($: cheerio.CheerioAPI): Map<string, string> {
  const out = new Map<string, string>();
  $('label[for^="floorplan-filter-arbitrary_1-"]').each((_, el) => {
    const id = /-(\d+)$/.exec($(el).attr("for") ?? "")?.[1];
    const text = tidy($(el).text());
    if (id && text && text.length <= 40) out.set(id, text);
  });
  return out;
}

/** The page's visible text: no scripts, styles or templates. */
function visibleText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, template").remove();
  return tidy($("body").text());
}

/** The sentence in which the site warns that listed prices include concessions. */
function concessionDisclaimer(html: string): string | null {
  const m = /[^.!?]*\bmay include concessions\b[^.!?]*[.!?]/i.exec(visibleText(html));
  if (!m) return null;
  // Keep only the sentence itself, not the paragraph that ran into it.
  const sentence = tidy(m[0]).replace(/^.*?\b(Prices?\b)/i, "$1");
  return sentence.length <= 220 ? sentence : null;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

interface PageContext {
  catalogue: Map<string, CataloguePlan>;
  filterLabels: Map<string, string>;
}

function unitIdentity(raw: Record<string, unknown>): { unitNumber: string | null; title: string } {
  const clean = (v: unknown): string | null => {
    if (typeof v !== "string" && typeof v !== "number") return null;
    const s = String(v).replace(/^#/, "").trim();
    // Any unit name the site prints is kept ("705", "PH1", "705A").
    return /^[A-Za-z0-9][A-Za-z0-9 .-]{0,11}$/.test(s) ? s : null;
  };
  const title = typeof raw["title"] === "string" ? raw["title"].replace(/^#/, "").trim() : "";
  return { unitNumber: clean(raw["apartment_number"]) ?? clean(title), title };
}

/**
 * The unit type as the site files it. Returns null when it says nothing
 * beyond the bed count ("Studio", "1 Bedroom").
 */
function unitTypeLabel(raw: Record<string, unknown>, ctx: PageContext): string | null {
  const links = raw["arbitrary_filter_links"];
  const first = Array.isArray(links) ? links[0] : undefined;
  const filed =
    typeof first === "number" || typeof first === "string"
      ? ctx.filterLabels.get(String(first))
      : undefined;
  const own = [raw["bedrooms"], raw["bedrooms_display"]].find(
    (v): v is string => typeof v === "string" && /[a-z]/i.test(v),
  );
  for (const label of [filed, own]) {
    if (label && plainBeds(label) === null) return tidy(label);
  }
  return null;
}

function bedsFor(raw: Record<string, unknown>, planKey: string | null, ctx: PageContext): number | null {
  const primary = raw["bedrooms"] || raw["bedrooms_display"];
  const plain = plainBeds(primary);
  if (plain !== null) return plain;
  // A label such as "JR 1 Bedroom": the site's own structured data says how
  // many bedrooms that plan has (0 for the junior one-beds).
  const catalogued = planKey ? ctx.catalogue.get(planKey)?.beds : null;
  if (catalogued !== null && catalogued !== undefined) return catalogued;
  return plainBeds(raw["bedrooms_display"]) ?? coerceBeds(primary);
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
    .map((t) => tidy(t.replace(/<[^>]+>/g, " ")));
  return texts.length > 0 ? texts.join(" · ").slice(0, 300) : undefined;
}

type JdResult = { listing: UnitListing } | { alsoListed: AlsoListed } | null;

function fromJdUnit(
  raw: Record<string, unknown>,
  baseUrl: string,
  ref: Date,
  ctx: PageContext,
): JdResult {
  const { unitNumber, title } = unitIdentity(raw);
  const planTitle = typeof raw["floorplan_title"] === "string" ? raw["floorplan_title"].trim() : "";
  const beds = bedsFor(raw, planTitle || unitNumber, ctx);
  const typeLabel = unitTypeLabel(raw, ctx);

  const entity = raw["price_entity"] as
    | { priceLow?: unknown; priceHigh?: unknown; term?: unknown; termDisplay?: unknown }
    | undefined;
  const price =
    coercePrice(raw["rent_min"]) ?? coercePrice(entity?.priceLow) ?? coercePrice(raw["price"]);

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
    typeof permalink === "string" && permalink.trim()
      ? permalink
      : planTitle || unitNumber
        ? `/floorplans/${encodeURIComponent(planTitle || unitNumber!)}/`
        : null;
  const url = href ? new URL(href, baseUrl).href : undefined;

  // The history is charted per plan name. Ordinary types keep the house
  // style ("Studio", "1 BR"); a type that is its own product — a junior
  // one-bed, a one-bed with a den — is charted under the site's name for it,
  // so it cannot drag another type's line around.
  const planName = (b: number): string => typeLabel ?? planNameFor(b);

  const priced = price !== null && price >= MIN_SANE_RENT && price <= MAX_SANE_RENT;
  if (beds === null || !priced) {
    // Listed on the site but not comparable — say so instead of dropping it.
    if (unitNumber === null && title === "") return null;
    const priceText = [raw["price_display"], raw["price"]].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0 && !/\d/.test(v),
    );
    return {
      alsoListed: {
        unitNumber,
        floorplanName: beds === null ? (typeLabel ?? (title || "Unit")) : planName(beds),
        beds,
        baths,
        sqft,
        ...(priced ? { price: Math.round(price!) } : {}),
        availableDate,
        ...(availableNow !== undefined ? { availableNow } : {}),
        note: priced
          ? "Bed count not published"
          : priceText
            ? tidy(priceText).slice(0, 60)
            : "No price published",
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

  return {
    listing: {
      unitNumber,
      floorplanName: planName(beds),
      beds,
      ...(typeLabel ? { planType: typeLabel } : {}),
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
  /** Entries in the blob's `units` array, before any classification. */
  unitCount: number;
  /** Building-wide special and the concession disclaimer, as printed. */
  notices: string[];
  /** Apartments in the page's own catalogue (0 when it carries none). */
  catalogueSize: number;
  /** How many of those the catalogue marks available; null without a catalogue. */
  catalogueAvailable: number | null;
}

function pageContext(html: string, $: cheerio.CheerioAPI): PageContext {
  return { catalogue: parseCatalogue(html), filterLabels: parseFilterLabels($) };
}

function pageNotices(html: string): string[] {
  const notices = [...parseMarketingPage(html).notices];
  const disclaimer = concessionDisclaimer(html);
  if (disclaimer && !notices.includes(disclaimer)) notices.push(disclaimer);
  return notices;
}

function catalogueSummary(catalogue: Map<string, CataloguePlan>): {
  catalogueSize: number;
  catalogueAvailable: number | null;
} {
  const counted = [...catalogue.values()].filter((p) => p.available !== null);
  return {
    catalogueSize: catalogue.size,
    catalogueAvailable:
      counted.length > 0 ? counted.reduce((s, p) => s + (p.available ?? 0), 0) : null,
  };
}

/** Parse the Jonah Digital `#jd-fp-data-script-app` JSON blob. */
export function parseLeoInventory(html: string, baseUrl: string, ref: Date = new Date()): LeoPage {
  const $ = cheerio.load(html);
  const ctx = pageContext(html, $);
  const base: LeoPage = {
    listings: [],
    alsoListed: [],
    sawInventory: false,
    unitCount: 0,
    notices: [],
    ...catalogueSummary(ctx.catalogue),
  };
  const raw = $(`script#${DATA_SCRIPT_ID}`).first().text();
  if (!raw.trim()) return base;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return base;
  }
  if (typeof data !== "object" || data === null) return base;
  const units = (data as { units?: unknown }).units;
  if (!Array.isArray(units)) return base;
  const listings: UnitListing[] = [];
  const alsoListed: AlsoListed[] = [];
  for (const u of units) {
    if (typeof u !== "object" || u === null) continue;
    const r = fromJdUnit(u as Record<string, unknown>, baseUrl, ref, ctx);
    if (!r) continue;
    if ("listing" in r) listings.push(r.listing);
    else alsoListed.push(r.alsoListed);
  }
  return {
    ...base,
    listings: dedupeListings(listings),
    alsoListed,
    sawInventory: true,
    unitCount: units.length,
    notices: pageNotices(html),
  };
}

/** Back-compat wrapper: just the priced listings from the JSON blob. */
export function parseLeoEmbeddedData(html: string, baseUrl: string): UnitListing[] {
  return parseLeoInventory(html, baseUrl).listings;
}

/**
 * Last resort: the floorplan cards in the markup. They carry no availability
 * date, so rows from here are a degraded reading — used only when the page
 * has cards but no inventory blob.
 */
export function parseLeoCards(html: string, baseUrl: string): UnitListing[] {
  const $ = cheerio.load(html);
  const ctx = pageContext(html, $);
  const out: UnitListing[] = [];

  $(CARD_SELECTOR).each((_, el) => {
    const title = $(el).find(".jd-fp-card-info__title").first().text().trim();
    const parts = $(el)
      .find("p.jd-fp-card-info__text")
      .first()
      .find("span")
      .map((__, s) => tidy($(s).text()))
      .get();
    const info = parts.length > 0 ? parts.join(" | ") : tidy($(el).find("p.jd-fp-card-info__text").first().text());
    const priceText = $(el).find('[data-jd-fp-adp="display"]').first().text();
    // The first dollar amount only: "$2,635 - $2,900" must not read as 26352900.
    const priceM = /\$\s*([\d,]+(?:\.\d+)?)/.exec(priceText);
    const price = priceM ? Math.round(Number.parseFloat(priceM[1]!.replace(/,/g, ""))) : Number.NaN;
    if (!Number.isFinite(price) || price < MIN_SANE_RENT || price > MAX_SANE_RENT) return;

    const typeText = parts[0] ?? info;
    const label = /bed|studio/i.test(typeText) ? typeText : (/studio/i.test(info) ? "Studio" : info);
    const beds =
      plainBeds(label) ??
      ctx.catalogue.get(title)?.beds ??
      (/studio/i.test(info) ? 0 : coerceBeds(/(\d+)\s*bed/i.exec(info)?.[1]));
    if (beds === null || beds === undefined) return;
    // Only a real unit-type wording becomes a label — never stray card text.
    const typeLabel =
      /bed|studio|den|loft|penthouse|convertible/i.test(label) && plainBeds(label) === null && label.length <= 40
        ? label
        : null;

    const bathsM = /(\d+(?:\.\d+)?)\s*bath/i.exec(info);
    const sqftM = /([\d,]{3,})\s*sq/i.exec(info);
    const href = $(el).attr("href");

    out.push({
      unitNumber: /^[A-Za-z0-9][A-Za-z0-9 .-]{0,11}$/.test(title) ? title : null,
      floorplanName: typeLabel ?? planNameFor(beds),
      beds,
      ...(typeLabel ? { planType: typeLabel } : {}),
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

function pageTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? tidy(m[1]!).slice(0, 80) : "";
}

export const leo: Adapter = {
  id: "leo",
  async scrape(building, ctx) {
    // The trailing slash is the page's real address (/floorplans answers 302).
    const url = new URL("floorplans/", building.url).href;
    const ref = ctx.now?.() ?? new Date();

    let res: Response;
    try {
      res = await ctx.fetch(url);
    } catch (err) {
      throw new Error(`failed to fetch ${url} (${err instanceof Error ? err.message : err})`);
    }
    const html = await res.text();
    const seen = `HTTP ${res.status}, ${res.headers.get("content-type") ?? "no content type"}, ${html.length} bytes${pageTitle(html) ? `, title "${pageTitle(html)}"` : ""}`;

    const page = parseLeoInventory(html, building.url, ref);
    if (page.sawInventory) {
      ctx.record?.(url, html, "text/html");
      for (const row of page.alsoListed) ctx.reportAlsoListed?.(row);
      for (const notice of page.notices) ctx.reportNotice?.(notice);
      const emitted = page.listings.length + page.alsoListed.length;
      ctx.log(
        `${page.unitCount} unit(s) in the site's list → ${page.listings.length} priced, ${page.alsoListed.length} listed without a price or bed count${emitted < page.unitCount ? `, ${page.unitCount - emitted} unreadable` : ""}`,
      );
      if (page.catalogueAvailable !== null && page.catalogueAvailable !== page.unitCount) {
        ctx.log(
          `note: the page's catalogue marks ${page.catalogueAvailable} apartment(s) available, its list has ${page.unitCount}`,
        );
      }
      if (page.unitCount === 0) {
        // An empty list is only believed when nothing on the page contradicts it.
        if (page.catalogueAvailable !== null && page.catalogueAvailable > 0) {
          throw new Error(
            `${url}: the unit list is empty but the page's own catalogue marks ${page.catalogueAvailable} apartment(s) available — not recording an empty building on contradictory evidence (${seen})`,
          );
        }
        ctx.reportNotice?.(
          `The site lists no available apartments right now${page.catalogueSize > 0 ? ` (${page.catalogueSize} floor plans in its catalogue, none marked available)` : ""}.`,
        );
        ctx.log("inventory present and empty — the building lists nothing right now");
      }
      return page.listings;
    }

    // No inventory on the page: refused, or changed?
    if (isWafPage(html, res.status) || res.status === 401 || res.status === 403 || res.status === 429) {
      throw new SiteBlockedError(
        `the site's bot protection refused the request (${seen}) — left alone; the next scheduled run will ask again`,
      );
    }
    if (!res.ok) throw new Error(`${url} answered ${seen}`);

    // A real page without the blob: read what the cards say, clearly degraded.
    const cards = parseLeoCards(html, building.url);
    if (cards.length > 0) {
      ctx.record?.(url, html, "text/html");
      ctx.log(`no inventory data on the page; read ${cards.length} unit(s) from its cards (no move-in dates there)`);
      ctx.reportNotice?.(
        "Read from the page's cards because its unit data was missing: move-in dates are not available for this run.",
      );
      for (const notice of pageNotices(html)) ctx.reportNotice?.(notice);
      return cards;
    }
    throw new Error(
      `no unit data found on ${url} — the page structure may have changed (${seen})`,
    );
  },
};
