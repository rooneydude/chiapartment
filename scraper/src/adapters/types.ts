import type { BuildingConfig, UnitListing } from "../../../shared/src/types";

export interface AdapterContext {
  /** HTTP client — browser-like in live mode, fixture-backed in --fixtures. */
  fetch: typeof fetch;
  log: (msg: string) => void;
  /** Present in --capture mode: persist a raw payload as a fixture. */
  record?: (url: string, body: string, contentType: string) => void;
  /**
   * From config focus.maxLeaseTermMonths: adapters that can see lease-term
   * pricing must not quote prices requiring a longer lease than this.
   */
  maxLeaseTermMonths?: number;
}

export interface Adapter {
  id: string;
  scrape(building: BuildingConfig, ctx: AdapterContext): Promise<UnitListing[]>;
}
