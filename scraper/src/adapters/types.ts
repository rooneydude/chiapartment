import type { BuildingConfig, UnitListing } from "../../../shared/src/types";

export interface AdapterContext {
  /** HTTP client — browser-like in live mode, fixture-backed in --fixtures. */
  fetch: typeof fetch;
  log: (msg: string) => void;
  /** Present in --capture mode: persist a raw payload as a fixture. */
  record?: (url: string, body: string, contentType: string) => void;
}

export interface Adapter {
  id: string;
  scrape(building: BuildingConfig, ctx: AdapterContext): Promise<UnitListing[]>;
}
