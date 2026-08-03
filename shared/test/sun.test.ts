import { describe, expect, it } from "vitest";
import { sunPosition, sunriseSunsetAzimuths } from "../src/sun";

const CHI = { lat: 41.9, lon: -87.635 };

describe("sunPosition", () => {
  it("puts the summer solstice noon sun high and roughly south", () => {
    // Solar noon in Chicago ≈ 12:50 CDT ≈ 17:50 UTC.
    const p = sunPosition(new Date("2026-06-21T17:50:00Z"), CHI.lat, CHI.lon);
    expect(p.altitudeDeg).toBeGreaterThan(68);
    expect(p.altitudeDeg).toBeLessThan(74);
    expect(Math.abs(p.azimuthDeg - 180)).toBeLessThan(10);
  });

  it("puts the winter solstice noon sun low", () => {
    const p = sunPosition(new Date("2026-12-21T18:00:00Z"), CHI.lat, CHI.lon);
    expect(p.altitudeDeg).toBeGreaterThan(20);
    expect(p.altitudeDeg).toBeLessThan(28);
  });

  it("is below the horizon at midnight", () => {
    expect(sunPosition(new Date("2026-06-21T06:00:00Z"), CHI.lat, CHI.lon).altitudeDeg).toBeLessThan(0);
  });
});

describe("sunriseSunsetAzimuths", () => {
  it("matches known Chicago solstice azimuths", () => {
    const jun = sunriseSunsetAzimuths(new Date("2026-06-21T12:00:00Z"), CHI.lat, CHI.lon)!;
    expect(jun.sunriseAz).toBeGreaterThan(53);
    expect(jun.sunriseAz).toBeLessThan(62); // ~57-58° (NE)
    expect(jun.sunsetAz).toBeGreaterThan(298);
    expect(jun.sunsetAz).toBeLessThan(307); // ~302° (NW)

    const dec = sunriseSunsetAzimuths(new Date("2026-12-21T12:00:00Z"), CHI.lat, CHI.lon)!;
    expect(dec.sunriseAz).toBeGreaterThan(116);
    expect(dec.sunriseAz).toBeLessThan(126); // ~121° (SE)
  });
});
