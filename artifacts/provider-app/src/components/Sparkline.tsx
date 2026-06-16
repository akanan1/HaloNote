// Tiny inline SVG sparkline. No chart library — for 30 data points
// the overhead of a deps-laden chart isn't worth it, and a hand-rolled
// path stays themable via CSS currentColor.
//
// Renders a smooth line over the series + an end-point dot. Width and
// height are deliberately defaults you override per-instance so the
// caller controls layout.

export interface SparklineDatum {
  date: string;
  count: number;
}

export function Sparkline({
  data,
  width = 120,
  height = 32,
  strokeWidth = 1.5,
  className,
  ariaLabel,
}: {
  data: SparklineDatum[];
  width?: number;
  height?: number;
  strokeWidth?: number;
  className?: string;
  ariaLabel?: string;
}) {
  if (data.length < 2) {
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className={className}
        aria-hidden={!ariaLabel}
        role={ariaLabel ? "img" : undefined}
        aria-label={ariaLabel}
      >
        <line
          x1={0}
          y1={height - 1}
          x2={width}
          y2={height - 1}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeOpacity={0.25}
        />
      </svg>
    );
  }

  const counts = data.map((d) => d.count);
  const max = Math.max(...counts, 1);
  const min = Math.min(...counts, 0);
  const range = max - min || 1;

  // Pad 1px inside the viewBox so a stroke at the top/bottom isn't
  // clipped.
  const padY = strokeWidth;
  const innerH = height - padY * 2;
  const stepX = width / (data.length - 1);

  const points = data.map((d, i) => {
    const x = i * stepX;
    const y = padY + innerH - ((d.count - min) / range) * innerH;
    return [x, y] as const;
  });

  const pathD = points
    .map(([x, y], i) => (i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`))
    .join(" ");

  const last = points[points.length - 1]!;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      aria-hidden={!ariaLabel}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
    >
      <path
        d={pathD}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={last[0]}
        cy={last[1]}
        r={strokeWidth + 0.5}
        fill="currentColor"
      />
    </svg>
  );
}
