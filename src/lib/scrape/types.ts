import type { CheerioAPI } from "cheerio";

/** A single availability row as published by a building. */
export interface ScrapedUnit {
  /** Unit label exactly as shown, e.g. "3208", "PH02", "Unit 1104". */
  unitCode: string;
  /** Effective monthly rent in whole dollars. */
  rent?: number;
  /** Pre-concession rent, when the site shows a struck-through price. */
  marketRent?: number;
  bedrooms?: number;
  bathrooms?: number;
  sqft?: number;
  /** ISO date (YYYY-MM-DD) the unit becomes available. */
  availableOn?: string;
  leaseTermMonths?: number;
  /** Key into `ScrapeResult.plans`. */
  planKey?: string;
  listingUrl?: string;
  status?: "available" | "leased";
}

/** A floor plan type, which is where the floor plan images come from. */
export interface ScrapedPlan {
  /** Stable key within the building — usually the site's own plan id or slug. */
  key: string;
  name: string;
  bedrooms?: number;
  bathrooms?: number;
  sqft?: number;
  /** Absolute URL of the floor plan image or PDF. */
  imageUrl?: string;
}

export interface ScrapedBuildingInfo {
  name?: string;
  address?: string;
  lat?: number;
  lng?: number;
  phone?: string;
}

export interface ScrapeResult {
  adapter: string;
  platform: string;
  building: ScrapedBuildingInfo;
  units: ScrapedUnit[];
  plans: ScrapedPlan[];
  /** Anything the adapter noticed but could not parse. Surfaced in the CLI. */
  warnings: string[];
}

/** Everything an adapter is given to work with. */
export interface ScrapeContext {
  /** The source URL as configured. */
  url: string;
  /** Origin of `url`, e.g. "https://fulbrix.com". */
  origin: string;
  /** HTML of `url`, already fetched once so detection is free. */
  html: string;
  /** Cheerio handle over `html`. */
  $: CheerioAPI;
  /**
   * Polite fetch bound to this source: obeys robots.txt, rate limits per host,
   * caches to disk, and resolves relative URLs against `origin`.
   */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Convenience wrappers over `fetch`. */
  getText: (url: string) => Promise<string>;
  getJson: <T = unknown>(url: string, init?: RequestInit) => Promise<T>;
  log: (msg: string) => void;
}

export interface Adapter {
  /** Stable id, also written to `sources.adapter`. */
  id: string;
  /** Leasing platform this adapter targets. */
  platform: string;
  /**
   * Confidence in [0, 1] that this adapter can parse the page. Detection reads
   * only `ctx.html`/`ctx.$` and must not perform network calls.
   */
  detect(ctx: Pick<ScrapeContext, "html" | "$" | "url" | "origin">): number;
  scrape(ctx: ScrapeContext): Promise<ScrapeResult>;
}
