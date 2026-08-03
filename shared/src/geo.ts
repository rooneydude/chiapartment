/**
 * Local tangent-plane projection: good to well under a meter of error at the
 * few-km scale this project cares about. Used by BOTH the skyline generator
 * and the frontend so coordinates always agree.
 */

export interface LonLat {
  lon: number;
  lat: number;
}

const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LON_EQUATOR = 111320;

export interface Projector {
  origin: LonLat;
  /** lon/lat → [x east, y north] meters */
  toLocal(lon: number, lat: number): [number, number];
  /** [x east, y north] meters → [lon, lat] */
  fromLocal(x: number, y: number): [number, number];
}

export function makeProjector(origin: LonLat): Projector {
  const mLon = METERS_PER_DEG_LON_EQUATOR * Math.cos((origin.lat * Math.PI) / 180);
  return {
    origin,
    toLocal(lon, lat) {
      return [(lon - origin.lon) * mLon, (lat - origin.lat) * METERS_PER_DEG_LAT];
    },
    fromLocal(x, y) {
      return [origin.lon + x / mLon, origin.lat + y / METERS_PER_DEG_LAT];
    },
  };
}

/** Great-circle-ish distance in meters, adequate at city scale. */
export function distanceM(a: LonLat, b: LonLat): number {
  const p = makeProjector(a);
  const [x, y] = p.toLocal(b.lon, b.lat);
  return Math.hypot(x, y);
}
