import * as cheerio from "cheerio";
import { parseAvailableDate } from "../../../shared/src/parse";
import { chicagoDate } from "../../../shared/src/time";
import type { AlsoListed, UnitListing } from "../../../shared/src/types";
import { coerceBeds, dedupeListings, MAX_SANE_RENT, MIN_SANE_RENT } from "../normalize";
import type { Adapter } from "./types";

/**
 * Stead 220 — a custom marketing site in front of RentCafe.
 *
 * What the site publishes (and all it publishes): one hand-maintained record
 * per FLOORPLAN, where a floorplan is a riser/stack ("Unit 01".."Unit 13") or,
 * for penthouses, a single real unit ("Unit 2802"). Each record has a
 * "Starting from" price, a bed/bath count and an availability label. There
 * are no unit numbers below the penthouse floor, no square footage, no lease
 * terms and no move-in dates: the card label "Available Now" is the same on
 * every active plan (priced or not), i.e. the building's blanket statement.
 * The real per-unit inventory lives in RentCafe behind a bot wall we do not
 * go around.
 *
 * Two sources on /floorplans, merged by stack tag — one request per scrape:
 *   - window.__SSR_DATA__["units.list"]  (structured: price, beds, updatedAt)
 *   - .floorplan-card markup             (availability label, links)
 *
 * Known limits of that page (audited 2026-11-15):
 *   - It is a delayed copy of the building's CMS. Price edits reached it 1–5
 *     days late (median ~3); each record's own `updatedAt` is kept as
 *     `sourceUpdatedAt` so the age of a price is visible.
 *   - The live values, and per-floor rents, exist only behind /api/, which
 *     the site's robots.txt asks robots not to fetch. This adapter does not.
 *   - The per-plan pages (/floorplans/<n>) are rendered with placeholder
 *     numbers (floor 14, a prototype price table) before the browser loads
 *     the real ones — never parse prices or floors from them.
 */

interface PlanRecord {
  tag: string; // "01", "13", "2802"
  name: string | null;
  beds: number | null;
  baths: number | null;
  price: number | null;
  priceText: string | null;
  availability: string | null;
  href: string | null;
  updatedAt: string | null;
  /** The site's own "is this plan on offer" switch; null when not stated. */
  active: boolean | null;
  /** The site's bedroom label when it says more than the count ("1 Bed + Den"). */
  typeLabel: string | null;
}

/** A bedroom label that carries more than a bed count, tidied; else null. */
function typeLabelOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.replace(/\s+/g, " ").trim();
  if (!label || label.length > 40) return null;
  return /^(studio|\d+\s*(bed(room)?s?|br))$/i.test(label) ? null : label;
}

const NO_PRICE_TEXT = /contact for pricing|call for pricing|pricing upon request|inquire/i;
const NOT_AVAILABLE = /waitlist|wait list|unavailable|leased|sold out|coming soon/i;

function normTag(raw: string | number): string {
  const s = String(raw).trim();
  return /^\d{1,2}$/.test(s) ? s.padStart(2, "0") : s;
}

function sanePrice(n: unknown): number | null {
  const v = typeof n === "number" ? n : Number.NaN;
  return Number.isFinite(v) && v >= MIN_SANE_RENT && v <= MAX_SANE_RENT ? Math.round(v) : null;
}

/** Pull `window.__SSR_DATA__ = {...}` out of the page, tolerating any miss. */
export function extractSsrData(html: string): Record<string, unknown> | null {
  const marker = "window.__SSR_DATA__=";
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const end = html.indexOf("</script>", start);
  if (end === -1) return null;
  const body = html.slice(start + marker.length, end).trim().replace(/;$/, "");
  try {
    const data: unknown = JSON.parse(body);
    return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function plansFromSsr(html: string): Map<string, PlanRecord> {
  const out = new Map<string, PlanRecord>();
  const list = extractSsrData(html)?.["units.list"];
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const num = r["unitNumber"];
    if (typeof num !== "number" && typeof num !== "string") continue;
    const tag = normTag(num);
    out.set(tag, {
      tag,
      name: typeof r["unitName"] === "string" ? r["unitName"].replace(/\s+/g, " ").trim() : null,
      beds: coerceBeds(r["bedrooms"]),
      baths: typeof r["bathrooms"] === "number" ? r["bathrooms"] : null,
      price: sanePrice(r["startingPrice"]),
      priceText: typeof r["priceDisplay"] === "string" ? r["priceDisplay"].trim() : null,
      availability: null,
      href: null,
      updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : null,
      active: typeof r["isActive"] === "boolean" ? r["isActive"] : null,
      typeLabel: typeLabelOf(r["bedrooms"]),
    });
  }
  return out;
}

function plansFromCards(html: string): Map<string, PlanRecord> {
  const $ = cheerio.load(html);
  const out = new Map<string, PlanRecord>();
  $(".floorplan-card").each((i, el) => {
    const name = $(el).find(".fp-card-name").first().text().trim(); // "STUDIO"
    const meta = $(el).find(".fp-card-meta").first().text().trim(); // "LARGE · UNIT 01 · 1 BATH"
    if (!name) return;
    const amount = $(el).find(".fp-card-price-amount").first().text();
    const contact = $(el).find(".fp-card-price-contact").first().text().trim();
    // The first dollar amount only — "$2,475 - $2,700" must not read as 24752700.
    const amountM = /\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/.exec(amount);
    const priceNum = amountM ? Number.parseInt(amountM[1]!.replace(/,/g, ""), 10) : Number.NaN;
    const bathsM = /(\d+(?:\.\d+)?)\s*BATH/i.exec(meta);
    const unitTagM = /UNIT\s*(\d+)/i.exec(meta);
    const aria = $(el).find("[aria-label]").first().attr("aria-label") ?? "";
    const ariaName = aria.replace(/\s*preview.*$/i, "").trim();
    const tag = unitTagM ? normTag(unitTagM[1]!) : `card-${i}`;
    out.set(tag, {
      tag,
      name: ariaName || (unitTagM ? `${name} - Unit ${unitTagM[1]}` : `${name} (${meta})`),
      beds: coerceBeds(name),
      baths: bathsM ? Number.parseFloat(bathsM[1]!) : null,
      price: sanePrice(priceNum),
      priceText: contact || (amount.trim() ? amount.trim() : null),
      availability: $(el).find(".fp-availability-label").first().text().replace(/\s+/g, " ").trim() || null,
      href: $(el).find('a[href^="/floorplans/"]').first().attr("href") ?? null,
      updatedAt: null,
      active: null,
      // Card headings are upper-case ("1 BED + DEN"); the data blob's label is preferred.
      typeLabel: null,
    });
  });
  return out;
}

export interface SteadPage {
  listings: UnitListing[];
  alsoListed: AlsoListed[];
  /** How many floorplan records the page carried at all. */
  planCount: number;
}

export function parseSteadFloorplans(html: string, baseUrl: string, ref: Date): SteadPage {
  const ssr = plansFromSsr(html);
  const cards = plansFromCards(html);
  const today = chicagoDate(ref);
  const tags = [...new Set([...cards.keys(), ...ssr.keys()])];

  const listings: UnitListing[] = [];
  const alsoListed: AlsoListed[] = [];
  for (const tag of tags) {
    const s = ssr.get(tag);
    const c = cards.get(tag);
    const beds = s?.beds ?? c?.beds ?? null;
    const baths = s?.baths ?? c?.baths ?? null;
    const name = c?.name ?? s?.name ?? `Unit ${tag}`;
    const price = s?.price ?? c?.price ?? null;
    const priceText = c?.priceText ?? s?.priceText ?? null;
    const availability = c?.availability ?? null;
    const href = c?.href ?? `/floorplans/${Number.parseInt(tag, 10) || tag}`;
    const url = new URL(href, baseUrl).href;
    // "Unit 01".."Unit 13" are stacks; a 3–4 digit tag is one physical unit
    // (2802 = floor 28, stack 02).
    const unitNumber = /^\d{3,4}$/.test(tag) ? tag : null;

    // A plan the site has switched off, or labels unavailable / waitlist, is
    // still listed — it is shown as such, never dropped.
    const inactive = s?.active === false;
    const notAvailable = inactive || (availability !== null && NOT_AVAILABLE.test(availability));
    const availableDate = availability && !notAvailable ? parseAvailableDate(availability, ref) : null;
    const availableNow = availableDate !== null ? availableDate <= today : undefined;
    const updated = s?.updatedAt ?? undefined;

    if (price === null || beds === null || notAvailable) {
      const why =
        notAvailable
          ? (availability && NOT_AVAILABLE.test(availability) ? availability : "Unavailable")
          : price === null
            ? (priceText && NO_PRICE_TEXT.test(priceText) ? priceText : "No price published")
            : "Bed count not published";
      alsoListed.push({
        unitNumber,
        floorplanName: name,
        beds,
        baths,
        ...(price !== null ? { price } : {}),
        availableDate,
        ...(availableNow !== undefined ? { availableNow } : {}),
        note: why,
        url,
      });
      continue;
    }

    listings.push({
      unitNumber,
      floorplanName: name,
      beds,
      ...(s?.typeLabel ? { planType: s.typeLabel } : {}),
      baths,
      sqft: null,
      price,
      availableDate,
      ...(availableNow !== undefined ? { availableNow } : {}),
      ...(updated ? { sourceUpdatedAt: updated } : {}),
      url,
    });
  }

  return { listings: dedupeListings(listings), alsoListed, planCount: tags.length };
}

export const stead220: Adapter = {
  id: "stead220",
  async scrape(building, ctx) {
    const listUrl = new URL("/floorplans", building.url).href;
    let html: string;
    try {
      const res = await ctx.fetch(listUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      throw new Error(`failed to fetch ${listUrl} (${err instanceof Error ? err.message : err})`);
    }
    ctx.record?.(listUrl, html, "text/html");

    const page = parseSteadFloorplans(html, building.url, ctx.now?.() ?? new Date());
    if (page.planCount === 0) {
      throw new Error(`no floorplan cards parsed from ${listUrl} — page structure may have changed`);
    }
    for (const row of page.alsoListed) ctx.reportAlsoListed?.(row);
    ctx.log(
      `${page.listings.length} priced floorplans, ${page.alsoListed.length} listed without a price or not available`,
    );
    return page.listings;
  },
};
