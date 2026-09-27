import { useOxyTheme } from '@oxytocin/plugin-sdk/react';
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

const token = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export const SERIES_COLORS = [
  '--agent',
  '--accent',
  '--info',
  '--warning',
  '--success',
  '--danger',
  '--project-6',
  '--project-9',
];

/** Stacked daily bars (uPlot): `series` values are stacked in order. */
export function StackedBars({
  buckets,
  series,
  height = 200,
}: {
  buckets: number[];
  series: { label: string; values: number[] }[];
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Colors are read from the tokens when the chart is built: rebuild it on theme switches.
  const theme = useOxyTheme();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const xs = buckets.map((b) => b / 1000);
    const stacked: number[][] = [];
    let acc = new Array<number>(buckets.length).fill(0);
    for (const s of series) {
      acc = acc.map((v, i) => v + (s.values[i] ?? 0));
      stacked.push([...acc]);
    }
    const bars = uPlot.paths.bars!({ size: [0.7, 40] });
    const axis = {
      stroke: token('--text-muted', 'gray'),
      grid: { stroke: token('--border-subtle', 'gray') },
      ticks: { show: false },
    };
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      legend: { show: false },
      cursor: { show: true, points: { show: false } },
      scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, Math.max(0.01, max * 1.1)] } },
      axes: [axis, { ...axis, values: (_u, vals) => vals.map((v) => `$${v.toFixed(v < 10 ? 2 : 0)}`), size: 56 }],
      // Drawn from the top of the stack down so each series shows as its own band.
      series: [
        {},
        ...series
          .map((s, i) => ({
            label: s.label,
            fill: token(SERIES_COLORS[i % SERIES_COLORS.length]!, 'steelblue'),
            stroke: 'transparent',
            paths: bars,
            points: { show: false },
          }))
          .reverse(),
      ],
    };
    const plot = new uPlot(opts, [xs, ...[...stacked].reverse()] as uPlot.AlignedData, el);
    const resize = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    resize.observe(el);
    return () => {
      resize.disconnect();
      plot.destroy();
    };
  }, [buckets, series, height, theme]);
  return <div ref={ref} className="chart" data-testid="usage-chart" data-theme={theme} />;
}

/** A tiny cost sparkline (SVG) for session details. */
export function Sparkline({ values, width = 320, height = 40 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1e-9);
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * width},${height - (v / max) * (height - 2) - 1}`)
    .join(' ');
  return (
    <svg width={width} height={height} role="img" aria-label="Cost over time">
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  );
}
