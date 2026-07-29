/**
 * A small, dependency-free trend line.
 *
 * Rendered as plain SVG on the server so price cards have no client-side cost
 * and no layout shift. Deliberately unlabelled — the number beside it carries
 * the value; this only carries the shape.
 */

interface Props {
  values: Array<number | null>;
  width?: number;
  height?: number;
  /** Colour the line by direction of travel rather than a fixed hue. */
  colorByTrend?: boolean;
  className?: string;
  ariaLabel?: string;
}

export default function Sparkline({
  values,
  width = 96,
  height = 26,
  colorByTrend = true,
  className,
  ariaLabel,
}: Props) {
  const points = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (points.length < 2) {
    return (
      <div
        className={className}
        style={{ width, height }}
        aria-hidden="true"
      />
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const pad = 2;
  const innerH = height - pad * 2;

  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * width;
    const y = pad + innerH - ((v - min) / range) * innerH;
    return [x, y] as const;
  });

  const path = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `${path} L${width},${height} L0,${height} Z`;

  const delta = points.at(-1)! - points[0];
  const stroke = !colorByTrend
    ? "var(--color-ink-400)"
    : delta > 0
      ? "var(--color-up)"
      : delta < 0
        ? "var(--color-down)"
        : "var(--color-ink-400)";

  const gradientId = `spark-${Math.abs(hash(path))}`;

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={ariaLabel ? "img" : "presentation"}
      aria-label={ariaLabel}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={coords.at(-1)![0]}
        cy={coords.at(-1)![1]}
        r="2"
        fill={stroke}
      />
    </svg>
  );
}

/** Stable id source so server and client markup agree. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
