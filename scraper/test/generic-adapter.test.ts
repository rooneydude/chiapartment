import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildingsConfigSchema, UnitListingSchema } from "../../shared/src/types";
import { generic } from "../src/adapters/generic";
import type { AdapterContext } from "../src/adapters/types";
import { makeFixtureFetch } from "../src/fixtures";

const ROOT = join(import.meta.dirname, "..", "..");

function ctxFor(buildingId: string): AdapterContext {
  return {
    fetch: makeFixtureFetch(join(ROOT, "scraper", "fixtures", buildingId)),
    log: () => {},
  };
}

describe("generic adapter against fixtures", () => {
  const config = BuildingsConfigSchema.parse(
    JSON.parse(readFileSync(join(ROOT, "buildings.json"), "utf8")),
  );

  it("scrapes every configured building's fixture into valid listings", async () => {
    for (const building of config.buildings) {
      const listings = await generic.scrape(building, ctxFor(building.id));
      expect(listings.length, building.id).toBeGreaterThan(0);
      for (const l of listings) UnitListingSchema.parse(l);
      // Sample data should carry unit numbers so 3D placement works.
      expect(listings.every((l) => l.unitNumber !== null), building.id).toBe(true);
    }
  });

  it("misses cleanly on unknown URLs", async () => {
    const fetch = makeFixtureFetch(join(ROOT, "scraper", "fixtures", "stead-220"));
    const res = await fetch("https://example.com/nope");
    expect(res.status).toBe(404);
  });
});
