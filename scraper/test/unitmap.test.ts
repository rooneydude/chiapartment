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
      "scraper/fixtures/legacy-2026-09/1225-old-town/07-assets-jl-w0-jlw03719w2y-72-7d-727d67713d611a5803dce818ec8ab.json",
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
    // 243 polygons + 7 units the floorplate draws as plain rectangles.
    expect(units).toHaveLength(250);
    expect(new Set(units.map((u) => u.levelIndex)).size).toBeGreaterThanOrEqual(13);
  });

  it("places rectangle-shaped units too (unit 0509 was missing from the 3D map)", () => {
    const { units } = extractUmap(asset);
    // SightMap unit id 10028715 = unit 0509, drawn as a Rect at x 772.91, y 368.38.
    const u0509 = units.find((u) => u.unitId === "10028715");
    expect(u0509).toBeDefined();
    expect(u0509!.centroidPx[0]).toBeCloseTo(772.91 + 121.91 / 2, 2);
    expect(u0509!.centroidPx[1]).toBeCloseTo(368.38 + 172.15 / 2, 2);

    const synthetic = extractUmap({
      width: 100,
      height: 100,
      elements: [
        { type: "Georeference", latitude: 41.9, longitude: -87.63, zoom: 19, bearing: 0 },
        {
          type: "Level",
          elements: [
            { type: "Unit", id: "rect", shape: { type: "Rect", x: 10, y: 20, width: 30, height: 40 } },
            { type: "Unit", id: "empty", shape: { type: "Rect", x: 10, y: 20, width: 0, height: 40 } },
            { type: "Unit", id: "poly", shape: { type: "Polygon", points: "0,0 10,0 10,10 0,10" } },
          ],
        },
      ],
    });
    expect(synthetic.units.map((u) => [u.unitId, u.centroidPx])).toEqual([
      ["rect", [25, 40]],
      ["poly", [5, 5]],
    ]);
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
