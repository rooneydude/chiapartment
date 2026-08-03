import { describe, expect, it } from "vitest";
import { distanceM, makeProjector } from "../src/geo";

describe("makeProjector", () => {
  const origin = { lat: 41.9, lon: -87.635 };

  it("round-trips lon/lat through local meters", () => {
    const p = makeProjector(origin);
    const [x, y] = p.toLocal(-87.63, 41.905);
    const [lon, lat] = p.fromLocal(x, y);
    expect(lon).toBeCloseTo(-87.63, 8);
    expect(lat).toBeCloseTo(41.905, 8);
  });

  it("produces sane Chicago-scale distances", () => {
    // ~1 degree lat ≈ 110.5 km
    expect(distanceM({ lat: 41.9, lon: -87.635 }, { lat: 41.91, lon: -87.635 })).toBeCloseTo(
      1105.4,
      0,
    );
    // Wells corridor to Fulton Market ≈ 2.5 km
    const d = distanceM({ lat: 41.9031, lon: -87.6344 }, { lat: 41.8857, lon: -87.6606 });
    expect(d).toBeGreaterThan(2000);
    expect(d).toBeLessThan(3500);
  });
});
