/** Minimal inline SVG sparkline: one series, no axes — context only. */
export default function Sparkline({
  points,
  width = 110,
  height = 30,
}: {
  points: number[];
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pad = 3;
  const step = (width - pad * 2) / (points.length - 1);
  const d = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${(pad + i * step).toFixed(1)},${(
          height - pad - ((p - min) / span) * (height - pad * 2)
        ).toFixed(1)}`,
    )
    .join(" ");
  const last = points[points.length - 1]!;
  const lastY = height - pad - ((last - min) / span) * (height - pad * 2);
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinecap="round" />
      <circle cx={pad + (points.length - 1) * step} cy={lastY} r={2.5} fill="var(--series-1)" />
    </svg>
  );
}
