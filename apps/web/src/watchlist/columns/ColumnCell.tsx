import type { RefObject } from 'react';
import { t } from '../../i18n';
import type { LiveQuote } from '../../quotes/types';
import type { SnapshotRow } from '../../screener/server/snapshot';
import type { ColumnId } from '../types';
import { RangeBar } from './RangeBar';
import { COLUMN_DEFS, type Surface } from './registry';

interface Props {
  id: ColumnId;
  /** Which table draws it: `wl` = sidebar, `wlp` = page (class and test-id prefix). */
  prefix: 'wl' | 'wlp';
  symbol: string;
  q: LiveQuote | undefined;
  /** The symbol's server-screener snapshot row (snapshot columns only). */
  snap?: SnapshotRow | undefined;
  /** The data source gives no row a value for this column. */
  unavailable: boolean;
  lastRef: RefObject<HTMLSpanElement | null>;
  extRef: RefObject<HTMLSpanElement | null>;
}

/**
 * One data cell, drawn from the registry for either table. Not for `name`
 * (page row: lazy lookup) or `trend` (sparkline); rows draw those.
 */
export function ColumnCell({ id, prefix, symbol, q, snap, unavailable, lastRef, extRef }: Props) {
  const surface: Surface = prefix === 'wl' ? 'sidebar' : 'page';
  const cell = unavailable
    ? {
        text: '—',
        className: 'na',
        title: t(COLUMN_DEFS[id].snapshot ? 'wlp.snapUnavailable' : 'wlp.colUnavailable'),
      }
    : COLUMN_DEFS[id].cell({ q, meta: undefined, snap, surface });
  const isLast = id === 'last';
  // Change % renders as a pill tinted by its up/down class (only with a direction).
  const pill = id === 'changePercent' && !!cell.className;
  const cls = cell.className ? ` ${cell.className}` : '';
  if (cell.bar)
    return (
      <span
        role="gridcell"
        data-testid={`${prefix}-cell-${id}-${symbol}`}
        className={`${prefix}-cell wlp-range-cell`}
        title={cell.title}
      >
        <RangeBar bar={cell.bar} title={cell.title} />
      </span>
    );
  return (
    <span
      role="gridcell"
      ref={isLast ? lastRef : id === 'extPrice' ? extRef : undefined}
      data-testid={`${prefix}-cell-${id}-${symbol}`}
      title={cell.title}
      className={`${prefix}-cell rs-num${isLast ? ` ${prefix}-last` : ''}${pill ? ` ${prefix}-pill` : ''}${cls}`}
    >
      {cell.text}
    </span>
  );
}
