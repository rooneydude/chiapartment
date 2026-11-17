import * as THREE from "three";
import { ringCentroid, type Vec2, type Vec3 } from "../../../shared/src/placement";

/**
 * The orbit camera's "home": the whole tower in frame, seen from the side
 * where the neighbours hide least of it. All inputs are plan metres
 * (x east, y north, z up).
 */

/** A building that can stand between the camera and the tower. */
export interface Occluder {
  ring: Vec2[];
  height: number;
}

interface FacadeSample {
  x: number;
  y: number;
  z: number;
  /** Outward normal of the facade the sample sits on. */
  nx: number;
  ny: number;
}

/**
 * Returns a function giving the share (0..1) of the camera-facing envelope of
 * the tower (footprint `ring`, `height` tall) that a camera at plan position
 * `cam` can see past the occluders.
 */
export function makeVisibility(
  ring: Vec2[],
  height: number,
  occluders: Occluder[],
): (cam: Vec3) => number {
  const c = ringCentroid(ring);
  // Sample points on every facade: one column per ~10 m of edge, six heights each.
  const samples: FacadeSample[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1) continue;
    const nx = (q[1] - p[1]) / L;
    const ny = -(q[0] - p[0]) / L;
    const n = Math.max(1, Math.round(L / 10));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      for (let j = 0; j < 6; j++) {
        samples.push({
          x: p[0] + (q[0] - p[0]) * t + nx * 0.5,
          y: p[1] + (q[1] - p[1]) * t + ny * 0.5,
          z: (height * (j + 0.5)) / 6,
          nx,
          ny,
        });
      }
    }
  }
  // Only buildings within 700 m matter; keep their bounding boxes for a cheap reject.
  const near = occluders
    .map((o) => {
      let x0 = 1e9;
      let y0 = 1e9;
      let x1 = -1e9;
      let y1 = -1e9;
      for (const p of o.ring) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
      return { ...o, x0, y0, x1, y1 };
    })
    .filter((o) => Math.hypot((o.x0 + o.x1) / 2 - c[0], (o.y0 + o.y1) / 2 - c[1]) < 700);
  const blocked = (cam: Vec3, s: FacadeSample): boolean => {
    for (const o of near) {
      if (
        o.x1 < Math.min(cam[0], s.x) ||
        o.x0 > Math.max(cam[0], s.x) ||
        o.y1 < Math.min(cam[1], s.y) ||
        o.y0 > Math.max(cam[1], s.y)
      ) {
        continue;
      }
      // Where the sight line crosses the footprint in plan, as fractions of camera -> sample ...
      const ts: number[] = [];
      const rx = s.x - cam[0];
      const ry = s.y - cam[1];
      for (let i = 0; i < o.ring.length; i++) {
        const p = o.ring[i]!;
        const q = o.ring[(i + 1) % o.ring.length]!;
        const sx = q[0] - p[0];
        const sy = q[1] - p[1];
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((p[0] - cam[0]) * sy - (p[1] - cam[1]) * sx) / den;
        const u = ((p[0] - cam[0]) * ry - (p[1] - cam[1]) * rx) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
      }
      ts.sort((a, b) => a - b);
      if (ts.length % 2) ts.push(1);
      // ... and whether the line is below the roof anywhere inside it.
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const z0 = cam[2] + (s.z - cam[2]) * ts[i]!;
        const z1 = cam[2] + (s.z - cam[2]) * ts[i + 1]!;
        if (Math.min(z0, z1) < o.height) return true;
      }
    }
    return false;
  };
  return (cam) => {
    let visible = 0;
    let facing = 0;
    for (const s of samples) {
      if ((cam[0] - s.x) * s.nx + (cam[1] - s.y) * s.ny <= 0) continue;
      facing++;
      if (!blocked(cam, s)) visible++;
    }
    return facing ? visible / facing : 0;
  };
}

export interface HomeView {
  /** Camera position and look-at point, in three-space. */
  position: THREE.Vector3;
  target: THREE.Vector3;
}

export interface HomeViewOptions {
  /** Panel width / height. */
  aspect: number;
  /** Vertical field of view of the camera, in degrees. */
  fovDeg: number;
  /** Compass azimuth of the sun (degrees) and how far into the night it is (0..1). */
  sunAzDeg: number;
  night: number;
}

/** Elevation of the home camera above the tower's mid-height, in degrees. */
const HOME_ELEVATION_DEG = 24;

/**
 * Best orbit "home" for a tower (footprint centre `center`, circumradius
 * `radius`, `height` tall): the whole tower framed, from the azimuth with the
 * least occlusion, with a mild preference for the sun-lit side by day.
 */
export function findHomeView(
  tower: { center: Vec2; radius: number; height: number },
  visibility: (cam: Vec3) => number,
  { aspect, fovDeg, sunAzDeg, night }: HomeViewOptions,
): HomeView {
  const { center, height } = tower;
  const bound = 0.5 * Math.hypot(height, 2 * tower.radius);
  const vHalf = THREE.MathUtils.degToRad(fovDeg / 2);
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  const dist = (bound / Math.sin(Math.min(vHalf, hHalf))) * 1.2;
  const el = THREE.MathUtils.degToRad(HOME_ELEVATION_DEG);
  const camAt = (azDeg: number): Vec3 => {
    const a = THREE.MathUtils.degToRad(azDeg);
    return [
      center[0] + Math.sin(a) * Math.cos(el) * dist,
      center[1] + Math.cos(a) * Math.cos(el) * dist,
      height * 0.5 + Math.sin(el) * dist,
    ];
  };
  let best = -1;
  let az = 135;
  for (let k = 0; k < 24; k++) {
    const a = k * 15;
    const sunBias =
      0.08 * Math.cos(THREE.MathUtils.degToRad(a - (sunAzDeg + 35))) * (night < 0.5 ? 1 : 0);
    const score = visibility(camAt(a)) + sunBias;
    if (score > best) {
      best = score;
      az = a;
    }
  }
  const p = camAt(az);
  return {
    position: new THREE.Vector3(p[0], p[2], -p[1]),
    target: new THREE.Vector3(center[0], height * 0.5, -center[1]),
  };
}
