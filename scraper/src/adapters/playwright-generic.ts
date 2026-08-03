import type { UnitListing } from "../../../shared/src/types";
import { dedupeListings, findUnitListings, parseHtmlListings } from "../normalize";
import { fromJsonLd } from "./generic";
import type { Adapter } from "./types";

/**
 * Playwright fallback for JS-rendered leasing sites: load the page in
 * Chromium, capture JSON XHR responses that look availability-related,
 * normalize them; fall back to the rendered DOM.
 */

const XHR_HINT = /avail|floor-?plan|unit|pricing|sightmap|apartment|listing|api/i;
const EXTRA_PATHS = ["floorplans", "floor-plans", "availability", "residences"];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const playwrightGeneric: Adapter = {
  id: "playwright-generic",
  async scrape(building, ctx) {
    let chromium: (typeof import("playwright"))["chromium"];
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      throw new Error(
        "playwright is not installed — run `npx playwright install chromium` or use another adapter",
      );
    }

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        userAgent: UA,
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();

      const payloads: { url: string; body: string }[] = [];
      page.on("response", (res) => {
        void (async () => {
          try {
            const url = res.url();
            const ct = res.headers()["content-type"] ?? "";
            if (res.status() !== 200 || !ct.includes("json") || !XHR_HINT.test(url)) return;
            const body = await res.text();
            if (body.length > 2_000_000) return;
            payloads.push({ url, body });
            ctx.record?.(url, body, "application/json");
          } catch {
            // response body unavailable (redirects etc.) — ignore
          }
        })();
      });

      const targets = [
        building.url,
        ...EXTRA_PATHS.map((p) => new URL(p, building.url).href),
      ];
      const listings: UnitListing[] = [];
      for (const target of targets) {
        try {
          await page.goto(target, { waitUntil: "networkidle", timeout: 45_000 });
        } catch {
          ctx.log(`navigation to ${target} timed out; using what loaded`);
        }
        await page.waitForTimeout(2_000);

        for (const p of payloads.splice(0)) {
          try {
            listings.push(...findUnitListings(JSON.parse(p.body)));
          } catch {
            // not valid JSON after all
          }
        }
        if (listings.length === 0) {
          const html = await page.content();
          ctx.record?.(target, html, "text/html");
          listings.push(...fromJsonLd(html));
          if (listings.length === 0) listings.push(...parseHtmlListings(html));
        }
        if (listings.length > 0) break;
      }
      return dedupeListings(listings);
    } finally {
      await browser.close();
    }
  },
};
