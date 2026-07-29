/**
 * Local ENU (East / North / Up) projection.
 *
 * Everything in the 3D scene is expressed in metres relative to a per-scene
 * origin (usually the subject building). At Chicago's latitude a local
 * equirectangular projection is accurate to well under a metre over the ~15 km
 * of skyline that is actually visible from a window, which is far below the
 * precision of the massing data itself.
 */

export const EARTH_RADIUS_M = 6_378_137;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Local metres. `x` is east, `y` is north. Height is tracked separately. */
export interface Vec2 {
  x: number;
  y: number;
}

export const DEG = Math.PI / 180;

/** Metres per degree of longitude at a given latitude. */
export function metresPerDegreeLng(lat: number): number {
  return EARTH_RADIUS_M * DEG * Math.cos(lat * DEG);
}

/** Metres per degree of latitude (constant enough for a city). */
export function metresPerDegreeLat(): number {
  return EARTH_RADIUS_M * DEG;
}

/** Project a lat/lng into local metres relative to `origin`. */
export function toLocal(point: LatLng, origin: LatLng): Vec2 {
  return {
    x: (point.lng - origin.lng) * metresPerDegreeLng(origin.lat),
    y: (point.lat - origin.lat) * metresPerDegreeLat(),
  };
}

/** Inverse of {@link toLocal}. */
export function toLatLng(local: Vec2, origin: LatLng): LatLng {
  return {
    lat: origin.lat + local.y / metresPerDegreeLat(),
    lng: origin.lng + local.x / metresPerDegreeLng(origin.lat),
  };
}

/** Great-circle-ish distance in metres. Flat-earth is fine at city scale. */
export function distanceM(a: LatLng, b: LatLng): number {
  const d = toLocal(b, a);
  return Math.hypot(d.x, d.y);
}

/**
 * Compass bearing in degrees from `from` to `to`.
 * 0 = north, 90 = east, 180 = south, 270 = west.
 */
export function bearingDeg(from: LatLng, to: LatLng): number {
  const d = toLocal(to, from);
  return normalizeDeg((Math.atan2(d.x, d.y) / DEG));
}

export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Smallest signed angle from `a` to `b`, in (-180, 180]. */
export function angleDeltaDeg(a: number, b: number): number {
  let d = normalizeDeg(b - a);
  if (d > 180) d -= 360;
  return d;
}

/** Unit vector in local metres pointing along a compass bearing. */
export function bearingToVec(deg: number): Vec2 {
  const r = deg * DEG;
  return { x: Math.sin(r), y: Math.cos(r) };
}

const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

export type CompassPoint = (typeof COMPASS_POINTS)[number];

export function compassPoint(deg: number): CompassPoint {
  const i = Math.round(normalizeDeg(deg) / 22.5) % 16;
  return COMPASS_POINTS[i];
}

/** Signed area of a polygon in local metres. Positive = counter-clockwise. */
export function signedArea(ring: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function polygonArea(ring: Vec2[]): number {
  return Math.abs(signedArea(ring));
}

/** Ensure counter-clockwise winding (what three.js Shape expects). */
export function ensureCCW(ring: Vec2[]): Vec2[] {
  return signedArea(ring) < 0 ? [...ring].reverse() : ring;
}

export function centroid(ring: Vec2[]): Vec2 {
  const a = signedArea(ring);
  if (Math.abs(a) < 1e-9) {
    // Degenerate ring — fall back to the vertex mean.
    const sum = ring.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: sum.x / ring.length, y: sum.y / ring.length };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const cross = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/**
 * Offset a convex-ish polygon inward by `d` metres, used for building setbacks.
 * Each vertex is pulled toward the centroid proportionally, which is stable for
 * the roughly-rectangular floor plates that towers actually use and never
 * self-intersects the way a true straight-skeleton offset can.
 */
export function insetTowardCentroid(ring: Vec2[], d: number): Vec2[] {
  if (d <= 0) return ring;
  const c = centroid(ring);
  return ring.map((p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const len = Math.hypot(dx, dy);
    if (len <= d) return { ...c };
    const k = (len - d) / len;
    return { x: c.x + dx * k, y: c.y + dy * k };
  });
}

/** Axis-aligned bounds of a ring. */
export function bounds(ring: Vec2[]) {
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/** Outward-facing compass bearing of the edge from `a` to `b` of a CCW ring. */
export function edgeOutwardBearing(a: Vec2, b: Vec2): number {
  // For a counter-clockwise ring the outward normal of edge a→b is (dy, -dx).
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return normalizeDeg(Math.atan2(dy, -dx) / DEG);
}

/** Ray/segment intersection used by the view occlusion solver. */
export function raySegmentT(
  origin: Vec2,
  dir: Vec2,
  p: Vec2,
  q: Vec2,
): number | null {
  const sx = q.x - p.x;
  const sy = q.y - p.y;
  const denom = dir.x * sy - dir.y * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const ox = p.x - origin.x;
  const oy = p.y - origin.y;
  const t = (ox * sy - oy * sx) / denom;
  const u = (ox * dir.y - oy * dir.x) / denom;
  if (t < 0 || u < 0 || u > 1) return null;
  return t;
}
