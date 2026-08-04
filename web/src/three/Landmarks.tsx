import { Html } from "@react-three/drei";
import { useMemo } from "react";
import type { Vec2 } from "../../../shared/src/placement";
import {
  isBuildingFeature,
  isStationFeature,
  type SkylineCollection,
} from "../../../shared/src/types";
import { planToThree, type SceneTheme } from "./geometry";

const MAX_STATIONS = 12;
const MAX_BUILDING_LABELS = 8;
const LANDMARK_MIN_HEIGHT_M = 80;

/**
 * Orientation aids: named CTA stations near the tracked building and labels
 * on the tallest named towers. Positions are memoized; labels are plain drei
 * Html so they cost no draw calls.
 */
export default function Landmarks({
  skyline,
  center,
  theme,
  excludeOsmIds,
}: {
  skyline: SkylineCollection;
  /** Scene-local center to rank station proximity against. */
  center: Vec2;
  theme: SceneTheme;
  excludeOsmIds: Set<number>;
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
        .sort((a, b) => b.properties.height - a.properties.height)
        .slice(0, MAX_BUILDING_LABELS)
        .map((f) => {
          const ring = f.geometry.coordinates[0]!;
          const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
          const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
          return { name: f.properties.name!, pos: [cx, cy] as Vec2, h: f.properties.height };
        }),
    [skyline, excludeOsmIds],
  );

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
