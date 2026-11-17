import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  normalizeRing,
  pointInRing,
  ringCentroid,
  ringSignedArea,
  type Vec2,
} from "../../../shared/src/placement";
import { isBuildingFeature, type AnySkylineFeature } from "../../../shared/src/types";
import { classFor, roofColor, seedOf, wallColor } from "./facadeMaterial";
import { extrudeRing } from "./geometry";

/**
 * The surrounding city: every skyline building that is not a tracked tower.
 * The builders take the skyline's feature list and return null when it holds
 * nothing for them.
 */

/**
 * All context buildings merged into one geometry (one draw call) for the
 * facade material: vertex colour by material class, and the per-building
 * attribute aBld = (seed, roof height, class, sink flag).
 */
export function buildContextGeometry(
  features: readonly AnySkylineFeature[],
  excludeOsmIds: ReadonlySet<number>,
): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  const wall = new THREE.Color();
  const roof = new THREE.Color();
  for (const f of features) {
    if (!isBuildingFeature(f) || excludeOsmIds.has(f.properties.osmId)) continue;
    const ring = f.geometry.coordinates[0];
    if (!ring || ring.length < 3) continue;
    const h = f.properties.height;
    const zMin = f.properties.minHeight || 0;
    const g = extrudeRing(ring, zMin, Math.max(h, zMin + 1));
    const seed = seedOf(f.properties.osmId);
    const cls = classFor(h, seed);
    wallColor(cls, seed, wall);
    roofColor(seed, roof);
    const pos = g.getAttribute("position");
    const nrm = g.getAttribute("normal");
    const col = new Float32Array(pos.count * 3);
    const bld = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      const c = nrm.getY(i) > 0.5 ? roof : wall;
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      bld[i * 4] = seed;
      bld[i * 4 + 1] = h;
      bld[i * 4 + 2] = cls;
      bld[i * 4 + 3] = 0;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aBld", new THREE.BufferAttribute(bld, 4));
    g.deleteAttribute("uv"); // the facade is drawn in world space
    parts.push(g);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

interface RoofBox {
  cx: number;
  cy: number;
  width: number;
  depth: number;
  height: number;
  /** Roof level of the building it stands on. */
  base: number;
  angle: number;
  seed: number;
}

/**
 * Rooftop plant (mechanical penthouses) on the larger buildings within 900 m
 * of `center`, as one instanced box mesh: one or two per roof, aligned with
 * the footprint's longest edge and kept inside it. Null when there are none.
 */
export function buildRoofBoxes(
  features: readonly AnySkylineFeature[],
  excludeOsmIds: ReadonlySet<number>,
  center: Vec2,
): THREE.InstancedMesh | null {
  const boxes: RoofBox[] = [];
  for (const f of features) {
    if (!isBuildingFeature(f) || excludeOsmIds.has(f.properties.osmId)) continue;
    const h = f.properties.height;
    if (h < 18) continue;
    const raw = f.geometry.coordinates[0];
    if (!raw || raw.length < 3) continue;
    const ring = normalizeRing(raw);
    const c = ringCentroid(ring);
    if (Math.hypot(c[0] - center[0], c[1] - center[1]) > 900) continue;
    let longest = 0;
    let angle = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l > longest) {
        longest = l;
        angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      }
    }
    const area = Math.abs(ringSignedArea(ring));
    if (area < 220) continue;
    const seed = seedOf(f.properties.osmId);
    const count = area > 1600 && seed > 0.35 ? 2 : 1;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let k = 0; k < count; k++) {
      const s1 = (seed * (13.7 + k * 7.1)) % 1;
      const s2 = (seed * (29.3 + k * 3.3)) % 1;
      const side = Math.sqrt(area);
      const width = Math.min(side * (0.22 + 0.16 * s1), 22);
      const depth = Math.min(side * (0.16 + 0.12 * s2), 14);
      const height = 2.6 + 3.4 * s1 + (h > 90 ? 3 : 0);
      const offAlong = count === 1 ? 0 : (k ? 1 : -1) * side * 0.17;
      const offAcross = count === 1 ? 0 : (s2 - 0.5) * side * 0.1;
      const cx = c[0] + cos * offAlong - sin * offAcross;
      const cy = c[1] + sin * offAlong + cos * offAcross;
      const corners: Vec2[] = [
        [-width / 2, -depth / 2],
        [width / 2, -depth / 2],
        [width / 2, depth / 2],
        [-width / 2, depth / 2],
      ];
      const inside = corners.every(([a, b]) =>
        pointInRing([cx + cos * a - sin * b, cy + sin * a + cos * b], ring),
      );
      if (!inside) continue;
      boxes.push({ cx, cy, width, depth, height, base: h, angle, seed });
    }
  }
  if (boxes.length === 0) return null;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshLambertMaterial(),
    boxes.length,
  );
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const color = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  boxes.forEach((box, i) => {
    quat.setFromAxisAngle(up, box.angle);
    matrix.compose(
      new THREE.Vector3(box.cx, box.base + box.height / 2, -box.cy),
      quat,
      new THREE.Vector3(box.width, box.height, box.depth),
    );
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, roofColor(box.seed, color).multiplyScalar(0.9));
  });
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
