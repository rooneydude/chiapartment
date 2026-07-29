import type { Exposure } from "@/lib/units/placement";

/**
 * A compass showing which way a unit's windows actually face.
 *
 * The 3D model shows *where* the unit is; this shows *which way it looks*,
 * unambiguously and without needing to orbit the camera. Each exposure is
 * drawn as a wedge whose width reflects how much exterior wall faces that way,
 * so a corner unit reads as a corner rather than as a single direction.
 */

interface Props {
  exposures: Exposure[];
  size?: number;
  className?: string;
}

const CARDINALS: Array<[string, number]> = [
  ["N", 0],
  ["E", 90],
  ["S", 180],
  ["W", 270],
];

/** Angular half-width of a wedge, degrees. Scaled by the wall's share. */
const MIN_HALF_SPREAD = 14;
const MAX_HALF_SPREAD = 34;

export default function CompassDial({ exposures, size = 92, className }: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 13;
  const total = exposures.reduce((a, e) => a + e.lengthM, 0) || 1;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      role="img"
      aria-label={
        exposures.length
          ? `Faces ${exposures.map((e) => e.point).join(" and ")}`
          : "No exterior exposure"
      }
    >
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--color-ink-700)" strokeWidth="1" />

      {/* Cross-hairs at the cardinal points, for orientation. */}
      {CARDINALS.map(([, deg]) => {
        const [x, y] = polar(cx, cy, r, deg);
        const [xi, yi] = polar(cx, cy, r - 4, deg);
        return (
          <line
            key={deg}
            x1={xi}
            y1={yi}
            x2={x}
            y2={y}
            stroke="var(--color-ink-600)"
            strokeWidth="1"
          />
        );
      })}

      {exposures.map((e) => {
        const share = e.lengthM / total;
        const half =
          MIN_HALF_SPREAD + (MAX_HALF_SPREAD - MIN_HALF_SPREAD) * Math.min(1, share * 1.4);
        return (
          <path
            key={`${e.point}-${e.bearingDeg.toFixed(1)}`}
            d={wedge(cx, cy, r - 1, e.bearingDeg - half, e.bearingDeg + half)}
            fill="var(--color-accent)"
            fillOpacity={0.28 + 0.42 * share}
            stroke="var(--color-accent)"
            strokeWidth="1"
            strokeOpacity="0.8"
          />
        );
      })}

      <circle cx={cx} cy={cy} r="2" fill="var(--color-ink-500)" />

      {CARDINALS.map(([label, deg]) => {
        const [x, y] = polar(cx, cy, r + 8, deg);
        return (
          <text
            key={label}
            x={x}
            y={y}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="9"
            fill="var(--color-ink-500)"
            fontWeight="600"
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}

/** Compass bearing → SVG coordinates. 0° is up (north), 90° is right (east). */
function polar(cx: number, cy: number, r: number, bearingDeg: number): [number, number] {
  const rad = ((bearingDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function wedge(
  cx: number,
  cy: number,
  r: number,
  fromDeg: number,
  toDeg: number,
): string {
  const [x0, y0] = polar(cx, cy, r, fromDeg);
  const [x1, y1] = polar(cx, cy, r, toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
}
