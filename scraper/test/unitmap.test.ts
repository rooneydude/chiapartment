import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeProjector } from "../../shared/src/geo";
import { normalizeRing, type Vec2 } from "../../shared/src/placement";
import { isBuildingFeature, type SkylineCollection } from "../../shared/src/types";
import {
  extractUmap,
  fitUnitsToFootprint,
  metersPerPixel,
  type UmapAsset,
} from "../src/unitmap";

const ROOT = join(import.meta.dirname, "..", "..");
const asset = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "scraper/fixtures/1225-old-town/07-assets-jl-w0-jlw03719w2y-72-7d-727d67713d611a5803dce818ec8ab.json",
    ),
    "utf8",
  ),
) as UmapAsset;
const skyline = JSON.parse(
  readFileSync(join(ROOT, "data", "skyline.geojson"), "utf8"),
) as SkylineCollection;

describe("unitmap georeference transform", () => {
  it("computes a sane Web-Mercator scale", () => {
    // zoom 19.74 at Chicago latitude → ~0.13 m/px; 2000px image ≈ 266 m.
    const s = metersPerPixel(41.905, 19.7434);
    expect(s).toBeGreaterThan(0.12);
    expect(s).toBeLessThan(0.15);
  });

  it("extracts levels, unit shapes, and the georeference from the real asset", () => {
    const { georeference, units } = extractUmap(asset);
    expect(georeference.bearing).toBeCloseTo(89, 0);
    expect(units.length).toBeGreaterThan(200); // 250 unit polygons
    expect(new Set(units.map((u) => u.levelIndex)).size).toBeGreaterThanOrEqual(13);
  });

  it("fits every unit centroid onto (or within 15m of) the OSM footprint", () => {
    const { georeference, units } = extractUmap(asset);
    const footprint = skyline.features
      .filter(isBuildingFeature)
      .find((f) => f.properties.osmId === 210717478)!.geometry.coordinates[0] as Vec2[];
    const fit = fitUnitsToFootprint(asset, units, georeference, footprint, skyline.meta.origin);
    expect(fit.residualM).toBeLessThanOrEqual(15);

    // Spot-check: positions land near the footprint centroid area in local meters.
    const projector = makeProjector(skyline.meta.origin);
    const ring = normalizeRing(footprint);
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    for (const ll of fit.positionsLL.values()) {
      const [x, y] = projector.toLocal(ll[0], ll[1]);
      expect(Math.hypot(x - cx, y - cy)).toBeLessThan(120); // building is ~110m long
    }
  });
});
