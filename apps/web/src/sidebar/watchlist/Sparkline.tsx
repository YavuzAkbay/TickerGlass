import { isExpressionSymbol } from '@tickerglass/engine';
import { memo } from 'react';
import { useSparkline } from '../../quotes/sparklines';

const W = 44;
const H = 18;

interface Props {
  symbol: string;
  /** Size in px and how many daily sessions to draw (page variants use larger values). */
  width?: number;
  height?: number;
  limit?: number;
  /** Live price: replaces the final close so the line ends at the current quote. */
  last?: number | null | undefined;
}

/** Daily closes as a small line, green or red by the period's move. */
export const Sparkline = memo(function Sparkline({
  symbol,
  width: W2 = W,
  height: H2 = H,
  limit = 30,
  last: live,
}: Props) {
  const data = useSparkline(symbol, { enabled: !isExpressionSymbol(symbol), limit });
  const closes = data ? [...data] : [];
  if (closes.length >= 2 && live != null && Number.isFinite(live) && live > 0)
    closes[closes.length - 1] = live;
  if (closes.length < 2)
    return <span className="wl-spark-empty" style={{ width: W2 }} aria-hidden="true" />;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const pts = closes
    .map((c, i) => {
      const x = (i / (closes.length - 1)) * W2;
      const y = H2 - 2 - ((c - min) / span) * (H2 - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const first = closes[0]!;
  const end = closes[closes.length - 1]!;
  const up = end >= first;
  const pct = ((end - first) / first) * 100;
  return (
    <svg
      className={`wl-spark ${up ? 'up' : 'down'}`}
      width={W2}
      height={H2}
      viewBox={`0 0 ${W2} ${H2}`}
      role="img"
      aria-label={`${limit}-day trend ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}
    >
      {/* Area fill under the line; both take the up/down color from CSS `color`. */}
      <path
        d={`M0,${H2} L${pts} L${W2},${H2} Z`}
        fill="currentColor"
        stroke="none"
        opacity={0.13}
      />
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
});
