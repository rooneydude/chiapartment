import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { isAreaFeature, isBuildingFeature, isLineFeature } from "../../../shared/src/types";
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
 *
 * Per-feature vertex colors give the massing subtle variation (lightness
 * jittered by osmId, tall towers tinted slightly cooler) while keeping the
 * single draw call — use a material with `vertexColors` enabled.
 */
export function buildContextGeometry(
  skyline: SkylineCollection,
  excludeOsmIds: Set<number>,
  heightOverrides: Map<number, number>,
  baseColor: string,
): THREE.BufferGeometry | null {
  const base = new THREE.Color(baseColor);
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);

  const parts: THREE.BufferGeometry[] = [];
  for (const f of skyline.features) {
    if (!isBuildingFeature(f)) continue; // v2 files carry areas/roads/stations too
    if (excludeOsmIds.has(f.properties.osmId)) continue;
    const height = heightOverrides.get(f.properties.osmId) ?? f.properties.height;
    const geo = extrudeFeature(f, height);
    if (!geo) continue;

    // Deterministic per-building jitter; taller → a touch cooler and darker.
    const jitter = (((f.properties.osmId * 2654435761) >>> 16) % 1000) / 1000 - 0.5;
    const tall = Math.min(height / 220, 1);
    const c = new THREE.Color().setHSL(
      hsl.h + tall * 0.02,
      hsl.s + tall * 0.04,
      Math.min(Math.max(hsl.l + jitter * 0.07 - tall * 0.03, 0), 1),
    );
    const pos = geo.getAttribute("position");
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      // Fake ambient occlusion: darken toward street level so buildings
      // visually seat into the ground.
      const ao = 0.72 + 0.28 * Math.min(Math.max(pos.getY(i) / 9, 0), 1);
      colors[i * 3] = c.r * ao;
      colors[i * 3 + 1] = c.g * ao;
      colors[i * 3 + 2] = c.b * ao;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    parts.push(geo);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

/** Merged flat polygons for water or parks — one draw call per kind. */
export function buildAreaGeometry(
  skyline: SkylineCollection,
  kind: "water" | "park",
): THREE.BufferGeometry | null {
  const y = kind === "water" ? 0.05 : 0.08;
  const parts: THREE.BufferGeometry[] = [];
  for (const f of skyline.features) {
    if (!isAreaFeature(f) || f.properties.kind !== kind) continue;
    const ring = f.geometry.coordinates[0];
    if (!ring || ring.length < 3) continue;
    const geo = new THREE.ShapeGeometry(ringToShape(ring as Vec2[]));
    geo.rotateX(-Math.PI / 2); // shape XY (east/north) → ground plane
    geo.translate(0, y, 0);
    parts.push(geo);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

const RIBBON_CLASSES: Record<string, number> = {
  motorway: 10,
  trunk: 9,
  primary: 8,
  secondary: 6,
};

/**
 * Major roads as flat ribbons (merged triangles): far more readable than
 * hairlines from orbit height. Minor roads stay in the line layer.
 */
export function buildRoadRibbonGeometry(skyline: SkylineCollection): THREE.BufferGeometry | null {
  const y = 0.12;
  const positions: number[] = [];
  for (const f of skyline.features) {
    if (!isLineFeature(f) || f.properties.kind !== "road") continue;
    const width = RIBBON_CLASSES[f.properties.class];
    if (!width) continue;
    const pts = f.geometry.coordinates;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]!;
      const [bx, by] = pts[i]!;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * (width / 2);
      const ny = (dx / len) * (width / 2);
      // Two triangles per segment, in three-space (x, y, -north).
      const quad = [
        [ax + nx, ay + ny],
        [ax - nx, ay - ny],
        [bx - nx, by - ny],
        [bx + nx, by + ny],
      ];
      const [p0, p1, p2, p3] = quad as [number, number][];
      positions.push(
        p0![0], y, -p0![1], p1![0], y, -p1![1], p2![0], y, -p2![1],
        p0![0], y, -p0![1], p2![0], y, -p2![1], p3![0], y, -p3![1],
      );
    }
  }
  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
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

/** Soft radial gradient for the ground disc (center → horizon). */
export function makeGroundTexture(inner: string, outer: string): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface SceneTheme {
  background: string;
  fog: string;
  ground: string;
  groundEdge: string;
  context: string;
  contextTracked: string;
  accent: string;
  outline: string;
  slab: string;
  marker: string;
  road: string;
  roadRibbon: string;
  rail: string;
  station: string;
  label: string;
  labelBg: string;
  water: string;
  park: string;
  /** Whether the drei Sky shader should render (day look). */
  sky: boolean;
}

export const LIGHT_THEME: SceneTheme = {
  background: "#dfe8f0",
  fog: "#dfe8f0",
  ground: "#e9e7e1",
  groundEdge: "#d5d2c8",
  context: "#d3d2ca",
  contextTracked: "#a8b6c8",
  accent: "#2a78d6",
  outline: "#1c5cab",
  slab: "#2a78d6",
  marker: "#eb6834",
  road: "#c9c8c0",
  roadRibbon: "#dcdad2",
  rail: "#a8a69e",
  station: "#4a3aa7",
  label: "#52514e",
  labelBg: "rgba(252, 252, 251, 0.85)",
  water: "#a9c7e0",
  park: "#c4d6b5",
  sky: true,
};

export const DARK_THEME: SceneTheme = {
  background: "#0e1116",
  fog: "#12151b",
  ground: "#181a18",
  groundEdge: "#0e100e",
  context: "#2e2f2c",
  contextTracked: "#3d4b5c",
  accent: "#3987e5",
  outline: "#6da7ec",
  slab: "#3987e5",
  marker: "#d95926",
  road: "#23252a",
  roadRibbon: "#26292f",
  rail: "#3c3c40",
  station: "#9085e9",
  label: "#c3c2b7",
  labelBg: "rgba(26, 26, 25, 0.85)",
  water: "#1d3247",
  park: "#22301f",
  sky: false,
};
