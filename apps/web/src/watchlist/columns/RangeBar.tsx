import { memo } from 'react';
import type { RangeBarData } from './registry';
import './cells.css';

/** Low—high track with a marker at `bar.pos`, tinted by the day's move. */
export const RangeBar = memo(function RangeBar({
  bar,
  title,
}: {
  bar: RangeBarData;
  title?: string | undefined;
}) {
  if (bar.pos === null) return <span className="wlp-range-empty" aria-hidden="true" />;
  return (
    <span className={`wlp-range ${bar.tone}`} title={title}>
      <span className="wlp-range-track">
        <span className="wlp-range-dot" style={{ left: `${(bar.pos * 100).toFixed(1)}%` }} />
      </span>
    </span>
  );
});
