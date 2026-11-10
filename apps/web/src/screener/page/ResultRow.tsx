import { memo, useRef } from 'react';
import type { LiveQuote } from '../../quotes/types';
import { changeClass, fmtPrice, isNum } from '../../sidebar/format';
import { useFlash } from '../../sidebar/watchlist/columns';
import { Sparkline } from '../../sidebar/watchlist/Sparkline';
import { useT } from '../../i18n';
import { useLongPress } from '../../ui/useLongPress';
import { RowBadges, type Freshness } from '../../watchlist/badges';
import { dayBounds, week52Bounds } from '../model';
import type { ServerColumnDef } from '../server/columnDefs';
import type { ScanRow } from '../server/types';
import type { UniverseSymbol } from '../universe/types';

interface Props {
  s: UniverseSymbol;
  q: LiveQuote | undefined;
  /** Column ids (`ScreenerColumnId`s in client mode, server column ids in server mode). */
  columns: readonly string[];
  columnDefs: Record<string, ServerColumnDef>;
  /** Server mode: this row's snapshot values (cells fall back to them without a live quote). */
  row?: ScanRow | undefined;
  /** The keyboard/detail focus row. */
  active: boolean;
  /** The chart's symbol (subtle orientation marker). */
  current: boolean;
  onOpen: (symbol: string) => void;
  onFocus: (symbol: string) => void;
  onMenu: (symbol: string, x: number, y: number) => void;
  /** The provider answered without data for this symbol (unknown or delisted). */
  missing: boolean;
  /** Indices are row positions (scroll anchoring and aria). */
  index: number;
}

/** Most rows are HTTP-polled (beyond the socket cap), so "delayed" would badge nearly every row. */
const QUIET: readonly Freshness[] = ['delayed'];

/** Low—high track with a marker at the last price, tinted by the day's move. */
export const ScrBar = memo(function ScrBar({
  low,
  high,
  last,
  changePercent,
}: {
  low: number | null | undefined;
  high: number | null | undefined;
  last: number | null | undefined;
  changePercent: number | null | undefined;
}) {
  if (!isNum(low) || !isNum(high) || !isNum(last) || high <= low)
    return <span className="scr-range-empty" aria-hidden="true" />;
  const p = Math.max(0, Math.min(1, (last - low) / (high - low)));
  return (
    <span
      className={`scr-range ${changeClass(changePercent)}`}
      title={`${fmtPrice(low)} – ${fmtPrice(high)}`}
    >
      <span className="scr-range-track">
        <span className="scr-range-dot" style={{ left: `${(p * 100).toFixed(1)}%` }} />
      </span>
    </span>
  );
});

/** The day's range bar (empty until the quote carries day high/low). */
export const ScrRangeBar = memo(function ScrRangeBar({ q }: { q: LiveQuote | undefined }) {
  const b = dayBounds(q);
  return <ScrBar low={b?.low} high={b?.high} last={q?.last} changePercent={q?.changePercent} />;
});

/** The 52-week range bar (empty until the quote carries both bounds). */
export const ScrWeek52Bar = memo(function ScrWeek52Bar({ q }: { q: LiveQuote | undefined }) {
  const b = week52Bounds(q);
  return <ScrBar low={b?.low} high={b?.high} last={q?.last} changePercent={q?.changePercent} />;
});

/** One result row of the screener table. */
export const ResultRow = memo(function ResultRow({
  s,
  q,
  columns,
  columnDefs,
  row,
  active,
  current,
  onOpen,
  onFocus,
  onMenu,
  missing,
  index,
}: Props) {
  const t = useT();
  const lastRef = useRef<HTMLSpanElement>(null);
  useFlash(q, lastRef);
  const stale = !!row?.stale;
  const press = useLongPress((x, y) => onMenu(s.symbol, x, y));

  return (
    <div
      role="row"
      aria-current={active ? 'true' : undefined}
      data-testid={`scr-row-${s.symbol}`}
      data-scr-index={index}
      className={`scr-row${current ? ' current' : ''}${active ? ' active' : ''}${missing ? ' missing' : ''}${stale ? ' stale' : ''}`}
      title={missing ? t('scr.noData') : stale ? t('scr.srv.stale') : undefined}
      onClick={() => onFocus(s.symbol)}
      onDoubleClick={() => onOpen(s.symbol)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(s.symbol, e.clientX, e.clientY);
      }}
      {...press}
    >
      <span
        role="gridcell"
        className="scr-sym rs-num"
        title={missing ? `${s.name}: ${t('scr.noData')}` : s.name}
      >
        <span className="scr-sym-text">{s.symbol}</span>
        <RowBadges symbol={s.symbol} quote={q} hide={QUIET} />
      </span>
      {columns.map((id) => {
        if (id === 'trend')
          return (
            <span key={id} role="gridcell" className="scr-cell scr-trend">
              <Sparkline symbol={s.symbol} width={88} height={22} last={q?.last} />
            </span>
          );
        if (id === 'dayRange')
          return (
            <span key={id} role="gridcell" className="scr-cell scr-range-cell">
              <ScrRangeBar q={q} />
            </span>
          );
        if (id === 'week52Range')
          return (
            <span key={id} role="gridcell" className="scr-cell scr-range-cell">
              <ScrWeek52Bar q={q} />
            </span>
          );
        const def = columnDefs[id];
        if (!def) return null;
        const cell = def.render({ s, q, row });
        const isLast = id === 'last';
        const pill = id === 'changePercent' && !!cell.className;
        return (
          <span
            key={id}
            role="gridcell"
            ref={isLast ? lastRef : undefined}
            data-testid={isLast ? `scr-cell-last-${s.symbol}` : undefined}
            title={missing ? t('scr.noData') : def.title}
            className={`scr-cell rs-num${isLast ? ' scr-last' : ''}${pill ? ' scr-pill' : ''}${cell.className ? ` ${cell.className}` : ''}`}
          >
            {cell.text}
          </span>
        );
      })}
      {/* Heat strip: the day's move, deeper for bigger moves (full at ±3%). */}
      <span
        role="gridcell"
        className="scr-gutter scr-heat"
        aria-hidden="true"
        style={
          typeof q?.changePercent === 'number' && q.changePercent !== 0
            ? {
                ['--scr-heat' as string]: `color-mix(in srgb, var(${q.changePercent > 0 ? '--up' : '--down'}) ${Math.round(Math.min(1, Math.abs(q.changePercent) / 3) * 85) + 15}%, transparent)`,
              }
            : undefined
        }
      />
    </div>
  );
});
