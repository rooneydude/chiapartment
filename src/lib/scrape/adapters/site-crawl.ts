import * as cheerio from "cheerio";
import { extractJsonBlobs } from "../json-blobs";
import { absoluteUrl, clean, planKey as toPlanKey } from "../parse";
import { harvestPlans, harvestUnits } from "../shape";
import { extractPlansFromDom, extractUnitsFromDom } from "./dom-heuristic";
import type { Adapter, ScrapeResult, ScrapedPlan, ScrapedUnit } from "../types";

/**
 * Follows a building's marketing site to wherever the availability actually
 * lives.
 *
 * This is the adapter that matters for bespoke single-building sites: the URL
 * you'd naturally configure is the homepage, but the units are two clicks away
 * on /floorplans or /availability, and the floor plan images are on per-plan
 * detail pages below that. It walks that structure, then applies both the JSON
 * and DOM extractors to every page it collects.
 */

const NAV_HINT =
  /floor-?plans?|availabilit|apartments?|residences?|rentals?|units?|pricing|lease|live|homes/i;

/** Paths worth trying blind when the nav gives us nothing. */
const COMMON_PATHS = [
  "/floorplans",
  "/floor-plans",
  "/availability",
  "/apartments",
  "/residences",
  "/pricing",
  "/rentals",
  "/units",
];

const MAX_PAGES = 12;

export const siteCrawlAdapter: Adapter = {
  id: "site-crawl",
  platform: "generic",

  detect({ $, html }) {
    // Claims any page that links onward to something availability-shaped but
    // doesn't itself carry units. Scored below the direct extractors so it
    // only wins when they find nothing on the entry page.
    const hasUnitsHere =
      extractJsonBlobs(html).some((b) => harvestUnits(b).length > 0) ||
      extractUnitsFromDom($, "https://example.invalid").length > 0;
    if (hasUnitsHere) return 0.1;

    const links = $("a[href]")
      .toArray()
      .filter((a) => NAV_HINT.test(clean($(a).attr("href") ?? "") + " " + clean($(a).text())));
    return links.length > 0 ? 0.4 : 0.12;
  },

  async scrape(ctx): Promise<ScrapeResult> {
    const warnings: string[] = [];
    const units = new Map<string, ScrapedUnit>();
    const plans = new Map<string, ScrapedPlan>();

    const queue = discoverPages(ctx.$, ctx.url, ctx.origin);
    const visited = new Set<string>([normalize(ctx.url)]);

    // The entry page is already fetched — mine it before walking anywhere.
    absorb(ctx.html, ctx.url, units, plans);

    for (const url of queue) {
      if (visited.size >= MAX_PAGES) {
        warnings.push(`Stopped after ${MAX_PAGES} pages; more availability pages may exist.`);
        break;
      }
      const key = normalize(url);
      if (visited.has(key)) continue;
      visited.add(key);

      let html: string;
      try {
        const res = await ctx.fetch(url);
        if (!res.ok) {
          // Blind-guessed paths 404 constantly; that is not worth reporting.
          continue;
        }
        html = await res.text();
      } catch (err) {
        warnings.push(`${url}: ${(err as Error).message}`);
        continue;
      }

      const before = units.size;
      absorb(html, url, units, plans);
      ctx.log(`${url} → +${units.size - before} unit(s)`);

      // A page that produced units is a hub; follow its per-plan detail links.
      if (units.size > before && visited.size < MAX_PAGES) {
        const $page = cheerio.load(html);
        for (const next of discoverPages($page, url, ctx.origin)) {
          if (!visited.has(normalize(next))) queue.push(next);
        }
      }
    }

    linkUnitsToPlans(units, plans);

    if (units.size === 0) {
      warnings.push(
        `Crawled ${visited.size} page(s) and found no units. The site almost certainly ` +
          "renders availability client-side; capture the XHR it makes (DevTools → Network → Fetch/XHR) " +
          "and add its URL to the source with --api-url.",
      );
    }

    return {
      adapter: this.id,
      platform: this.platform,
      building: {
        name: clean(ctx.$("title").first().text()).split(/\s*[|–—-]\s*/)[0] || undefined,
      },
      units: [...units.values()],
      plans: [...plans.values()],
      warnings,
    };
  },
};

/** Pull units and plans out of one page, by both routes. */
function absorb(
  html: string,
  url: string,
  units: Map<string, ScrapedUnit>,
  plans: Map<string, ScrapedPlan>,
) {
  const $ = cheerio.load(html);

  for (const blob of extractJsonBlobs(html)) {
    for (const u of harvestUnits(blob, { baseUrl: url })) {
      if (!units.has(u.unitCode)) units.set(u.unitCode, u);
    }
    for (const p of harvestPlans(blob, { baseUrl: url })) {
      const key = toPlanKey(p.key);
      if (!plans.has(key)) plans.set(key, { ...p, key });
    }
  }

  for (const u of extractUnitsFromDom($, url)) {
    if (!units.has(u.unitCode)) units.set(u.unitCode, u);
  }
  for (const p of extractPlansFromDom($, url)) {
    // A DOM-found plan with an image beats a JSON-found plan without one.
    const prior = plans.get(p.key);
    if (!prior || (!prior.imageUrl && p.imageUrl)) {
      plans.set(p.key, { ...prior, ...p });
    }
  }
}

/** Same-origin links that look like they lead to availability, plus blind guesses. */
function discoverPages(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  origin: string,
): string[] {
  const found = new Set<string>();

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    const text = clean($(a).text());
    const abs = absoluteUrl(href, pageUrl);
    if (!abs || !abs.startsWith(origin)) return;
    if (!NAV_HINT.test(href ?? "") && !NAV_HINT.test(text)) return;
    // Skip obvious non-content links.
    if (/\.(pdf|jpe?g|png|webp|zip)$/i.test(abs)) return;
    found.add(abs.split("#")[0]);
  });

  for (const p of COMMON_PATHS) found.add(origin + p);
  return [...found];
}

function linkUnitsToPlans(
  units: Map<string, ScrapedUnit>,
  plans: Map<string, ScrapedPlan>,
) {
  const byName = new Map<string, string>();
  for (const p of plans.values()) byName.set(toPlanKey(p.name), p.key);

  for (const u of units.values()) {
    if (u.planKey) {
      const k = toPlanKey(u.planKey);
      u.planKey = plans.has(k) ? k : byName.get(k) ?? k;
      continue;
    }
    // Fall back to matching on the bed/bath/sqft signature, which is how these
    // sites relate a unit row to its plan when they don't emit an explicit id.
    const match = [...plans.values()].find(
      (p) =>
        p.bedrooms != null &&
        p.bedrooms === u.bedrooms &&
        p.sqft != null &&
        u.sqft != null &&
        Math.abs(p.sqft - u.sqft) <= 15,
    );
    if (match) u.planKey = match.key;
  }
}

function normalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}
