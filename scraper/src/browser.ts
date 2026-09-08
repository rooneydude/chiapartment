import type { AdapterContext } from "./adapters/types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Third-party beacons that keep `networkidle` from ever firing (GTM, HubSpot,
 * live chat) and are not needed to parse leasing HTML. Aborting them is the
 * difference between a 2s scrape and a 45s timeout that then reads a WAF page.
 */
const BLOCKED_HOST =
  /googletagmanager|google-analytics|doubleclick|facebook\.net|connect\.facebook|hotjar|hubspot|hs-scripts|hsadspixel|hs-banner|hscollectedforms|livechatinc|livechat\.com|calendly|googleads|adservice\.google|clarity\.ms|newrelic|nr-data\.net/i;

export interface RenderedFetchOptions {
  timeoutMs?: number;
  waitForSelector?: string;
  selectorTimeoutMs?: number;
  /** Playwright navigation wait. Default `domcontentloaded` — never `networkidle`. */
  waitUntil?: "domcontentloaded" | "load" | "commit";
  blockTrackers?: boolean;
}

/**
 * Fetch a page's rendered DOM via headless Chromium — the escape hatch for
 * sites whose plain-HTTP endpoints sit behind bot protection (Imunify360)
 * but whose real-browser traffic is allowed.
 */
export async function fetchRenderedHtml(
  url: string,
  ctx: AdapterContext,
  {
    timeoutMs = 45_000,
    waitForSelector,
    selectorTimeoutMs = 25_000,
    waitUntil = "domcontentloaded",
    blockTrackers = true,
  }: RenderedFetchOptions = {},
): Promise<string> {
  let chromium: (typeof import("playwright"))["chromium"];
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("playwright is not installed — run `npx playwright install chromium`");
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    const page = await context.newPage();
    if (blockTrackers) {
      await page.route("**/*", (route) => {
        const req = route.request();
        const resourceType = req.resourceType();
        if (resourceType === "image" || resourceType === "media" || resourceType === "font") {
          return route.abort();
        }
        if (BLOCKED_HOST.test(req.url())) return route.abort();
        return route.continue();
      });
    }
    try {
      await page.goto(url, { waitUntil, timeout: timeoutMs });
    } catch {
      ctx.log(`navigation to ${url} timed out; using what loaded`);
    }
    if (waitForSelector) {
      // Interstitial/challenge pages render without the real content; give
      // the target element a chance to appear before grabbing the DOM.
      await page
        .waitForSelector(waitForSelector, { timeout: selectorTimeoutMs })
        .catch(() => ctx.log(`selector ${waitForSelector} never appeared; using what loaded`));
    }
    await page.waitForTimeout(800);
    // content() throws if a script kicks off a navigation at the wrong
    // moment ("page is navigating and changing the content") — let it settle
    // and retry instead of failing the scrape.
    let html = "";
    for (let attempt = 1; ; attempt++) {
      try {
        html = await page.content();
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        ctx.log(`page.content() not ready (attempt ${attempt}); waiting for navigation to settle`);
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
      }
    }
    ctx.record?.(url, html, "text/html");
    return html;
  } finally {
    await browser.close();
  }
}
