import { useMemo, type MutableRefObject } from "react";
import { facingBearingDeg } from "../../../shared/src/placement";
import { sunPosition, sunriseSunsetAzimuths } from "../../../shared/src/sun";
import type { BuildingConfig, Facing } from "../../../shared/src/types";

const SIZE = 92;
const R = SIZE / 2;

function pt(azimuthDeg: number, radius: number): { x: number; y: number } {
  const a = ((azimuthDeg - 90) * Math.PI) / 180; // compass 0=N → SVG angle
  return { x: R + radius * Math.cos(a), y: R + radius * Math.sin(a) };
}

/**
 * World-aligned compass disc (rotated per-frame by the canvas bridge writing
 * to `discRef` — no React state per frame) showing today's sun path and,
 * when known, the selected unit's facade direction.
 */
export default function CompassHud({
  building,
  facing,
  discRef,
}: {
  building: BuildingConfig;
  facing: Facing | null;
  discRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const sun = useMemo(() => {
    const now = new Date();
    const pos = sunPosition(now, building.lat, building.lon);
    const riseSet = sunriseSunsetAzimuths(now, building.lat, building.lon);
    return { pos, riseSet };
  }, [building]);

  const sunNow = sun.pos.altitudeDeg > 0 ? pt(sun.pos.azimuthDeg, R - 10) : null;
  const rise = sun.riseSet ? pt(sun.riseSet.sunriseAz, R - 4) : null;
  const set = sun.riseSet ? pt(sun.riseSet.sunsetAz, R - 4) : null;
  const facingPt = facing !== null ? pt(facingBearingDeg(facing), R - 14) : null;

  return (
    <div className="compass-hud" title="N = up on the compass; ☀ today's sun">
      <div ref={discRef} className="compass-disc" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE}>
          <circle cx={R} cy={R} r={R - 2} className="compass-ring" />
          {(["N", "E", "S", "W"] as const).map((d, i) => {
            const p = pt(i * 90, R - 11);
            return (
              <text key={d} x={p.x} y={p.y + 3.5} textAnchor="middle" className={`compass-card${d === "N" ? " n" : ""}`}>
                {d}
              </text>
            );
          })}
          {rise && set && (
            <>
              <circle cx={rise.x} cy={rise.y} r={2.5} className="compass-sunmark" />
              <circle cx={set.x} cy={set.y} r={2.5} className="compass-sunmark" />
            </>
          )}
          {sunNow && (
            <text x={sunNow.x} y={sunNow.y + 4} textAnchor="middle" fontSize={11}>
              ☀
            </text>
          )}
          {facingPt && (
            <line x1={R} y1={R} x2={facingPt.x} y2={facingPt.y} className="compass-facing" />
          )}
        </svg>
      </div>
      {facing && <div className="compass-note">faces {facing}</div>}
    </div>
  );
}
