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
}

export interface Adapter {
  id: string;
  scrape(building: BuildingConfig, ctx: AdapterContext): Promise<UnitListing[]>;
}
