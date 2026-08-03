import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { isBuildingFeature, isLineFeature } from "../../../shared/src/types";
import type { SkylineCollection, SkylineFeature } from "../../../shared/src/types";
import type { Vec2 } from "../../../shared/src/placement";

/**
 * Plan coordinates are x=east, y=north, z=up (shared/placement.ts).
 * three.js is y-up. Building the extrusion in shape-XY (east/north) and
 * rotating -90° about X maps (x, north, up) → (x, up, -north).
 */
export const planToThree = (x: number, y: number, z: number): [number, number, number] => [
  x,
  z,
  -y,
];

function ringToShape(ring: Vec2[]): THREE.Shape {
  const shape = new THREE.Shape();
  const first = ring[0]!;
  shape.moveTo(first[0], first[1]);
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i]![0], ring[i]![1]);
  shape.closePath();
  return shape;
}

export function extrudeFeature(
  feature: SkylineFeature,
  heightOverride?: number,
): THREE.BufferGeometry | null {
  const ring = feature.geometry.coordinates[0];
  if (!ring || ring.length < 3) return null;
  const { minHeight } = feature.properties;
  const height = heightOverride ?? feature.properties.height;
  const depth = Math.max(height - minHeight, 1);
  const geo = new THREE.ExtrudeGeometry(ringToShape(ring as Vec2[]), {
    depth,
    bevelEnabled: false,
  });
  if (minHeight > 0) geo.translate(0, 0, minHeight);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Extrude a plain ring (plan meters) from zMin to zMax. */
export function extrudeRing(ring: Vec2[], zMin: number, zMax: number): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(ringToShape(ring), {
    depth: Math.max(zMax - zMin, 0.5),
    bevelEnabled: false,
  });
  if (zMin !== 0) geo.translate(0, 0, zMin);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/**
 * One merged geometry for all non-highlighted skyline buildings: 1 draw call.
 * `heightOverrides` (osmId → meters) corrects OSM's stale heights for other
 * tracked towers so they don't render squat in each other's scenes.
 */
export function buildContextGeometry(
  skyline: SkylineCollection,
  excludeOsmIds: Set<number>,
  heightOverrides: Map<number, number>,
): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const f of skyline.features) {
    if (!isBuildingFeature(f)) continue; // v2 files carry roads/stations too
    if (excludeOsmIds.has(f.properties.osmId)) continue;
    const geo = extrudeFeature(f, heightOverrides.get(f.properties.osmId));
    if (geo) parts.push(geo);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * Merged line-segment geometry for roads or rail: one draw call per kind.
 * Roads hover just above the ground plane, rail slightly higher.
 */
export function buildLineGeometry(
  skyline: SkylineCollection,
  kind: "road" | "rail",
): THREE.BufferGeometry | null {
  const y = kind === "rail" ? 0.35 : 0.15;
  const positions: number[] = [];
  for (const f of skyline.features) {
    if (!isLineFeature(f) || f.properties.kind !== kind) continue;
    const pts = f.geometry.coordinates;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]!;
      const [bx, by] = pts[i]!;
      positions.push(ax, y, -ay, bx, y, -by); // planToThree inline
    }
  }
  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geo;
}

export interface SceneTheme {
  background: string;
  ground: string;
  context: string;
  contextTracked: string;
  accent: string;
  slab: string;
  marker: string;
  road: string;
  rail: string;
  station: string;
  label: string;
}

export const LIGHT_THEME: SceneTheme = {
  background: "#eef1f4",
  ground: "#e7e6e0",
  context: "#cfcec7",
  contextTracked: "#a8b6c8",
  accent: "#2a78d6",
  slab: "#2a78d6",
  marker: "#eb6834",
  road: "#c6c5be",
  rail: "#a09e96",
  station: "#4a3aa7",
  label: "#52514e",
};

export const DARK_THEME: SceneTheme = {
  background: "#101113",
  ground: "#191a18",
  context: "#33332f",
  contextTracked: "#3d4b5c",
  accent: "#3987e5",
  slab: "#3987e5",
  marker: "#d95926",
  road: "#26262a",
  rail: "#3c3c40",
  station: "#9085e9",
  label: "#c3c2b7",
};
