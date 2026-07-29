import type { AnyNode } from "domhandler";
import type { Cheerio, CheerioAPI } from "cheerio";
import {
  absoluteUrl,
  clean,
  parseAvailability,
  parseBathrooms,
  parseBedrooms,
  parseLeaseTerm,
  parseMoney,
  parseSqft,
  planKey as toPlanKey,
} from "../parse";
import { looksLikeUnitCode } from "../shape";
import type { Adapter, ScrapeResult, ScrapedPlan, ScrapedUnit } from "../types";

/**
 * Last-resort DOM scraper: reads availability tables and unit cards straight
 * out of the markup.
 *
 * It handles the two layouts that essentially every leasing site converges on
 * regardless of platform — a table with a header row, and a grid of cards each
 * showing one unit — so it usually gets *something* even from a site nobody
 * has written a dedicated adapter for.
 */
export const domHeuristicAdapter: Adapter = {
  id: "dom-heuristic",
  platform: "generic",

  detect({ $ }) {
    const tables = findAvailabilityTables($);
    if (tables.length) return 0.45;
    const text = clean($("body").text());
    const hasPrices = (text.match(/\$\s?[\d,]{3,}/g) ?? []).length >= 3;
    const hasUnitWords = /\b(unit|apartment|residence)\s*#?\s*\d/i.test(text);
    if (hasPrices && hasUnitWords) return 0.3;
    return hasPrices ? 0.15 : 0.05;
  },

  async scrape(ctx): Promise<ScrapeResult> {
    const { $ } = ctx;
    const warnings: string[] = [];
    const units = new Map<string, ScrapedUnit>();

    for (const u of extractUnitsFromDom($, ctx.url)) {
      if (!units.has(u.unitCode)) units.set(u.unitCode, u);
    }

    const plans = extractPlansFromDom($, ctx.url);

    if (units.size === 0) {
      warnings.push(
        "No units found in the markup. Availability is most likely rendered " +
          "client-side — re-run with --render, or capture the XHR the page makes.",
      );
    }

    return {
      adapter: this.id,
      platform: this.platform,
      building: {
        name: clean($("title").first().text()).split(/\s*[|–—-]\s*/)[0] || undefined,
        address: readAddress($),
      },
      units: [...units.values()],
      plans,
      warnings,
    };
  },
};

/**
 * Reusable DOM extraction, shared with the crawling adapter. Tables are tried
 * first because a header row gives unambiguous column semantics; card parsing
 * is a fallback because it has to infer everything from free text.
 */
export function extractUnitsFromDom(
  $: CheerioAPI,
  baseUrl: string,
): ScrapedUnit[] {
  const units = new Map<string, ScrapedUnit>();
  for (const table of findAvailabilityTables($)) {
    for (const u of parseTable($, table, baseUrl)) {
      if (!units.has(u.unitCode)) units.set(u.unitCode, u);
    }
  }
  if (units.size === 0) {
    for (const u of parseCards($, baseUrl)) {
      if (!units.has(u.unitCode)) units.set(u.unitCode, u);
    }
  }
  return [...units.values()];
}

export function extractPlansFromDom(
  $: CheerioAPI,
  baseUrl: string,
): ScrapedPlan[] {
  return parsePlans($, baseUrl);
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

type Field =
  | "unit" | "rent" | "marketRent" | "sqft" | "beds" | "baths"
  | "available" | "term" | "plan" | null;

/** Map a header cell's text onto a field. */
function headerField(raw: string): Field {
  const h = raw.toLowerCase();
  if (/\b(unit|apt|apartment|residence)\b/.test(h) && !/type/.test(h)) return "unit";
  if (/market|street\s*rent|was\b|original/.test(h)) return "marketRent";
  if (/rent|price|monthly|starting/.test(h)) return "rent";
  if (/sq\.?\s*ft|sqft|square|size/.test(h)) return "sqft";
  if (/bed|\bbr\b/.test(h)) return "beds";
  if (/bath|\bba\b/.test(h)) return "baths";
  if (/avail|move|ready|date/.test(h)) return "available";
  if (/term|lease\s*length/.test(h)) return "term";
  if (/floor\s*plan|plan|layout|type/.test(h)) return "plan";
  return null;
}

function findAvailabilityTables($: CheerioAPI): Cheerio<AnyNode>[] {
  const out: Cheerio<AnyNode>[] = [];
  $("table").each((_, el) => {
    const $t = $(el);
    const fields = headerFields($, $t);
    // A real availability table names a unit column plus at least one of
    // rent/sqft — anything less is a pricing summary or an amenity grid.
    if (fields.includes("unit") && (fields.includes("rent") || fields.includes("sqft"))) {
      out.push($t as unknown as Cheerio<AnyNode>);
    }
  });
  return out;
}

function headerFields($: CheerioAPI, $t: Cheerio<AnyNode>): Field[] {
  let cells = $t.find("thead th, thead td").toArray();
  if (cells.length === 0) cells = $t.find("tr").first().find("th, td").toArray();
  return cells.map((c) => headerField(clean($(c).text())));
}

function parseTable(
  $: CheerioAPI,
  $t: Cheerio<AnyNode>,
  baseUrl: string,
): ScrapedUnit[] {
  const fields = headerFields($, $t);
  const rows = $t.find("tbody tr").toArray();
  const bodyRows = rows.length ? rows : $t.find("tr").toArray().slice(1);
  const out: ScrapedUnit[] = [];

  for (const row of bodyRows) {
    const $row = $(row);
    const cells = $row.find("td, th").toArray();
    if (cells.length < 2) continue;

    const unit: Partial<ScrapedUnit> = {};
    cells.forEach((cell, i) => {
      const field = fields[i];
      if (!field) return;
      const text = clean($(cell).text());
      switch (field) {
        case "unit":
          if (looksLikeUnitCode(text)) unit.unitCode = text;
          break;
        case "rent":
          unit.rent = parseMoney(text);
          break;
        case "marketRent":
          unit.marketRent = parseMoney(text);
          break;
        case "sqft":
          unit.sqft = parseSqft(text);
          break;
        case "beds":
          unit.bedrooms = parseBedrooms(text);
          break;
        case "baths":
          unit.bathrooms = parseBathrooms(text);
          break;
        case "available":
          unit.availableOn = parseAvailability(text);
          break;
        case "term":
          unit.leaseTermMonths = parseLeaseTerm(text);
          break;
        case "plan":
          if (text) unit.planKey = toPlanKey(text);
          break;
      }
    });

    if (!unit.unitCode) continue;
    unit.listingUrl = absoluteUrl($row.find("a[href]").first().attr("href"), baseUrl);
    unit.status = "available";
    if (unit.marketRent != null && unit.rent != null && unit.marketRent <= unit.rent) {
      unit.marketRent = undefined;
    }
    out.push(unit as ScrapedUnit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const UNIT_IN_TEXT =
  /(?:unit|apt\.?|apartment|residence|suite|#)\s*#?\s*([A-Z]{0,2}\d{2,5}[A-Z]?)\b/i;
const PRICE_IN_TEXT = /\$\s?[\d,]{3,}/;

/**
 * Text content with element boundaries preserved.
 *
 * Cheerio's `.text()` concatenates without separators, so
 * `<h3>Unit 2104</h3><p>1 Bed</p>` becomes "Unit 21041 Bed" and the unit
 * number parses as 21041. Joining text nodes with a space keeps the fields
 * apart.
 */
function blockText($: CheerioAPI, el: AnyNode): string {
  const parts: string[] = [];
  const walk = (node: AnyNode) => {
    if (node.type === "text") {
      parts.push((node as unknown as { data?: string }).data ?? "");
      return;
    }
    const children = (node as unknown as { children?: AnyNode[] }).children;
    if (children) for (const c of children) walk(c);
  };
  walk(el);
  return clean(parts.join(" "));
}

/**
 * Find the *minimal* elements whose text carries both a unit label and a
 * price. Taking the minimal container is what keeps a single card from
 * swallowing its neighbours when the grid has no useful class names.
 */
function parseCards($: CheerioAPI, baseUrl: string): ScrapedUnit[] {
  const out: ScrapedUnit[] = [];
  const seen = new Set<string>();

  $("body *").each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 20) return;
    const text = blockText($, el);
    if (text.length < 6 || text.length > 500) return;
    if (!PRICE_IN_TEXT.test(text)) return;

    const codeMatch = text.match(UNIT_IN_TEXT);
    if (!codeMatch) return;

    // Minimal container: no single child contains both signals.
    const childHasBoth = $el
      .children()
      .toArray()
      .some((c) => {
        const t = blockText($, c);
        return PRICE_IN_TEXT.test(t) && UNIT_IN_TEXT.test(t);
      });
    if (childHasBoth) return;

    const unitCode = clean(codeMatch[1]);
    if (!looksLikeUnitCode(unitCode) || seen.has(unitCode)) return;
    seen.add(unitCode);

    // Two prices in a card usually means struck-through market rent + effective.
    const prices = (text.match(/\$\s?[\d,]{3,}/g) ?? [])
      .map((p) => parseMoney(p))
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b);

    out.push({
      unitCode,
      rent: prices[0],
      marketRent: prices.length > 1 ? prices.at(-1) : undefined,
      bedrooms: parseBedrooms(text),
      bathrooms: parseBathrooms(text),
      sqft: parseSqft(text),
      availableOn: parseAvailability(text),
      leaseTermMonths: parseLeaseTerm(text),
      listingUrl: absoluteUrl($el.find("a[href]").first().attr("href"), baseUrl),
      status: "available",
    });
  });

  return out;
}

// ---------------------------------------------------------------------------
// Floor plans
// ---------------------------------------------------------------------------

const FLOORPLAN_HINT = /floor[-_\s]?plan|floorplan|\bplan\b|layout/i;

/**
 * Floor plan images are the input to the tracer, so pulling their URLs is as
 * important as pulling prices. They are identifiable by the hint appearing in
 * the src, the alt text, or an ancestor's class.
 */
function parsePlans($: CheerioAPI, baseUrl: string): ScrapedPlan[] {
  const out = new Map<string, ScrapedPlan>();

  $("img, source").each((_, el) => {
    const $img = $(el);
    const srcRaw =
      $img.attr("src") ??
      $img.attr("data-src") ??
      $img.attr("data-lazy-src") ??
      $img.attr("srcset")?.split(/\s*,\s*/)[0]?.split(/\s+/)[0];
    const src = absoluteUrl(srcRaw, baseUrl);
    if (!src) return;

    const alt = clean($img.attr("alt"));
    const ancestorClass = clean($img.parents().slice(0, 4).map((_i, p) => $(p).attr("class") ?? "").get().join(" "));
    const isPlan =
      FLOORPLAN_HINT.test(src) || FLOORPLAN_HINT.test(alt) || FLOORPLAN_HINT.test(ancestorClass);
    if (!isPlan) return;

    // Name the plan from the alt text or the nearest heading.
    const heading = clean(
      $img.closest("[class]").find("h1,h2,h3,h4,h5").first().text() ||
        $img.parents().slice(0, 4).find("h1,h2,h3,h4,h5").first().text(),
    );
    const name = clean(alt.replace(FLOORPLAN_HINT, "").replace(/[-–—|]/g, " ")) || heading;
    if (!name) return;

    const context = clean($img.parents().slice(0, 3).last().text());
    const key = toPlanKey(name);
    if (out.has(key)) return;
    out.set(key, {
      key,
      name,
      bedrooms: parseBedrooms(context),
      bathrooms: parseBathrooms(context),
      sqft: parseSqft(context),
      imageUrl: src,
    });
  });

  return [...out.values()];
}

function readAddress($: CheerioAPI): string | undefined {
  const fromMeta = $('meta[property="business:contact_data:street_address"]').attr("content");
  if (fromMeta) return clean(fromMeta);
  const el = $("[itemprop=streetAddress], address").first();
  const text = clean(el.text());
  return text || undefined;
}
