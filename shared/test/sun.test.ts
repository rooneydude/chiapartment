import { describe, expect, it } from "vitest";
import { sunPosition, sunriseSunsetAzimuths, wallClockInstant } from "../src/sun";

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

describe("wallClockInstant", () => {
  const TZ = "America/Chicago";
  const at = (day: string, hours: number) => wallClockInstant(day, hours, TZ).toISOString();

  it("applies the daylight-saving offset of the day in question", () => {
    expect(at("2026-07-01", 13)).toBe("2026-07-01T18:00:00.000Z"); // CDT, UTC-5
    expect(at("2026-12-01", 13)).toBe("2026-12-01T19:00:00.000Z"); // CST, UTC-6
  });

  it("takes fractional hours and the end of the day", () => {
    expect(at("2026-07-01", 16.1)).toBe("2026-07-01T21:06:00.000Z");
    expect(at("2026-07-01", 0)).toBe("2026-07-01T05:00:00.000Z");
    expect(at("2026-07-01", 24)).toBe("2026-07-02T05:00:00.000Z");
  });

  it("is right in the hours just after a DST switch", () => {
    // Spring forward, 8 Mar 2026: 02:00 CST becomes 03:00 CDT.
    expect(at("2026-03-08", 1.5)).toBe("2026-03-08T07:30:00.000Z");
    expect(at("2026-03-08", 4.5)).toBe("2026-03-08T09:30:00.000Z");
    expect(at("2026-03-08", 13)).toBe("2026-03-08T18:00:00.000Z");
    // Fall back, 1 Nov 2026: 02:00 CDT becomes 01:00 CST.
    expect(at("2026-11-01", 0.5)).toBe("2026-11-01T05:30:00.000Z");
    expect(at("2026-11-01", 3)).toBe("2026-11-01T09:00:00.000Z");
    expect(at("2026-11-01", 13)).toBe("2026-11-01T19:00:00.000Z");
  });

  it("resolves a repeated hour to its first occurrence and a skipped one nearby", () => {
    expect(at("2026-11-01", 1.5)).toBe("2026-11-01T06:30:00.000Z"); // 01:30 CDT
    const skipped = wallClockInstant("2026-03-08", 2.5, TZ).getTime(); // 02:30 never happens
    expect(Math.abs(skipped - Date.parse("2026-03-08T08:00:00Z"))).toBeLessThanOrEqual(3600e3);
  });

  it("leaves UTC alone", () => {
    expect(wallClockInstant("2026-07-01", 13, "UTC").toISOString()).toBe("2026-07-01T13:00:00.000Z");
  });

  it("gives the midday sun for a Chicago wall-clock noon", () => {
    const p = sunPosition(wallClockInstant("2026-06-21", 12.8, TZ), CHI.lat, CHI.lon);
    expect(p.altitudeDeg).toBeGreaterThan(68);
    expect(Math.abs(p.azimuthDeg - 180)).toBeLessThan(10);
  });
});
