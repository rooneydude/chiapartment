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
  const lastX = pad + (points.length - 1) * step;
  const lastY = height - pad - ((last - min) / span) * (height - pad * 2);
  const area = `${d} L${lastX.toFixed(1)},${height - 1} L${pad},${height - 1} Z`;
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={area} fill="var(--accent-soft)" stroke="none" />
      <path d={d} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={2.5} fill="var(--series-1)" />
    </svg>
  );
}
