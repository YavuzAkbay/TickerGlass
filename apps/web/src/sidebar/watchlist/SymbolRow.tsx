import { memo, useRef, type HTMLAttributes } from 'react';
import type { LiveQuote } from '../../quotes/types';
import type { ColumnId, FlagColor } from '../../watchlist/types';
import { COLUMNS, useFlash } from './columns';
import { rowMenu } from './rowMenu';
import type { ListRef } from '../../watchlist/types';

interface Props {
  symbol: string;
  listRef: ListRef;
  q: LiveQuote | undefined;
  columns: ColumnId[];
  flag: FlagColor | null;
  current: boolean;
  selected: boolean;
  /** Position in the list (drag-and-drop target id). */
  index: number;
  onActivate: (symbol: string) => void;
  dnd: HTMLAttributes<HTMLDivElement>;
  dropPos: 'above' | 'below' | null;
  hint?: string;
}

/** One symbol row: flag strip, symbol and the visible columns. */
export const SymbolRow = memo(function SymbolRow({
  symbol,
  listRef,
  q,
  columns,
  flag,
  current,
  selected,
  index,
  onActivate,
  dnd,
  dropPos,
  hint,
}: Props) {
  const lastRef = useRef<HTMLSpanElement>(null);
  const extRef = useRef<HTMLSpanElement>(null);
  useFlash(q, lastRef, extRef);

  return (
    <div
      role="row"
      id={`wl-r-${symbol}`}
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
      {...dnd}
    >
      <span role="gridcell" className="wl-sym">
        {symbol}
      </span>
      {columns.map((id) => {
        const cell = COLUMNS[id].render(q);
        const isLast = id === 'last';
        const isExt = id === 'extPrice';
        return (
          <span
            key={id}
            role="gridcell"
            ref={isLast ? lastRef : isExt ? extRef : undefined}
            data-testid={isLast ? `wl-cell-last-${symbol}` : `wl-cell-${id}-${symbol}`}
            className={`wl-cell rs-num${cell.className ? ` ${cell.className}` : ''}`}
          >
            {cell.text}
          </span>
        );
      })}
      <span role="gridcell" className="wl-gutter" aria-hidden="true" />
      {dropPos ? <i className="wl-drop-line" aria-hidden="true" /> : null}
    </div>
  );
});
