import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { pointInRing, type Vec2 } from "../../../shared/src/placement";
import { isAreaFeature, isBuildingFeature, isLineFeature } from "../../../shared/src/types";
import type {
  AnySkylineFeature,
  SkylineFeature,
  SkylineLineFeature,
} from "../../../shared/src/types";
import { ringToShape } from "./geometry";
import { SKY_GLSL, type SkyUniforms } from "./sky";

/**
 * Everything that lies on the ground plane: water and parks, mitred road
 * ribbons for every road class (plus a sidewalk casing), the baked footprint
 * ambient-occlusion texture, street lights and trees. The builders take the
 * skyline's feature list and return null when it holds nothing for them.
 */

type Features = readonly AnySkylineFeature[];

/** Carriageway width in metres by OSM road class; classes not listed are not drawn. */
const ROAD_WIDTH: Readonly<Record<string, number>> = {
  motorway: 15,
  trunk: 14,
  primary: 14,
  secondary: 12,
  tertiary: 10,
  residential: 8,
  pedestrian: 3.5,
};

function roadsOf(features: Features): SkylineLineFeature[] {
  return features.filter(
    (f): f is SkylineLineFeature => isLineFeature(f) && f.properties.kind === "road",
  );
}

function buildingsOf(features: Features): SkylineFeature[] {
  return features.filter(isBuildingFeature);
}

/** Merged flat polygons for water or parks, in the ground plane (y = 0): one draw call per kind. */
export function buildAreaGeometry(
  features: Features,
  kind: "water" | "park",
): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const f of features) {
    if (!isAreaFeature(f) || f.properties.kind !== kind) continue;
    const ring = f.geometry.coordinates[0];
    if (!ring || ring.length < 3) continue;
    const geo = new THREE.ShapeGeometry(ringToShape(ring));
    geo.rotateX(-Math.PI / 2); // shape XY (east/north) -> ground plane
    parts.push(geo);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

/** Water: a rippled mirror of the sky (fresnel-weighted) with a sun glint. */
export function makeWaterMaterial(sky: SkyUniforms): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color: "#3d6470" });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sky);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vWPos;\n${SKY_GLSL}`)
      .replace(
        "#include <opaque_fragment>",
        /* glsl */ `{
          vec3 V = normalize(cameraPosition - vWPos);
          vec2 p = vWPos.xz * 0.35;
          vec3 N = normalize(vec3(sin(p.x * 1.7 + p.y * 0.6) * 0.035 + sin(p.y * 2.9 - p.x) * 0.02, 1.0, cos(p.y * 1.3 - p.x * 0.8) * 0.035));
          vec3 R = reflect(-V, N);
          float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
          vec3 env = skyGradient(vec3(R.x, max(R.y, 0.0), R.z)) + skyGlow(R) * 2.0;
          outgoingLight = mix(outgoingLight, env, fres * 0.85) + uSunColor * pow(max(dot(R, uSunDir), 0.0), 220.0) * 2.5;
        }
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => "water";
  return material;
}

/**
 * Mitred triangle strips along the road centre-lines, in the ground plane.
 * `grow` widens every class by that many metres (used for the sidewalk casing).
 */
export function buildRoadStrips(features: Features, grow = 0): THREE.BufferGeometry | null {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const f of roadsOf(features)) {
    const width = ROAD_WIDTH[f.properties.class];
    if (!width) continue;
    const half = (width + grow) / 2;
    const pts = f.geometry.coordinates;
    if (pts.length < 2) continue;
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const a = pts[Math.max(i - 1, 0)]!;
      const b = pts[Math.min(i + 1, pts.length - 1)]!;
      // averaged direction -> mitre normal; scale by 1/cos(half angle),
      // clamped so hairpins don't spike
      let d1x = p[0] - a[0];
      let d1y = p[1] - a[1];
      let d2x = b[0] - p[0];
      let d2y = b[1] - p[1];
      const l1 = Math.hypot(d1x, d1y);
      const l2 = Math.hypot(d2x, d2y);
      if (l1 > 0) {
        d1x /= l1;
        d1y /= l1;
      } else {
        d1x = d2x / (l2 || 1);
        d1y = d2y / (l2 || 1);
      }
      if (l2 > 0) {
        d2x /= l2;
        d2y /= l2;
      } else {
        d2x = d1x;
        d2y = d1y;
      }
      let tx = d1x + d2x;
      let ty = d1y + d2y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const cosHalf = Math.max(tx * d1x + ty * d1y, 0.5);
      const nx = (-ty * half) / cosHalf;
      const ny = (tx * half) / cosHalf;
      pos.push(p[0] + nx, 0, -(p[1] + ny), p[0] - nx, 0, -(p[1] - ny));
      if (i > 0) {
        const k = base + (i - 1) * 2;
        idx.push(k, k + 1, k + 3, k, k + 3, k + 2);
      }
    }
  }
  if (pos.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Footprint ambient occlusion baked on a 2D canvas: every footprint is filled
 * with a blurred drop shadow (canvas shadowBlur works in every browser, unlike
 * ctx.filter). Drawn as ONE multiply-blended quad over the ground layers ->
 * buildings sit ON the ground instead of floating. `sizeM` metres square,
 * centred on `center`. Null when the browser gives no 2D canvas.
 */
export function makeGroundAO(
  features: Features,
  center: Vec2,
  opts: { sizeM: number; px: number; heightOf: (f: SkylineFeature) => number },
): THREE.CanvasTexture | null {
  const { sizeM, px, heightOf } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, px, px);
  const s = px / sizeM;
  const X = (x: number): number => (x - center[0]) * s + px / 2;
  const Y = (y: number): number => px / 2 - (y - center[1]) * s; // canvas y down = south
  const OFF = px * 2; // draw the shape off-canvas and keep only its shadow
  const buildings = buildingsOf(features);
  const pass = (blurM: number, alpha: number, minH: number): void => {
    for (const f of buildings) {
      const h = heightOf(f);
      if (h < minH) continue;
      const ring = f.geometry.coordinates[0];
      if (!ring || ring.length === 0) continue;
      let cx = 0;
      let cy = 0;
      for (const p of ring) {
        cx += p[0];
        cy += p[1];
      }
      cx /= ring.length;
      cy /= ring.length;
      const outside =
        Math.abs(cx - center[0]) > sizeM * 0.6 || Math.abs(cy - center[1]) > sizeM * 0.6;
      if (outside) continue;
      ctx.shadowColor = `rgba(20,22,30,${alpha * Math.min(1, 0.45 + h / 60)})`;
      ctx.shadowBlur = blurM * s;
      ctx.shadowOffsetX = OFF;
      ctx.shadowOffsetY = 0;
      ctx.beginPath();
      ring.forEach((p, i) => {
        if (i) ctx.lineTo(X(p[0]) - OFF, Y(p[1]));
        else ctx.moveTo(X(p[0]) - OFF, Y(p[1]));
      });
      ctx.closePath();
      ctx.fill();
    }
  };
  ctx.fillStyle = "#000";
  pass(22, 0.42, 12); // wide, soft: tall buildings occlude a lot of sky
  pass(5, 0.5, 0); // tight contact shadow at every base
  // fade to white at the border so the quad has no visible edge
  ctx.shadowColor = "transparent";
  const grad = ctx.createRadialGradient(px / 2, px / 2, px * 0.36, px / 2, px / 2, px * 0.5);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(1, "rgba(255,255,255,1)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, px, px);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Soft radial sprite used by street-light halos and their pools of light.
 * Null when the browser gives no 2D canvas.
 */
export function makeGlowTexture(): THREE.CanvasTexture | null {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.55)");
  g.addColorStop(0.6, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Distance between street lamps along a road, in metres. */
const LAMP_SPACING_M = 36;

/** Lamp positions (plan metres): every LAMP_SPACING_M along the lit road classes, alternating sides. */
export function streetLightPositions(features: Features): Vec2[] {
  const spacing = LAMP_SPACING_M;
  const out: Vec2[] = [];
  let k = 0;
  for (const f of roadsOf(features)) {
    const cls = f.properties.class;
    const w = ROAD_WIDTH[cls];
    if (!w || cls === "pedestrian" || cls === "motorway") continue;
    const pts = f.geometry.coordinates;
    let carry = (k * 13) % spacing;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) continue;
      const dx = (b[0] - a[0]) / len;
      const dy = (b[1] - a[1]) / len;
      let t = spacing - carry;
      while (t <= len) {
        const side = k++ % 2 ? 1 : -1;
        const off = (w / 2 + 0.8) * side;
        out.push([a[0] + dx * t - dy * off, a[1] + dy * t + dx * off]);
        t += spacing;
      }
      carry = (carry + len) % spacing;
    }
  }
  return out;
}

/** One ground-plane quad of side 2 x radius per lamp, textured 0..1: the pool of light under it. */
export function buildLightPoolGeometry(lamps: Vec2[], radius: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  lamps.forEach(([x, n], i) => {
    const b = i * 4;
    pos.push(
      x - radius, 0, -(n - radius),
      x + radius, 0, -(n - radius),
      x + radius, 0, -(n + radius),
      x - radius, 0, -(n + radius),
    );
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Small seeded PRNG: tree placement must be the same on every load. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ringBounds(ring: Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1e9;
  let y1 = -1e9;
  for (const p of ring) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return { x0, y0, x1, y1 };
}

/** A tree: plan position (x east, y north) and a size factor around 1. */
type TreeSpot = [x: number, y: number, scale: number];

const TREE_RADIUS_M = 800;
const MAX_TREES = 2600;

/**
 * Tree positions within TREE_RADIUS_M of `center`: scattered in parks and
 * lining residential / tertiary streets, never inside a footprint.
 */
function treePositions(features: Features, center: Vec2): TreeSpot[] {
  const rand = mulberry32(1337);
  // Footprints bucketed on a coarse grid, so "is this spot inside a building" tests few rings.
  const cellSize = 60;
  const grid = new Map<number, Vec2[][]>();
  const key = (cx: number, cy: number): number => cx * 100003 + cy;
  for (const f of buildingsOf(features)) {
    const ring = f.geometry.coordinates[0];
    if (!ring) continue;
    const { x0, y0, x1, y1 } = ringBounds(ring);
    for (let cx = Math.floor(x0 / cellSize); cx <= Math.floor(x1 / cellSize); cx++) {
      for (let cy = Math.floor(y0 / cellSize); cy <= Math.floor(y1 / cellSize); cy++) {
        const k = key(cx, cy);
        const cell = grid.get(k);
        if (cell) cell.push(ring);
        else grid.set(k, [ring]);
      }
    }
  }
  const blocked = (x: number, y: number): boolean => {
    const rings = grid.get(key(Math.floor(x / cellSize), Math.floor(y / cellSize)));
    return rings ? rings.some((r) => pointInRing([x, y], r)) : false;
  };
  const near = (x: number, y: number): boolean =>
    Math.hypot(x - center[0], y - center[1]) < TREE_RADIUS_M;
  const out: TreeSpot[] = [];
  for (const f of features) {
    if (!isAreaFeature(f) || f.properties.kind !== "park") continue;
    const ring = f.geometry.coordinates[0];
    if (!ring) continue;
    const { x0, y0, x1, y1 } = ringBounds(ring);
    const tries = Math.min(((x1 - x0) * (y1 - y0)) / 110, 500);
    for (let i = 0; i < tries; i++) {
      const x = x0 + rand() * (x1 - x0);
      const y = y0 + rand() * (y1 - y0);
      if (near(x, y) && pointInRing([x, y], ring) && !blocked(x, y)) {
        out.push([x, y, 0.8 + rand() * 0.7]);
      }
    }
  }
  for (const f of roadsOf(features)) {
    const cls = f.properties.class;
    if (cls !== "residential" && cls !== "tertiary") continue;
    const w = ROAD_WIDTH[cls]!;
    const pts = f.geometry.coordinates;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 20) continue;
      const dx = (b[0] - a[0]) / len;
      const dy = (b[1] - a[1]) / len;
      for (let t = 9 + rand() * 6; t < len - 9; t += 11 + rand() * 8) {
        for (const side of [-1, 1]) {
          if (rand() < 0.3) continue;
          const off = (w / 2 + 2.1) * side;
          const x = a[0] + dx * t - dy * off;
          const y = a[1] + dy * t + dx * off;
          if (near(x, y) && !blocked(x, y)) out.push([x, y, 0.6 + rand() * 0.5]);
        }
      }
    }
  }
  return out.length > MAX_TREES ? out.sort(() => rand() - 0.5).slice(0, MAX_TREES) : out;
}

const TREE_GREENS = ["#7d9a68", "#88a672", "#718c5e"] as const;

/** The trees as one instanced low-poly crown each; null when there are none. */
export function buildTrees(features: Features, center: Vec2): THREE.InstancedMesh | null {
  const trees = treePositions(features, center);
  if (trees.length === 0) return null;
  const mesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshLambertMaterial({ flatShading: true }),
    trees.length,
  );
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const color = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  trees.forEach(([x, y, scale], i) => {
    const r = 2.7 * scale;
    quat.setFromAxisAngle(up, i * 2.4);
    matrix.compose(
      new THREE.Vector3(x, 3.2 + r * 1.05, -y),
      quat,
      new THREE.Vector3(r, r * 1.25, r),
    );
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, color.set(TREE_GREENS[i % 3]!));
  });
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
