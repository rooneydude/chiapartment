import { describe, expect, it } from "vitest";
import { makeProjector } from "../../shared/src/geo";
import { areaFeaturesFromElements, roadFeaturesFromElements } from "../src/skyline";
import { isAreaFeature, isBuildingFeature } from "../../shared/src/types";

const projector = makeProjector({ lat: 41.9, lon: -87.635 });

// Overpass-shaped elements (way geometry as lat/lon pairs near the origin).
const deg = 1 / 111320; // ≈1m of longitude
const way = (
  id: number,
  tags: Record<string, string>,
  points: [number, number][], // meters east/north for readability
) => ({
  type: "way" as const,
  id,
  tags,
  geometry: points.map(([e, n]) => ({ lat: 41.9 + (n / 110540), lon: -87.635 + e * deg / Math.cos((41.9 * Math.PI) / 180) })),
});

describe("roadFeaturesFromElements", () => {
  it("classifies roads, rail, and stations", () => {
    const features = roadFeaturesFromElements(
      [
        way(1, { highway: "primary", name: "N Wells St" }, [[0, 0], [0, 500]]),
        way(2, { railway: "subway" }, [[10, 0], [10, 500]]),
        {
          type: "node" as const,
          id: 3,
          tags: { railway: "station", name: "Sedgwick", station: "subway" },
          lat: 41.9005,
          lon: -87.6355,
        } as never,
        way(4, { highway: "service" }, [[0, 0], [50, 0]]), // unmatched class passes through as class "service"? no: has highway tag
      ],
      projector,
    );
    const kinds = features.map((f) => f.properties.kind);
    expect(kinds).toContain("road");
    expect(kinds).toContain("rail");
    expect(kinds).toContain("station");
    const station = features.find((f) => f.properties.kind === "station")!;
    expect((station.properties as { name?: string }).name).toBe("Sedgwick");
    const road = features.find((f) => f.properties.kind === "road")!;
    expect((road.properties as { name?: string }).name).toBe("N Wells St");
  });

  it("drops short minor streets but keeps long ones", () => {
    const features = roadFeaturesFromElements(
      [
        way(1, { highway: "residential" }, [[0, 0], [20, 0]]), // 20m — dropped
        way(2, { highway: "residential" }, [[0, 0], [200, 0]]), // 200m — kept
        way(3, { highway: "primary" }, [[0, 0], [10, 0]]), // major roads always kept
      ],
      projector,
    );
    expect(features.filter((f) => f.geometry.type === "LineString")).toHaveLength(2);
  });

  it("simplifies collinear-ish polylines", () => {
    const zigzag: [number, number][] = Array.from({ length: 60 }, (_, i) => [
      i * 10,
      (i % 2) * 0.4, // sub-tolerance wiggle
    ]);
    const [f] = roadFeaturesFromElements([way(1, { highway: "primary" }, zigzag)], projector);
    expect(f!.geometry.type).toBe("LineString");
    expect((f!.geometry.coordinates as [number, number][]).length).toBeLessThan(10);
  });
});

describe("areaFeaturesFromElements", () => {
  const rect = (w: number, h: number): [number, number][] => [
    [0, 0], [w, 0], [w, h], [0, h], [0, 0],
  ];

  it("classifies water and parks, drops tiny areas", () => {
    const features = areaFeaturesFromElements(
      [
        way(1, { natural: "water", name: "Chicago River" }, rect(60, 40)), // 2400 m² ✓
        way(2, { leisure: "park", name: "Seward Park" }, rect(100, 50)),
        way(3, { natural: "water" }, rect(10, 10)), // 100 m² — dropped
        way(4, { building: "yes" }, rect(50, 50)), // not an area feature
      ],
      projector,
    );
    expect(features).toHaveLength(2);
    expect(features.map((f) => f.properties.kind).sort()).toEqual(["park", "water"]);
    // These Polygons must NOT be mistaken for buildings by the web guards.
    for (const f of features) {
      expect(isAreaFeature(f)).toBe(true);
      expect(isBuildingFeature(f)).toBe(false);
    }
  });
});
