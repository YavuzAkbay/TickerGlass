import { memo, useRef, type HTMLAttributes } from 'react';
import type { LiveQuote } from '../../quotes/types';
import type { SnapshotRow } from '../../screener/server/snapshot';
import type { ColumnId, FlagColor } from '../types';
import { useFlash } from '../../sidebar/watchlist/columns';
import { RowBadges } from '../badges';
import { ColumnCell } from '../columns/ColumnCell';
import { heatStyle } from '../columns/heat';
import { RangeBar } from '../columns/RangeBar';
import { COLUMN_DEFS } from '../columns/registry';
import { rowMenu } from '../../sidebar/watchlist/rowMenu';
import { rowDomId } from '../../sidebar/watchlist/rowId';
import { Sparkline } from '../../sidebar/watchlist/Sparkline';
import { useLongPress } from '../../ui/useLongPress';
import type { ListRef } from '../types';
import { useSymbolMeta } from './symbolMeta';

export type SelectMode = 'single' | 'toggle' | 'range';

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
  /** The chart's symbol (subtle orientation marker). */
  current: boolean;
  /** Part of the multi-selection. */
  selected: boolean;
  /** The keyboard/detail focus row. */
  active: boolean;
  /** Position in the list (drag-and-drop target id). */
  index: number;
  /** 1-based `aria-rowindex` (the table is virtualized, so the DOM can't tell). */
  rowIndex: number;
  onOpen: (symbol: string) => void;
  onSelection: (symbol: string, mode: SelectMode) => void;
  dnd: HTMLAttributes<HTMLDivElement>;
  dropPos: 'above' | 'below' | null;
  hint?: string;
}

/** Day-range bar for `q` (the page's detail pane draws it too). */
export const DayRangeBar = memo(function DayRangeBar({ q }: { q: LiveQuote | undefined }) {
  const cell = COLUMN_DEFS.dayRange.cell({ q, meta: undefined, surface: 'page' });
  return cell.bar ? <RangeBar bar={cell.bar} title={cell.title} /> : null;
});

/** Company name cell; mounts trigger the (throttled) background name lookup. */
const NameCell = memo(function NameCell({ symbol }: { symbol: string }) {
  const meta = useSymbolMeta(symbol);
  return (
    <span
      role="gridcell"
      data-testid={`wlp-cell-name-${symbol}`}
      className="wlp-cell wlp-name"
      title={meta?.name || undefined}
    >
      {meta ? meta.name || '—' : ''}
    </span>
  );
});

/** One symbol row of the full-screen table. */
export const PageSymbolRow = memo(function PageSymbolRow({
  symbol,
  listRef,
  q,
  snap,
  columns,
  unavailable,
  flag,
  current,
  selected,
  active,
  index,
  rowIndex,
  onOpen,
  onSelection,
  dnd,
  dropPos,
  hint,
}: Props) {
  const lastRef = useRef<HTMLSpanElement>(null);
  const extRef = useRef<HTMLSpanElement>(null);
  useFlash(q, lastRef, extRef);
  const press = useLongPress((x, y) => rowMenu(symbol, listRef, x, y, { onOpen }));

  return (
    <div
      role="row"
      id={rowDomId('wlp-r', symbol)}
      aria-rowindex={rowIndex}
      aria-selected={selected}
      aria-current={active ? 'true' : undefined}
      data-testid={`wlp-row-${symbol}`}
      data-wl-index={index}
      data-flag={flag ?? undefined}
      title={hint}
      className={`wlp-row${current ? ' current' : ''}${selected ? ' selected' : ''}${active ? ' active' : ''}${flag ? ' flagged' : ''}${dropPos ? ` drop-${dropPos}` : ''}`}
      style={flag ? { borderLeftColor: `var(--wl-flag-${flag})` } : undefined}
      onClick={(e) =>
        onSelection(symbol, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'single')
      }
      onDoubleClick={() => onOpen(symbol)}
      onContextMenu={(e) => {
        e.preventDefault();
        rowMenu(symbol, listRef, e.clientX, e.clientY, { onOpen });
      }}
      {...press}
      {...dnd}
    >
      <span role="gridcell" className="wlp-sym rs-num">
        <span className="wlp-sym-text">{symbol}</span>
        <RowBadges symbol={symbol} quote={q} />
      </span>
      {columns.map((id) => {
        if (id === 'trend')
          return (
            <span key={id} role="gridcell" className="wlp-cell wlp-trend">
              <Sparkline symbol={symbol} width={88} height={22} last={q?.last} />
            </span>
          );
        if (id === 'name') return <NameCell key={id} symbol={symbol} />;
        return (
          <ColumnCell
            key={id}
            id={id}
            prefix="wlp"
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
        className="wlp-gutter wlp-heat"
        aria-hidden="true"
        style={heatStyle(q?.changePercent)}
      />
      {dropPos ? <i className="wl-drop-line" aria-hidden="true" /> : null}
    </div>
  );
});
