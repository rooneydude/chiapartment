/**
 * Compact NOAA-style solar position math — enough accuracy (±0.5°) for
 * "which way does the light come from" affordances, no dependency needed.
 */

const RAD = Math.PI / 180;

function toDays(date: Date): number {
  return date.getTime() / 86400e3 - 0.5 + 2440588 - 2451545; // days since J2000
}

function solarMeanAnomaly(d: number): number {
  return RAD * (357.5291 + 0.98560028 * d);
}

function eclipticLongitude(M: number): number {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = RAD * 102.9372; // perihelion of Earth
  return M + C + P + Math.PI;
}

const OBLIQUITY = RAD * 23.4397;

function declination(L: number): number {
  return Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
}

function rightAscension(L: number): number {
  return Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L));
}

function siderealTime(d: number, lw: number): number {
  return RAD * (280.16 + 360.9856235 * d) - lw;
}

export interface SunPosition {
  /** Compass azimuth in degrees: 0 = N, 90 = E. */
  azimuthDeg: number;
  /** Altitude above the horizon in degrees; negative = below. */
  altitudeDeg: number;
}

export function sunPosition(date: Date, lat: number, lon: number): SunPosition {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const ra = rightAscension(L);
  const H = siderealTime(d, lw) - ra;

  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H),
  );
  // Astronomers' azimuth (0 = south, westward positive) → compass bearing.
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const azimuthDeg = ((az / RAD + 180) % 360 + 360) % 360;
  return { azimuthDeg, altitudeDeg: altitude / RAD };
}

/**
 * Approximate sunrise/sunset compass azimuths for a date by sampling the
 * day's sun track and taking the horizon crossings.
 */
export function sunriseSunsetAzimuths(
  date: Date,
  lat: number,
  lon: number,
): { sunriseAz: number; sunsetAz: number } | null {
  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  let sunriseAz: number | null = null;
  let sunsetAz: number | null = null;
  let prev = sunPosition(dayStart, lat, lon);
  for (let minutes = 5; minutes <= 1440; minutes += 5) {
    const t = new Date(dayStart.getTime() + minutes * 60e3);
    const cur = sunPosition(t, lat, lon);
    if (prev.altitudeDeg <= 0 && cur.altitudeDeg > 0) sunriseAz = cur.azimuthDeg;
    if (prev.altitudeDeg > 0 && cur.altitudeDeg <= 0) sunsetAz = prev.azimuthDeg;
    prev = cur;
  }
  if (sunriseAz === null || sunsetAz === null) return null; // polar day/night
  return { sunriseAz, sunsetAz };
}
