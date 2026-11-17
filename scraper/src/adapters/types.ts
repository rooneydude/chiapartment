import type { AlsoListed, BuildingConfig, UnitListing } from "../../../shared/src/types";

export interface AdapterContext {
  /** HTTP client — browser-like in live mode, fixture-backed in --fixtures. */
  fetch: typeof fetch;
  log: (msg: string) => void;
  /** Present in --capture mode: persist a raw payload as a fixture. */
  record?: (url: string, body: string, contentType: string) => void;
  /**
   * Live mode only: wait between consecutive requests to the same host.
   * Absent in fixture mode and tests, so they stay instant.
   */
  pause?: (ms: number) => Promise<void>;
  /**
   * The instant "now" is judged from ("Available Now" → today's Chicago day,
   * year-less dates, available-now flags). Defaults to the wall clock; tests
   * and fixture replays pin it so results do not drift with the calendar.
   */
  now?: () => Date;
  /**
   * Record something the site lists that is not a comparable unit — no price
   * ("Contact for Pricing", a waitlist plan) or no published bed count — so
   * the dashboard can still show that it exists.
   */
  reportAlsoListed?: (row: AlsoListed) => void;
  /** Record a building-wide notice the site prints (special / concession). */
  reportNotice?: (text: string) => void;
  /**
   * Record, in plain words, something this run could not read although the
   * scrape goes on — an optional page that refused the request, for example.
   * It is shown on the building's page next to the data it explains.
   */
  reportGap?: (text: string) => void;
}

/**
 * The site answered with its bot protection (a challenge / "access denied"
 * page, or a flat 401 / 403 / 429) instead of the page. Thrown so the run
 * records the refusal as such and does not ask again in the same run: a
 * site that has said no is left alone until the next scheduled scrape.
 */
export class SiteBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteBlockedError";
  }
}

export interface Adapter {
  id: string;
  scrape(building: BuildingConfig, ctx: AdapterContext): Promise<UnitListing[]>;
}
