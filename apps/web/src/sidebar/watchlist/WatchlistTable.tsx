import { useIsCoarsePointer } from '../../ui/useMediaQuery';
import { ArrowDown, ArrowUp, ListPlus, Settings2 } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type HTMLAttributes,
  type KeyboardEvent,
} from 'react';
import { commands } from '../../commands/registry';
import { useT } from '../../i18n';
import { useLiveQuotes } from '../../quotes/hooks';
import { useQuoteStore } from '../../quotes/store';
import { useChartView } from '../../store/chartView';
import { IconButton } from '../../ui/IconButton';
import { DropdownMenu } from '../../ui/Menu';
import { useVirtualRows } from '../../ui/virtualRows';
import { buildRows, flagRows, isFlagRef } from '../../watchlist/model';
import { useWatchlistPrefs } from '../../watchlist/prefs';
import { useWatchlistStore } from '../../watchlist/store';
import { useUnavailableColumns } from '../../watchlist/columns/availability';
import { COLUMN_DEFS } from '../../watchlist/columns/registry';
import { useSnapshotColumns } from '../../watchlist/columns/useSnapshotColumns';
import { columnsMenu } from '../../watchlist/columns/columnsMenu';
import { deleteColumnPreset, saveColumnPreset } from '../../watchlist/columns/presetActions';
import { useWatchlistPagePrefs } from '../../watchlist/page/pagePrefs';
import {
  FLAG_COLORS,
  type ColumnId,
  type FlagColor,
  type ListRef,
  type Row,
  type SortKey,
  type WatchlistItem,
} from '../../watchlist/types';
import { COLUMNS } from './columns';
import { useDebounce, useEvent } from './useEvent';
import { SectionRow } from './SectionRow';
import { rowMenu } from './rowMenu';
import { SymbolRow } from './SymbolRow';
import { rowDomId } from './rowId';
import { visibleSymbols } from './visibleSymbols';
import { useStableRows, useTableFreeze } from './useStableRows';
import { useDragEndSafety, windowSegments } from './windowSegments';

const NO_DND: HTMLAttributes<HTMLDivElement> = {};
const NAV_DEBOUNCE_MS = 150;
/** Row heights in px; keep in sync with `--wl-row-h` (watchlist.css). Fixed so rows can be windowed. */
const ROW_H = 32;
const ROW_H_COARSE = 48;
const TYPE_AHEAD_MS = 500;

/** End (exclusive) of the block that moves with the item at `from`. */
function blockEnd(items: WatchlistItem[], from: number): number {
  if (items[from]?.type !== 'section') return from + 1;
  let end = from + 1;
  while (end < items.length && items[end]!.type === 'symbol') end++;
  return end;
}

/** Item index a dragged row lands at when dropped above/below `target`. */
function insertionPoint(items: WatchlistItem[], target: Row, after: boolean): number {
  if (!after) return target.index;
  if (target.kind === 'section' && target.collapsed) return blockEnd(items, target.index);
  return target.index + 1;
}

interface Props {
  listRef: ListRef;
}

/** Sortable, reorderable quote grid of the active list (or a flag list). */
export function WatchlistTable({ listRef }: Props) {
  const t = useT();
  const isFlag = isFlagRef(listRef);
  const entry = useWatchlistStore((s) => (isFlag ? undefined : s.lists[listRef]));
  const flags = useWatchlistStore((s) => s.flags);
  const columns = useWatchlistPrefs((s) => s.columns);
  const sort = useWatchlistPrefs((s) => s.sort);
  const collapsed = useWatchlistPrefs((s) => s.collapsed);
  const setSort = useWatchlistPrefs((s) => s.setSort);
  const toggleColumn = useWatchlistPrefs((s) => s.toggleColumn);
  const setColumns = useWatchlistPrefs((s) => s.setColumns);
  const presets = useWatchlistPagePrefs((s) => s.presets);
  const chartSymbol = useChartView((s) => s.symbol);
  const quoteError = useQuoteStore((s) => s.error);

  // Own selection, valid while the chart symbol it was made on is unchanged
  // (so the selection follows the chart symbol when it changes elsewhere).
  const [own, setOwn] = useState<{ sym: string | null; base: string } | null>(null);
  const selected = own && own.base === chartSymbol ? own.sym : chartSymbol;
  const setSelected = (sym: string | null) => setOwn({ sym, base: chartSymbol });
  const nav = useDebounce();
  const activate = useEvent((symbol: string) => {
    setOwn({ sym: symbol, base: chartSymbol });
    nav.cancel();
    commands.execute('chart.setSymbol', symbol);
  });
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [drop, setDrop] = useState<{ index: number; after: boolean } | null>(null);
  const [menuBtn, setMenuBtn] = useState<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const typed = useRef({ text: '', at: 0 });

  const items: WatchlistItem[] = useMemo(
    () =>
      isFlag
        ? flagRows(flags, listRef.slice(5) as FlagColor).flatMap((r) =>
            r.kind === 'symbol' ? [{ type: 'symbol' as const, symbol: r.symbol }] : [],
          )
        : (entry?.items ?? []),
    [isFlag, flags, listRef, entry],
  );
  // Symbols under collapsed sections have no rows: no live subscription for them.
  const liveSymbols = useMemo(() => visibleSymbols(items, collapsed), [items, collapsed]);
  const ext = columns.includes('extPrice') || columns.includes('extChangePercent');
  const quotes = useLiveQuotes(liveSymbols, { ext });
  const quoteUnavailable = useUnavailableColumns(columns, liveSymbols, quotes);
  // Server-screener snapshot columns (fetched only while one is visible or sorted by).
  const { snaps, unavailable } = useSnapshotColumns(
    columns,
    liveSymbols,
    sort?.key,
    quoteUnavailable,
  );

  const builtRows: Row[] = useMemo(() => {
    const built = buildRows(items, sort, quotes, true, undefined, collapsed, snaps);
    return isFlag ? built.map((r) => (r.kind === 'symbol' ? { ...r, index: -1 } : r)) : built;
  }, [items, sort, quotes, isFlag, collapsed, snaps]);
  // Live-sorted rows hold their order between commits (and while the pointer is over them).
  const freeze = useTableFreeze(dragFrom !== null);
  const rows = useStableRows(builtRows, { sort, items, frozen: freeze.frozen });
  const symbolRows = useMemo(
    () => rows.flatMap((r) => (r.kind === 'symbol' ? [r.symbol] : [])),
    [rows],
  );

  const canDrag = !sort && !isFlag;
  const listId = entry?.id ?? '';

  const coarse = useIsCoarsePointer();
  const rowH = coarse ? ROW_H_COARSE : ROW_H;
  const { scrollerRef, range, scrollToRow } = useVirtualRows(rows.length, rowH);

  // Selection follows the chart symbol when it changes elsewhere.
  const scrollSelected = useEvent(() => {
    const i = selected ? rows.findIndex((r) => r.kind === 'symbol' && r.symbol === selected) : -1;
    if (i >= 0) scrollToRow(i);
  });
  useEffect(() => {
    scrollSelected();
  }, [selected, scrollSelected]);
  // After a keyboard move the row lands elsewhere once the store updates.
  const forceScroll = useRef(false);
  useEffect(() => {
    if (!forceScroll.current) return;
    forceScroll.current = false;
    scrollSelected();
  }, [rows, scrollSelected]);

  const openNow = (symbol: string) => {
    nav.cancel();
    commands.execute('chart.setSymbol', symbol);
  };
  const select = useEvent((symbol: string) => {
    setSelected(symbol);
    nav.schedule(() => commands.execute('chart.setSymbol', symbol), NAV_DEBOUNCE_MS);
  });

  /** Move the item at `from` so it lands at insertion point `p` (item index before removal). */
  const commitMove = (from: number, p: number) => {
    if (!listId) return;
    const len = blockEnd(items, from) - from;
    if (p >= from && p <= from + len) return;
    useWatchlistStore.getState().moveItem(listId, from, p > from ? p - len : p);
  };

  const rowAt = (el: HTMLElement): Row | undefined => {
    const idx = Number(el.dataset.wlIndex);
    return rows.find((r) => r.index === idx);
  };
  // Stable handlers (rows are memoized): each runs the latest closure.
  const onDragStart = useEvent((e: DragEvent<HTMLDivElement>) => {
    const row = rowAt(e.currentTarget);
    if (!row) return;
    setDragFrom(row.index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.kind === 'symbol' ? row.symbol : row.title);
  });
  const onDragOver = useEvent((e: DragEvent<HTMLDivElement>) => {
    const row = rowAt(e.currentTarget);
    if (dragFrom === null || !row) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const after = e.clientY >= r.top + r.height / 2;
    setDrop((d) =>
      d && d.index === row.index && d.after === after ? d : { index: row.index, after },
    );
  });
  const onDragLeave = useEvent((e: DragEvent<HTMLDivElement>) => {
    const idx = Number(e.currentTarget.dataset.wlIndex);
    setDrop((d) => (d?.index === idx ? null : d));
  });
  const onDrop = useEvent((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const row = rowAt(e.currentTarget);
    if (dragFrom !== null && drop && row)
      commitMove(dragFrom, insertionPoint(items, row, drop.after));
    setDragFrom(null);
    setDrop(null);
  });
  const onDragEnd = useEvent(() => {
    setDragFrom(null);
    setDrop(null);
  });
  // A row scrolled out of the window mid-drag never delivers its own dragend.
  useDragEndSafety(dragFrom !== null, onDragEnd);
  const dnd = useMemo<HTMLAttributes<HTMLDivElement>>(
    () => ({ draggable: true, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd }),
    [onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd],
  );
  // Native HTML5 drag steals the touch long-press (row menu); skip it on touch.
  const dndFor = canDrag && !coarse ? dnd : NO_DND;
  const dropPosOf = (row: Row): 'above' | 'below' | null =>
    drop && dragFrom !== null && drop.index === row.index && row.index !== dragFrom
      ? drop.after
        ? 'below'
        : 'above'
      : null;

  const moveSelected = (dir: 1 | -1) => {
    if (!selected || !canDrag) return;
    const i = rows.findIndex((r) => r.kind === 'symbol' && r.symbol === selected);
    const cur = rows[i];
    const target = rows[i + dir];
    if (!cur || cur.kind !== 'symbol' || !target) return;
    forceScroll.current = true;
    commitMove(cur.index, insertionPoint(items, target, dir > 0));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.nativeEvent.isComposing) return;
    const idx = selected ? symbolRows.indexOf(selected) : -1;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      handled();
      moveSelected(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.altKey && /^Digit[1-7]$/.test(e.code)) {
      handled();
      if (!selected) return;
      const color = FLAG_COLORS[Number(e.code.slice(5)) - 1]!;
      commands.execute('watchlist.flag', {
        symbol: selected,
        color: flags[selected]?.color === color ? null : color,
      });
    } else if (e.altKey || e.ctrlKey || e.metaKey) {
      return;
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      handled();
      const to =
        idx < 0
          ? 0
          : Math.max(0, Math.min(symbolRows.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      const next = symbolRows[to];
      if (next) select(next);
    } else if (e.key === 'Home' || e.key === 'End') {
      handled();
      const next = e.key === 'Home' ? symbolRows[0] : symbolRows[symbolRows.length - 1];
      if (next) select(next);
    } else if (e.key === 'Enter') {
      handled();
      if (selected && idx >= 0) openNow(selected);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      handled();
      if (selected && idx >= 0) {
        const after = symbolRows[idx + 1] ?? symbolRows[idx - 1] ?? null;
        commands.execute('watchlist.remove', selected);
        setSelected(after);
      }
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      handled();
      const el = selected ? document.getElementById(rowDomId('wl-r', selected)) : null;
      if (selected && el) {
        const r = el.getBoundingClientRect();
        rowMenu(selected, listRef, r.left + 16, r.bottom);
      }
    } else if (e.key.length === 1 && /[A-Za-z0-9^.=-]/.test(e.key)) {
      // Type-ahead; keeps the global "type to search" shortcut from firing.
      handled();
      const now = e.timeStamp;
      const t = typed.current;
      t.text = (now - t.at > TYPE_AHEAD_MS ? '' : t.text) + e.key.toUpperCase();
      t.at = now;
      const hit = symbolRows.find((s) => s.startsWith(t.text));
      if (hit) select(hit);
    }
  };

  const toggleSort = (key: SortKey) => {
    const first = key === 'symbol' ? 'asc' : 'desc';
    if (!sort || sort.key !== key) setSort({ key, dir: first });
    else if (sort.dir === first) setSort({ key, dir: first === 'asc' ? 'desc' : 'asc' });
    else setSort(null);
  };

  const menuItems = columnsMenu({
    surface: 'sidebar',
    columns,
    presets,
    onToggle: toggleColumn,
    onApply: (cols) => setColumns(cols),
    onSavePreset: () => void saveColumnPreset(columns, {}, 'sidebar'),
    onDeletePreset: deleteColumnPreset,
    clearSort: { disabled: !sort, onSelect: () => setSort(null) },
  });

  const template = `minmax(64px, 1.4fr) ${columns.map((c) => COLUMNS[c].width).join(' ')} 28px`;
  const hint = sort && !isFlag ? 'Clear sorting to reorder' : undefined;

  const headCell = (key: SortKey, label: string, title: string, align: 'left' | 'right') => {
    const active = sort?.key === key;
    if (key === 'trend')
      return (
        <span
          key={key}
          role="columnheader"
          data-testid="wl-col-trend"
          className="wl-th right"
          title={title}
        >
          {label}
        </span>
      );
    return (
      <span
        key={key}
        role="columnheader"
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        data-testid={`wl-col-${key}`}
        className={`wl-th${active ? ' sorted' : ''}${align === 'right' ? ' right' : ''}`}
        title={
          unavailable.has(key as ColumnId)
            ? `${title}: ${t(COLUMN_DEFS[key as ColumnId]?.snapshot ? 'wlp.snapUnavailable' : 'wlp.colUnavailable')}`
            : `Sort by ${title}`
        }
        tabIndex={0}
        onClick={() => toggleSort(key)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          toggleSort(key);
        }}
      >
        {label}
        {active ? sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : null}
      </span>
    );
  };

  // Only a rendered row can be the active descendant (the rest is virtualized away).
  const selAt = selected ? rows.findIndex((r) => r.kind === 'symbol' && r.symbol === selected) : -1;
  const activeDescendant =
    selAt >= range.start && selAt < range.end ? rowDomId('wl-r', selected!) : undefined;

  return (
    <div className="wl-table" style={{ '--wl-row-h': `${rowH}px` } as CSSProperties}>
      <div
        role="grid"
        aria-label="Watchlist"
        aria-rowcount={rows.length + 1}
        aria-activedescendant={activeDescendant}
        tabIndex={0}
        className="wl-grid"
        style={{ '--wl-cols': template } as CSSProperties}
        onKeyDown={onKeyDown}
      >
        <div role="row" aria-rowindex={1} className="wl-head">
          {headCell('symbol', 'Symbol', 'symbol', 'left')}
          {columns.map((id) => headCell(id, COLUMNS[id].label, COLUMNS[id].title, 'right'))}
          <span role="columnheader" className="wl-th wl-th-gutter">
            <IconButton
              ref={setMenuBtn}
              icon={Settings2}
              size={14}
              label="Columns"
              tipSide="left"
              className="wl-cols-btn"
              data-testid="wl-columns-btn"
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((o) => !o);
              }}
            />
          </span>
        </div>
        <DropdownMenu
          anchor={menuBtn}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          items={menuItems}
          placement="bottom-end"
        />
        <div role="presentation" ref={scrollerRef} className="wl-body" {...freeze.bodyProps}>
          {rows.length ? (
            <>
              {windowSegments(
                rows.length,
                range,
                dragFrom === null ? null : rows.findIndex((r) => r.index === dragFrom),
              ).flatMap((seg) =>
                seg.gap ? (
                  <div key={seg.key} role="presentation" style={{ height: seg.rows * rowH }} />
                ) : (
                  rows
                    .slice(seg.from, seg.to)
                    .map((row, k) =>
                      row.kind === 'section' ? (
                        <SectionRow
                          key={`s-${row.id}`}
                          listId={listId}
                          rowIndex={seg.from + k + 2}
                          row={row}
                          dnd={dndFor}
                          dropPos={dropPosOf(row)}
                        />
                      ) : (
                        <SymbolRow
                          key={row.symbol}
                          symbol={row.symbol}
                          listRef={listRef}
                          q={quotes[row.symbol]}
                          snap={snaps[row.symbol]}
                          columns={columns}
                          unavailable={unavailable}
                          flag={flags[row.symbol]?.color ?? null}
                          current={row.symbol === chartSymbol}
                          selected={row.symbol === selected}
                          index={row.index}
                          rowIndex={seg.from + k + 2}
                          onActivate={activate}
                          dnd={dndFor}
                          dropPos={dropPosOf(row)}
                          {...(hint ? { hint } : {})}
                        />
                      ),
                    )
                ),
              )}
            </>
          ) : null}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="wl-empty">
          {isFlag ? (
            'No flagged symbols'
          ) : (
            <>
              <ListPlus size={30} strokeWidth={1.2} aria-hidden="true" />
              <div className="wl-empty-title">This list is empty</div>
              <div className="wl-empty-text">
                Press Alt+W to add the chart symbol, or search for one to add.
              </div>
              <button
                type="button"
                className="io-btn wl-empty-btn"
                onClick={() => commands.execute('watchlist.searchAdd')}
              >
                Add symbol
              </button>
            </>
          )}
        </div>
      ) : null}
      {quoteError ? <div className="rs-inline-error">Quotes unavailable: {quoteError}</div> : null}
    </div>
  );
}
