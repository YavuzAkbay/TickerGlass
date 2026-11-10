import { memo, useRef, type HTMLAttributes } from 'react';
import type { LiveQuote } from '../../quotes/types';
import type { SnapshotRow } from '../../screener/server/snapshot';
import type { ColumnId, FlagColor } from '../../watchlist/types';
import { ColumnCell } from '../../watchlist/columns/ColumnCell';
import { RowBadges } from '../../watchlist/badges';
import { heatStyle } from '../../watchlist/columns/heat';
import { useFlash } from './columns';
import { rowMenu } from './rowMenu';
import { rowDomId } from './rowId';
import { Sparkline } from './Sparkline';
import { useLongPress } from '../../ui/useLongPress';
import type { ListRef } from '../../watchlist/types';

interface Props {
  symbol: string;
  listRef: ListRef;
  q: LiveQuote | undefined;
  /** Server-screener snapshot row (only passed while a snapshot column is visible). */
  snap?: SnapshotRow | undefined;
  columns: ColumnId[];
  /** Columns the data source cannot fill (shown as "—" with an explanation). */
  unavailable: ReadonlySet<ColumnId>;
  flag: FlagColor | null;
  current: boolean;
  selected: boolean;
  /** Position in the list (drag-and-drop target id). */
  index: number;
  /** 1-based `aria-rowindex` (the table is virtualized, so the DOM can't tell). */
  rowIndex: number;
  onActivate: (symbol: string) => void;
  dnd: HTMLAttributes<HTMLDivElement>;
  dropPos: 'above' | 'below' | null;
  hint?: string;
}

/** One symbol row: flag strip, symbol, the visible columns and the heat strip. */
export const SymbolRow = memo(function SymbolRow({
  symbol,
  listRef,
  q,
  snap,
  columns,
  unavailable,
  flag,
  current,
  selected,
  index,
  rowIndex,
  onActivate,
  dnd,
  dropPos,
  hint,
}: Props) {
  const lastRef = useRef<HTMLSpanElement>(null);
  const extRef = useRef<HTMLSpanElement>(null);
  useFlash(q, lastRef, extRef);
  const press = useLongPress((x, y) => rowMenu(symbol, listRef, x, y));

  return (
    <div
      role="row"
      id={rowDomId('wl-r', symbol)}
      aria-rowindex={rowIndex}
      aria-current={current ? 'true' : undefined}
      aria-selected={selected}
      data-testid={`wl-row-${symbol}`}
      data-wl-index={index}
      data-flag={flag ?? undefined}
      title={hint}
      className={`wl-row${current ? ' current' : ''}${selected ? ' selected' : ''}${flag ? ' flagged' : ''}${dropPos ? ` drop-${dropPos}` : ''}`}
      style={flag ? { borderLeftColor: `var(--wl-flag-${flag})` } : undefined}
      onClick={() => onActivate(symbol)}
      onContextMenu={(e) => {
        e.preventDefault();
        rowMenu(symbol, listRef, e.clientX, e.clientY);
      }}
      {...press}
      {...dnd}
    >
      <span role="gridcell" className="wl-sym">
        <span className="wl-sym-text">{symbol}</span>
        <RowBadges symbol={symbol} quote={q} compact />
      </span>
      {columns.map((id) => {
        if (id === 'trend')
          return (
            <span key={id} role="gridcell" className="wl-cell wl-trend">
              <Sparkline symbol={symbol} last={q?.last} />
            </span>
          );
        return (
          <ColumnCell
            key={id}
            id={id}
            prefix="wl"
            symbol={symbol}
            q={q}
            snap={snap}
            unavailable={unavailable.has(id)}
            lastRef={lastRef}
            extRef={extRef}
          />
        );
      })}
      {/* Heat strip: the day's move, deeper for bigger moves (full at ±3%). */}
      <span
        role="gridcell"
        className="wl-gutter wl-heat"
        aria-hidden="true"
        style={heatStyle(q?.changePercent)}
      />
      {dropPos ? <i className="wl-drop-line" aria-hidden="true" /> : null}
    </div>
  );
});
