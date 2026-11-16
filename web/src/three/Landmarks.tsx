import { Html } from "@react-three/drei";
import { useMemo } from "react";
import type { Vec2 } from "../../../shared/src/placement";
import {
  isBuildingFeature,
  isLineFeature,
  isStationFeature,
  type SkylineCollection,
} from "../../../shared/src/types";
import { planToThree, type SceneTheme } from "./geometry";
import StreetNames from "./StreetNames";

const MAX_STATIONS = 4;
const STATION_RADIUS_M = 1200;
const MAX_BUILDING_LABELS = 5;
const LANDMARK_MIN_HEIGHT_M = 45;
const LANDMARK_RADIUS_M = 450;
/** Closer than this a "landmark" is the tracked tower's own block. */
const LANDMARK_MIN_DISTANCE_M = 40;
const MAX_STREETS = 6;
const STREET_RADIUS_M = 260;

/**
 * Orientation aids around the tracked building: the nearest named CTA
 * stations, the tallest named towers close by, and the names of the streets
 * it stands on. Positions are memoized; station and tower labels are plain
 * drei Html (no draw calls), street names are lettering on the ground.
 */
export default function Landmarks({
  skyline,
  center,
  theme,
  excludeOsmIds,
}: {
  skyline: SkylineCollection;
  /** Scene-local center that every distance is measured from. */
  center: Vec2;
  theme: SceneTheme;
  excludeOsmIds: ReadonlySet<number>;
}) {
  const stations = useMemo(
    () =>
      skyline.features
        .filter(isStationFeature)
        .filter((f) => f.properties.name)
        .map((f) => {
          const [x, y] = f.geometry.coordinates;
          return {
            name: f.properties.name!,
            pos: [x, y] as Vec2,
            d: Math.hypot(x - center[0], y - center[1]),
          };
        })
        .filter((s) => s.d <= STATION_RADIUS_M)
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_STATIONS),
    [skyline, center],
  );

  const landmarks = useMemo(
    () =>
      skyline.features
        .filter(isBuildingFeature)
        .filter(
          (f) =>
            f.properties.name &&
            f.properties.height >= LANDMARK_MIN_HEIGHT_M &&
            !excludeOsmIds.has(f.properties.osmId),
        )
        .map((f) => {
          const ring = f.geometry.coordinates[0]!;
          const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
          const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
          return {
            name: f.properties.name!,
            pos: [cx, cy] as Vec2,
            h: f.properties.height,
            d: Math.hypot(cx - center[0], cy - center[1]),
          };
        })
        .filter((l) => l.d <= LANDMARK_RADIUS_M && l.d > LANDMARK_MIN_DISTANCE_M)
        .sort((a, b) => b.h - a.h)
        .slice(0, MAX_BUILDING_LABELS),
    [skyline, excludeOsmIds, center],
  );

  // Street names: for every named street, the point of its centre-line nearest to the tower.
  const streets = useMemo(() => {
    const best = new Map<string, { name: string; pos: Vec2; dir: Vec2; d: number }>();
    for (const f of skyline.features) {
      if (!isLineFeature(f) || f.properties.kind !== "road" || !f.properties.name) continue;
      if (f.properties.class === "motorway" || f.properties.class === "pedestrian") continue;
      const pts = f.geometry.coordinates;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        if (len2 < 1) continue;
        // Kept off the ends of the segment, where the label would sit on a crossing.
        const t = Math.max(
          0.15,
          Math.min(0.85, ((center[0] - a[0]) * dx + (center[1] - a[1]) * dy) / len2),
        );
        const p: Vec2 = [a[0] + dx * t, a[1] + dy * t];
        const d = Math.hypot(p[0] - center[0], p[1] - center[1]);
        const cur = best.get(f.properties.name);
        if (!cur || d < cur.d) {
          const len = Math.sqrt(len2);
          best.set(f.properties.name, { name: f.properties.name, pos: p, dir: [dx / len, dy / len], d });
        }
      }
    }
    return [...best.values()]
      .filter((s) => s.d <= STREET_RADIUS_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_STREETS);
  }, [skyline, center]);

  return (
    <>
      {stations.map((s) => (
        <group key={`st-${s.name}-${s.pos[0]}`} position={planToThree(s.pos[0], s.pos[1], 0)}>
          <mesh position={[0, 5, 0]}>
            <cylinderGeometry args={[1.4, 1.4, 10, 10]} />
            <meshBasicMaterial color={theme.station} />
          </mesh>
          <mesh position={[0, 10.5, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[2.4, 3.6, 20]} />
            <meshBasicMaterial color={theme.station} side={2} />
          </mesh>
          <Html
            position={[0, 17, 0]}
            center
            style={{
              color: theme.label,
              background: theme.labelBg,
              border: "1px solid rgba(128,128,128,0.25)",
              borderRadius: 999,
              padding: "1px 8px",
              fontSize: 11,
              whiteSpace: "nowrap",
              pointerEvents: "none",
            }}
          >
            ⊙ {s.name}
          </Html>
        </group>
      ))}
      {/* painted on the ground, so buildings in front hide them (see StreetNames) */}
      <StreetNames streets={streets} theme={theme} />
      {landmarks.map((l) => (
        <Html
          key={`lm-${l.name}-${l.pos[0]}`}
          position={planToThree(l.pos[0], l.pos[1], l.h + 18)}
          center
          style={{
            color: theme.label,
            background: theme.labelBg,
            borderRadius: 999,
            padding: "1px 8px",
            fontSize: 11,
            opacity: 0.9,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {l.name}
        </Html>
      ))}
    </>
  );
}
