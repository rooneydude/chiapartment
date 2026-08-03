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
  { timeoutMs = 45_000 }: { timeoutMs?: number } = {},
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
    await page.waitForTimeout(1500);
    const html = await page.content();
    ctx.record?.(url, html, "text/html");
    return html;
  } finally {
    await browser.close();
  }
}
