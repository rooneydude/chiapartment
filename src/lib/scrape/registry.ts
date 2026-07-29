import * as cheerio from "cheerio";
import { appFolioAdapter } from "./adapters/appfolio";
import { domHeuristicAdapter } from "./adapters/dom-heuristic";
import { embeddedJsonAdapter } from "./adapters/embedded-json";
import { rentCafeAdapter } from "./adapters/rentcafe";
import { siteCrawlAdapter } from "./adapters/site-crawl";
import type { Adapter } from "./types";

/**
 * Adapters, in no particular order — selection is by detection score, not
 * registration order, so adding a new one never changes existing behaviour
 * unless it genuinely scores higher on that site.
 */
export const ADAPTERS: Adapter[] = [
  rentCafeAdapter,
  appFolioAdapter,
  embeddedJsonAdapter,
  siteCrawlAdapter,
  domHeuristicAdapter,
];

export function getAdapter(id: string): Adapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

export interface DetectionResult {
  adapter: Adapter;
  score: number;
  /** Every adapter's score, best first — shown by `scrape --add`. */
  ranked: Array<{ id: string; score: number }>;
}

/** Score every adapter against a page and pick the best. */
export function detectAdapter(html: string, url: string): DetectionResult {
  const $ = cheerio.load(html);
  const origin = safeOrigin(url);
  const ranked = ADAPTERS.map((a) => ({
    id: a.id,
    score: round(a.detect({ html, $, url, origin })),
  })).sort((x, y) => y.score - x.score);

  const winner = getAdapter(ranked[0].id)!;
  return { adapter: winner, score: ranked[0].score, ranked };
}

function round(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
