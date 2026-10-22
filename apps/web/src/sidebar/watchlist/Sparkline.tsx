import { isExpressionSymbol } from '@tickerglass/engine';
import { memo } from 'react';
import { useApi } from '../hooks';

const TEN_MIN = 10 * 60 * 1000;
const W = 52;
const H = 18;

/** Daily closes of the last 30 sessions as a small line, green or red by the period's move. */
export const Sparkline = memo(function Sparkline({ symbol }: { symbol: string }) {
  const path = isExpressionSymbol(symbol)
    ? null
    : `/bars?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=30`;
  const bars = useApi<{ c: number[] }>(path, TEN_MIN);
  const closes = bars.data?.c.filter((v) => Number.isFinite(v)) ?? [];
  if (closes.length < 2) return <span className="wl-spark-empty" aria-hidden="true" />;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const pts = closes
    .map((c, i) => {
      const x = (i / (closes.length - 1)) * W;
      const y = H - 2 - ((c - min) / span) * (H - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const first = closes[0]!;
  const last = closes[closes.length - 1]!;
  const up = last >= first;
  const pct = ((last - first) / first) * 100;
  return (
    <svg
      className={`wl-spark ${up ? 'up' : 'down'}`}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`30-day trend ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}
    >
      <polyline points={pts} fill="none" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
});
