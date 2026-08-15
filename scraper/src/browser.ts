import type { AdapterContext } from "./adapters/types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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
  }: { timeoutMs?: number; waitForSelector?: string } = {},
): Promise<string> {
  let chromium: (typeof import("playwright"))["chromium"];
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("playwright is not installed — run `npx playwright install chromium`");
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (
      await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } })
    ).newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    } catch {
      ctx.log(`navigation to ${url} timed out; using what loaded`);
    }
    if (waitForSelector) {
      // Interstitial/challenge pages render without the real content; give
      // the target element a chance to appear before grabbing the DOM.
      await page
        .waitForSelector(waitForSelector, { timeout: 15_000 })
        .catch(() => ctx.log(`selector ${waitForSelector} never appeared; using what loaded`));
    }
    await page.waitForTimeout(1500);
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
        await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
      }
    }
    ctx.record?.(url, html, "text/html");
    return html;
  } finally {
    await browser.close();
  }
}
