import { makeProjector } from "../../../shared/src/geo";
import { makeBoxRing, normalizeRing, ringCentroid, type Vec2 } from "../../../shared/src/placement";
import { isBuildingFeature } from "../../../shared/src/types";
import type {
  BuildingConfig,
  SkylineCollection,
  SkylineFeature,
} from "../../../shared/src/types";

/**
 * Height the floor math uses: derived from the configured floors, not taken
 * from OSM, whose data for new towers is often stale (podium-only levels).
 */
export function configuredHeight(building: BuildingConfig): number {
  const g = building.geometry;
  return g.groundFloorOffsetM + g.floors * g.floorHeightM;
}

export interface TrackedTower {
  building: BuildingConfig;
  feature: SkylineFeature;
}

/** Where the tracked tower stands: everything the scene derives once per building and skyline. */
export interface Site {
  building: BuildingConfig;
  /** Footprint in plan metres (x east, y north): CCW, not closed. */
  ring: Vec2[];
  center: Vec2;
  /** Greatest distance from `center` to a footprint corner. */
  radius: number;
  /** Configured height (see configuredHeight). */
  height: number;
  /** The tower's own skyline footprint; null when it stands on the fallback box. */
  feature: SkylineFeature | null;
  /** Every tracked building that has a skyline footprint (this one included), by OSM id. */
  tracked: ReadonlyMap<number, TrackedTower>;
  /** The keys of `tracked`: footprints drawn as towers rather than as part of the context. */
  trackedOsmIds: ReadonlySet<number>;
}

function findFeature(
  building: BuildingConfig,
  features: SkylineFeature[],
): SkylineFeature | undefined {
  return features.find(
    (f) =>
      (building.geometry.osmWayId !== undefined &&
        f.properties.osmId === building.geometry.osmWayId) ||
      f.properties.trackedId === building.id,
  );
}

/**
 * `skyline` null = the skyline file is unavailable: the tower then stands
 * alone, as its fallback box at the origin.
 */
export function resolveSite(
  building: BuildingConfig,
  allBuildings: BuildingConfig[],
  skyline: SkylineCollection | null,
): Site {
  const g = building.geometry;
  const features = skyline ? skyline.features.filter(isBuildingFeature) : [];
  const tracked = new Map<number, TrackedTower>();
  for (const b of allBuildings) {
    const feature = findFeature(b, features);
    if (feature) tracked.set(feature.properties.osmId, { building: b, feature });
  }

  const feature = findFeature(building, features) ?? null;
  const footprint = feature?.geometry.coordinates[0];
  let ring: Vec2[];
  if (footprint && footprint.length >= 3) {
    ring = normalizeRing(footprint);
  } else if (skyline) {
    const [x, y] = makeProjector(skyline.meta.origin).toLocal(building.lon, building.lat);
    ring = makeBoxRing(x, y, g.fallbackWidthM, g.fallbackDepthM);
  } else {
    ring = makeBoxRing(0, 0, g.fallbackWidthM, g.fallbackDepthM);
  }
  const center = ringCentroid(ring);
  const radius = Math.max(...ring.map((p) => Math.hypot(p[0] - center[0], p[1] - center[1])));

  return {
    building,
    ring,
    center,
    radius,
    height: configuredHeight(building),
    feature,
    tracked,
    trackedOsmIds: new Set(tracked.keys()),
  };
}
