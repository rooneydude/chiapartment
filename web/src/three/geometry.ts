import * as THREE from "three";
import { isLineFeature } from "../../../shared/src/types";
import type { AnySkylineFeature } from "../../../shared/src/types";
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

export function ringToShape(ring: Vec2[]): THREE.Shape {
  const shape = new THREE.Shape();
  const first = ring[0]!;
  shape.moveTo(first[0], first[1]);
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i]![0], ring[i]![1]);
  shape.closePath();
  return shape;
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

/** Merged line segments for every rail line, just above the ground: one draw call. */
export function buildRailGeometry(
  features: readonly AnySkylineFeature[],
): THREE.BufferGeometry | null {
  const y = 0.35;
  const positions: number[] = [];
  for (const f of features) {
    if (!isLineFeature(f) || f.properties.kind !== "rail") continue;
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

/**
 * What the scene takes from the page's light / dark theme. The city itself
 * is not themed: its look follows the time of day (see atmosphere.ts).
 */
export interface SceneTheme {
  /** Canvas backdrop until the first frame is drawn. */
  background: string;
  /** Crown of the tracked tower and the halo around its base. */
  accent: string;
  slab: string;
  marker: string;
  rail: string;
  station: string;
  label: string;
  labelBg: string;
  /** Hour of the day (Chicago wall clock) the scene is lit for unless the URL asks for another. */
  defaultHour: number;
}

export const LIGHT_THEME: SceneTheme = {
  background: "#dfe8f0",
  accent: "#2a78d6",
  slab: "#2a78d6",
  marker: "#eb6834",
  rail: "#a8a69e",
  station: "#4a3aa7",
  label: "#52514e",
  labelBg: "rgba(252, 252, 251, 0.85)",
  defaultHour: 13,
};

export const DARK_THEME: SceneTheme = {
  background: "#0e1116",
  accent: "#3987e5",
  slab: "#3987e5",
  marker: "#d95926",
  rail: "#3c3c40",
  station: "#9085e9",
  label: "#c3c2b7",
  labelBg: "rgba(26, 26, 25, 0.85)",
  defaultHour: 21,
};
