import { useIsCoarsePointer } from '../../ui/useMediaQuery';
import { ArrowDown, ArrowUp, ListPlus, Rows3, Search, Settings2, X } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react';
import { commands } from '../../commands/registry';
import { useChartView } from '../../store/chartView';
import { useLiveQuotes } from '../../quotes/hooks';
import { useQuoteStore } from '../../quotes/store';
import { DropdownMenu, type MenuItem } from '../../ui/Menu';
import { IconButton } from '../../ui/IconButton';
import { useT } from '../../i18n';
import { useEvent } from '../../sidebar/watchlist/useEvent';
import { SectionRow } from '../../sidebar/watchlist/SectionRow';
import { rowMenu } from '../../sidebar/watchlist/rowMenu';
import { rowDomId } from '../../sidebar/watchlist/rowId';
import { visibleSymbols } from '../../sidebar/watchlist/visibleSymbols';
import { useStableRows, useTableFreeze } from '../../sidebar/watchlist/useStableRows';
import { useDragEndSafety, windowSegments } from '../../sidebar/watchlist/windowSegments';
import { removeWithUndo } from '../actions';
import { buildRows, isFlagRef, type SymbolMeta } from '../model';
import { useWatchlistPrefs } from '../prefs';
import { useWatchlistStore } from '../store';
import {
  FLAG_COLORS,
  type ColumnId,
  type ListRef,
  type Row,
  type SortKey,
  type WatchlistItem,
} from '../types';
import { useUnavailableColumns } from '../columns/availability';
import { useSnapshotColumns } from '../columns/useSnapshotColumns';
import { columnsMenu } from '../columns/columnsMenu';
import { deleteColumnPreset, saveColumnPreset } from '../columns/presetActions';
import { peekSymbolMeta, useSymbolMetaVersion, wantSymbolMetas } from './symbolMeta';
import { ROW_H, useWatchlistPagePrefs } from './pagePrefs';
import { PAGE_COLUMNS, pageTemplate } from './pageColumns';
import { ColumnHeader, type ColumnDrop } from './ColumnHeader';
import { bulkRowMenu } from './bulkMenu';
import { useVirtualRows } from '../../ui/virtualRows';
import { PageSymbolRow, type SelectMode } from './PageSymbolRow';
import { neighborAfterRemoval } from './neighbor';

const NO_DND: HTMLAttributes<HTMLDivElement> = {};
const TYPE_AHEAD_MS = 500;

/** End (exclusive) of the block that moves with the item at `from` (sections move with their symbols). */
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
  /** (Filtered) items of the active list; flag lists come flattened. */
  items: WatchlistItem[];
  filter: string;
  onFilterChange: (v: string) => void;
  /** The keyboard/detail focus row. */
  active: string | null;
  onActive: (symbol: string | null) => void;
  selection: ReadonlySet<string>;
  onSelectionChange: (symbols: string[], anchor: string | null) => void;
  /** Open the symbol in the chart and return to it. */
  onOpen: (symbol: string) => void;
  /** The unfiltered list has no symbols at all (bigger empty state). */
  listEmpty: boolean;
  /** Every symbol of the unfiltered list (detects removals while a row is focused). */
  listSymbols: ReadonlySet<string>;
  /** Written with the displayed symbol order (CSV export follows what the table shows). */
  orderRef?: MutableRefObject<string[]>;
}

/** Sortable, reorderable, virtualized quote grid of the full-screen page. */
export function PageTable({
  listRef,
  items,
  filter,
  onFilterChange,
  active,
  onActive,
  selection,
  onSelectionChange,
  onOpen,
  listEmpty,
  listSymbols,
  orderRef,
}: Props) {
  const t = useT();
  const isFlag = isFlagRef(listRef);
  const entry = useWatchlistStore((s) => (isFlag ? undefined : s.lists[listRef]));
  const flags = useWatchlistStore((s) => s.flags);
  const columns = useWatchlistPagePrefs((s) => s.columns);
  const sort = useWatchlistPagePrefs((s) => s.sort);
  const collapsed = useWatchlistPrefs((s) => s.collapsed);
  const setSort = useWatchlistPagePrefs((s) => s.setSort);
  const toggleColumn = useWatchlistPagePrefs((s) => s.toggleColumn);
  const setColumns = useWatchlistPagePrefs((s) => s.setColumns);
  const moveColumn = useWatchlistPagePrefs((s) => s.moveColumn);
  const widths = useWatchlistPagePrefs((s) => s.widths);
  const presets = useWatchlistPagePrefs((s) => s.presets);
  const perList = useWatchlistPagePrefs((s) => s.perList);
  const density = useWatchlistPagePrefs((s) => s.density);
  const rowH = ROW_H[density];
  const chartSymbol = useChartView((s) => s.symbol);
  const quoteError = useQuoteStore((s) => s.error);
  const anchor = useRef<string | null>(null);

  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [drop, setDrop] = useState<{ index: number; after: boolean } | null>(null);
  const [colsBtn, setColsBtn] = useState<HTMLButtonElement | null>(null);
  const [colsOpen, setColsOpen] = useState(false);
  const [densityBtn, setDensityBtn] = useState<HTMLButtonElement | null>(null);
  const [densityOpen, setDensityOpen] = useState(false);
  const [colDrag, setColDrag] = useState<ColumnDrop | null>(null);
  const [liveWidth, setLiveWidth] = useState<{ id: ColumnId; px: number } | null>(null);
  const [moved, setMoved] = useState('');
  const refocusCol = useRef<ColumnId | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const filterRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const symbols = useMemo(
    () => items.flatMap((i) => (i.type === 'symbol' ? [i.symbol] : [])),
    [items],
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

  // With "remember per list" on, each list brings back its own columns and sort.
  useEffect(() => {
    useWatchlistPagePrefs.getState().enterList(listRef);
    return () => useWatchlistPagePrefs.getState().enterList(null);
  }, [listRef]);

  // Sorting by name needs every name, not just the mounted rows'.
  const nameSort = sort?.key === 'name';
  useEffect(() => {
    if (!nameSort) return;
    wantSymbolMetas('page-sort', liveSymbols);
    return () => wantSymbolMetas('page-sort', null);
  }, [nameSort, liveSymbols]);

  // Names resolve in the background; the version tick rebuilds the sort input.
  const metaVersion = useSymbolMetaVersion();
  const metaMap = useMemo(() => {
    const out: Record<string, SymbolMeta | undefined> = {};
    for (const s of symbols) {
      const m = peekSymbolMeta(s);
      if (m) out[s] = m;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- metaVersion tracks resolution
  }, [symbols, metaVersion]);

  const builtRows: Row[] = useMemo(
    () => buildRows(items, sort, quotes, true, metaMap, collapsed, snaps),
    [items, sort, quotes, metaMap, collapsed, snaps],
  );
  // Live-sorted rows hold their order between commits (and while the pointer is over them).
  const freeze = useTableFreeze(dragFrom !== null);
  const rows = useStableRows(builtRows, { sort, items, frozen: freeze.frozen });
  const symbolRows = useMemo(
    () => rows.flatMap((r) => (r.kind === 'symbol' ? [r.symbol] : [])),
    [rows],
  );
  const { scrollerRef, range, scrollToRow } = useVirtualRows(rows.length, rowH);

  const canDrag = !sort && !filter && !isFlag;
  const listId = entry?.id ?? '';

  useEffect(() => {
    if (orderRef) orderRef.current = symbolRows;
  }, [orderRef, symbolRows]);

  // The detail pane follows the focused row. Scroll when the focus moves or the
  // user re-sorts/filters/reorders, never on a quote tick.
  const scrollActive = useEvent(() => {
    const i = active ? rows.findIndex((r) => r.kind === 'symbol' && r.symbol === active) : -1;
    if (i >= 0) scrollToRow(i);
  });
  const sortSig = sort ? `${sort.key}:${sort.dir}` : '';
  const scrollKey = `${active ?? ''}|${sortSig}|${filter}`;
  const lastScrollKey = useRef<string | null>(null);
  const forceScroll = useRef(false);
  useEffect(() => {
    if (lastScrollKey.current === scrollKey && !forceScroll.current) return;
    lastScrollKey.current = scrollKey;
    forceScroll.current = false;
    scrollActive();
  }, [scrollKey, rows, scrollActive]);

  // A removed symbol must not stay in the detail pane or the selection: the pane
  // moves to the neighbouring row (as last displayed), or closes.
  const lastOrder = useRef<string[]>([]);
  useEffect(() => {
    const prev = lastOrder.current;
    lastOrder.current = symbolRows;
    if (active && !listSymbols.has(active)) {
      onActive(neighborAfterRemoval(prev, active, (sym) => listSymbols.has(sym)));
    }
    if (selection.size && [...selection].some((s) => !listSymbols.has(s))) {
      const kept = [...selection].filter((s) => listSymbols.has(s));
      anchor.current = null;
      onSelectionChange(kept, null);
    }
  }, [symbolRows, listSymbols, active, selection, onActive, onSelectionChange]);

  const commitSelection = useEvent((next: string[], newAnchor: string | null) => {
    anchor.current = newAnchor;
    onSelectionChange(next, newAnchor);
  });

  const select = useEvent((symbol: string, mode: SelectMode) => {
    if (mode === 'toggle') {
      const next = selection.has(symbol)
        ? [...selection].filter((s) => s !== symbol)
        : [...selection, symbol];
      onActive(symbol);
      commitSelection(next, symbol);
      return;
    }
    if (mode === 'range') {
      const to = symbolRows.indexOf(symbol);
      const from = anchor.current ? symbolRows.indexOf(anchor.current) : -1;
      if (to >= 0) {
        const [a, b] = from < 0 ? [to, to] : from <= to ? [from, to] : [to, from];
        onActive(symbol);
        commitSelection(symbolRows.slice(a, b + 1), from < 0 ? symbol : anchor.current);
      }
      return;
    }
    onActive(symbol);
    commitSelection([symbol], symbol);
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
  const coarse = useIsCoarsePointer();
  const dndFor = canDrag && !coarse ? dnd : NO_DND;
  const dropPosOf = (row: Row): 'above' | 'below' | null =>
    drop && dragFrom !== null && drop.index === row.index && row.index !== dragFrom
      ? drop.after
        ? 'below'
        : 'above'
      : null;

  const moveSelected = (dir: 1 | -1) => {
    if (!active || !canDrag) return;
    const i = rows.findIndex((r) => r.kind === 'symbol' && r.symbol === active);
    const cur = rows[i];
    const target = rows[i + dir];
    if (!cur || cur.kind !== 'symbol' || !target) return;
    forceScroll.current = true;
    commitMove(cur.index, insertionPoint(items, target, dir > 0));
  };

  const removeSelected = useEvent(() => {
    const syms = [...selection].filter((s) => symbolRows.includes(s));
    if (!syms.length) return;
    const ref = isFlag ? listRef : listId;
    if (ref) removeWithUndo(ref, syms); // toasts with "Undo"
    commitSelection([], null);
    onActive(null);
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.nativeEvent.isComposing) return;
    const idx = active ? symbolRows.indexOf(active) : -1;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      handled();
      filterRef.current?.focus();
      filterRef.current?.select();
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      handled();
      moveSelected(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.altKey && /^Digit[1-7]$/.test(e.code)) {
      handled();
      if (!active) return;
      const color = FLAG_COLORS[Number(e.code.slice(5)) - 1]!;
      commands.execute('watchlist.flag', {
        symbol: active,
        color: flags[active]?.color === color ? null : color,
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
      if (next) {
        const from = e.shiftKey && anchor.current ? symbolRows.indexOf(anchor.current) : -1;
        if (e.shiftKey && from >= 0) {
          const [a, b] = from <= to ? [from, to] : [to, from];
          onActive(next);
          commitSelection(symbolRows.slice(a, b + 1), anchor.current);
        } else if (e.shiftKey) {
          // Anchor not displayed (filtered/collapsed away): start a new range at the focus row.
          const base = active && idx >= 0 ? active : next;
          const [a, b] = idx < 0 ? [to, to] : idx <= to ? [idx, to] : [to, idx];
          onActive(next);
          commitSelection(symbolRows.slice(a, b + 1), base);
        } else select(next, 'single');
      }
    } else if (e.key === 'Home' || e.key === 'End') {
      handled();
      const next = e.key === 'Home' ? symbolRows[0] : symbolRows[symbolRows.length - 1];
      if (next) select(next, 'single');
    } else if (e.key === 'Enter') {
      handled();
      if (active && idx >= 0) onOpen(active);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      handled();
      removeSelected();
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      handled();
      const el = active ? document.getElementById(rowDomId('wlp-r', active)) : null;
      if (active && el) {
        const r = el.getBoundingClientRect();
        if (selection.size > 1 && selection.has(active))
          bulkRowMenu([...selection], listRef, r.left + 16, r.bottom, () =>
            commitSelection([], null),
          );
        else rowMenu(active, listRef, r.left + 16, r.bottom, { onOpen });
      }
    } else if (e.key.length === 1 && /[A-Za-z0-9^.=-]/.test(e.key)) {
      // Type-ahead; keeps the global "type to search" shortcut from firing.
      handled();
      const now = e.timeStamp;
      const ty = typed.current;
      ty.text = (now - ty.at > TYPE_AHEAD_MS ? '' : ty.text) + e.key.toUpperCase();
      ty.at = now;
      const hit = symbolRows.find((s) => s.startsWith(ty.text));
      if (hit) select(hit, 'single');
    }
  };

  const toggleSort = (key: SortKey) => {
    const first = key === 'symbol' || key === 'name' ? 'asc' : 'desc';
    if (!sort || sort.key !== key) setSort({ key, dir: first });
    else if (sort.dir === first) setSort({ key, dir: first === 'asc' ? 'desc' : 'asc' });
    else setSort(null);
  };

  const menuItems = columnsMenu({
    surface: 'page',
    columns,
    presets,
    onToggle: toggleColumn,
    onApply: (cols, w, preset) =>
      preset ? useWatchlistPagePrefs.getState().applyPreset(preset) : setColumns(cols, w),
    onSavePreset: () => void saveColumnPreset(columns, widths, 'page'),
    onDeletePreset: deleteColumnPreset,
    clearSort: { disabled: !sort, onSelect: () => setSort(null) },
    extra: [
      { type: 'separator' },
      {
        label: t('wlp.perList'),
        checked: perList,
        onSelect: () => useWatchlistPagePrefs.getState().setPerList(!perList),
      },
      {
        label: t('wlp.resetWidths'),
        disabled: Object.keys(widths).length === 0,
        onSelect: () => useWatchlistPagePrefs.getState().resetWidths(),
      },
    ],
  });

  const densityMenu: MenuItem[] = [
    {
      label: t('wlp.densityCompact'),
      checked: density === 'compact',
      onSelect: () => useWatchlistPagePrefs.getState().setDensity('compact'),
    },
    {
      label: t('wlp.densityCozy'),
      checked: density === 'cozy',
      onSelect: () => useWatchlistPagePrefs.getState().setDensity('cozy'),
    },
  ];

  const template = pageTemplate(
    columns,
    liveWidth ? { ...widths, [liveWidth.id]: liveWidth.px } : widths,
  );

  /** Alt+Left/Right on a header; focus follows the moved column and the move is announced. */
  const moveBy = (id: ColumnId, dir: -1 | 1) => {
    const at = columns.indexOf(id);
    const to = Math.max(0, Math.min(columns.length - 1, at + dir));
    if (at < 0 || to === at) return;
    refocusCol.current = id;
    moveColumn(id, to);
    setMoved(t('wlp.colMoved', { name: PAGE_COLUMNS[id].title, n: to + 1, total: columns.length }));
  };
  const dropColumn = (from: ColumnId, to: ColumnId, after: boolean) => {
    if (from === to) return;
    const rest = columns.filter((c) => c !== from);
    moveColumn(from, rest.indexOf(to) + (after ? 1 : 0));
  };
  useLayoutEffect(() => {
    const id = refocusCol.current;
    if (!id) return;
    refocusCol.current = null;
    gridRef.current?.querySelector<HTMLElement>(`[data-col="${id}"]`)?.focus();
  }, [columns]);
  const hint = canDrag ? undefined : t('wlp.sortLock');
  const noMatch = !!filter && rows.length === 0;
  // Only a rendered row can be the active descendant (the rest is virtualized away).
  const activeAt = active ? rows.findIndex((r) => r.kind === 'symbol' && r.symbol === active) : -1;
  const activeDescendant =
    activeAt >= range.start && activeAt < range.end ? rowDomId('wlp-r', active!) : undefined;

  const symActive = sort?.key === 'symbol';
  const symbolHead = (
    <span
      role="columnheader"
      aria-sort={symActive ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-testid="wlp-col-symbol"
      className={`wlp-th${symActive ? ' sorted' : ''}`}
      title={`${t('wlp.sortBy')} ${t('wlp.colSymbol')}`}
      tabIndex={0}
      onClick={() => toggleSort('symbol')}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggleSort('symbol');
      }}
    >
      {t('wlp.colSymbol')}
      {symActive ? sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : null}
    </span>
  );

  return (
    <div className={`wlp-table ${density}`} style={{ '--wlp-row-h': `${rowH}px` } as CSSProperties}>
      <div className="wlp-toolbar">
        <div className="wlp-filter">
          <Search size={13} aria-hidden="true" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder={t('wlp.filter')}
            aria-label={t('wlp.filter')}
            spellCheck={false}
            data-testid="wlp-filter"
          />
          {filter ? (
            <button
              type="button"
              className="wlp-filter-clear"
              aria-label={t('wlp.clearFilter')}
              onClick={() => {
                onFilterChange('');
                filterRef.current?.focus();
              }}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
        <span className="wlp-toolbar-spacer" />
        <IconButton
          ref={setDensityBtn}
          icon={Rows3}
          size={15}
          label={t('wlp.density')}
          className="wlp-tool-btn"
          aria-haspopup="menu"
          onClick={() => setDensityOpen((o) => !o)}
        />
        <DropdownMenu
          anchor={densityBtn}
          open={densityOpen}
          onClose={() => setDensityOpen(false)}
          items={densityMenu}
          placement="bottom-end"
        />
        <IconButton
          ref={setColsBtn}
          icon={Settings2}
          size={15}
          label={t('wlp.columns')}
          className="wlp-tool-btn"
          data-testid="wlp-columns-btn"
          aria-haspopup="menu"
          onClick={() => setColsOpen((o) => !o)}
        />
        <DropdownMenu
          anchor={colsBtn}
          open={colsOpen}
          onClose={() => setColsOpen(false)}
          items={menuItems}
          placement="bottom-end"
        />
      </div>
      <div
        role="grid"
        aria-label={t('wlp.tableLabel')}
        aria-rowcount={rows.length + 1}
        aria-activedescendant={activeDescendant}
        tabIndex={0}
        ref={gridRef}
        className="wlp-grid"
        style={{ '--wlp-cols': template } as CSSProperties}
        onKeyDown={onKeyDown}
      >
        <div role="row" aria-rowindex={1} className="wlp-head">
          {symbolHead}
          {columns.map((id) => (
            <ColumnHeader
              key={id}
              id={id}
              label={PAGE_COLUMNS[id].label}
              title={PAGE_COLUMNS[id].title}
              align={PAGE_COLUMNS[id].align}
              sortable={PAGE_COLUMNS[id].sortable}
              sort={sort}
              unavailable={unavailable.has(id)}
              drag={colDrag}
              onSort={toggleSort}
              onMove={moveBy}
              onDragState={setColDrag}
              onDropOn={dropColumn}
              onResizeLive={(cid, px) => setLiveWidth(px === null ? null : { id: cid, px })}
              onResize={(cid, px) => useWatchlistPagePrefs.getState().setWidth(cid, px)}
            />
          ))}
          <span role="columnheader" className="wlp-th wlp-th-gutter" />
        </div>
        <div role="presentation" ref={scrollerRef} className="wlp-body" {...freeze.bodyProps}>
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
                        <PageSymbolRow
                          key={row.symbol}
                          symbol={row.symbol}
                          listRef={listRef}
                          q={quotes[row.symbol]}
                          snap={snaps[row.symbol]}
                          columns={columns}
                          unavailable={unavailable}
                          flag={flags[row.symbol]?.color ?? null}
                          current={row.symbol === chartSymbol}
                          selected={selection.has(row.symbol)}
                          active={row.symbol === active}
                          index={row.index}
                          rowIndex={seg.from + k + 2}
                          onOpen={onOpen}
                          onSelection={select}
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

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {moved}
      </div>

      {noMatch || listEmpty ? (
        <div className="wlp-empty">
          {listEmpty ? (
            <>
              <ListPlus size={34} strokeWidth={1.2} aria-hidden="true" />
              <div className="wlp-empty-title">{t('wlp.emptyTitle')}</div>
              <div className="wlp-empty-text">{t('wlp.emptyText')}</div>
              <button
                type="button"
                className="io-btn io-btn-primary wlp-empty-btn"
                onClick={() => commands.execute('watchlist.searchAdd')}
              >
                {t('wlp.addSymbols')}
              </button>
            </>
          ) : (
            <>
              <Search size={30} strokeWidth={1.2} aria-hidden="true" />
              <div className="wlp-empty-title">{t('wlp.noMatchTitle')}</div>
              <div className="wlp-empty-text">
                {t('wlp.noMatchText').replace('{filter}', filter)}
              </div>
              <button
                type="button"
                className="io-btn wlp-empty-btn"
                onClick={() => onFilterChange('')}
              >
                {t('wlp.clearFilter')}
              </button>
            </>
          )}
        </div>
      ) : null}
      {quoteError ? (
        <div className="rs-inline-error">
          {t('wlp.quoteError')}: {quoteError}
        </div>
      ) : null}

      {selection.size >= 2 ? (
        <div
          className="wlp-bulk"
          role="toolbar"
          aria-label={t('wlp.bulkLabel')}
          data-testid="wlp-bulk"
        >
          <span className="wlp-bulk-count rs-num">
            {t('wlp.selected').replace('{n}', String(selection.size))}
          </span>
          <button
            type="button"
            className="io-btn"
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              bulkRowMenu([...selection], listRef, r.left, r.bottom, () =>
                commitSelection([], null),
              );
            }}
          >
            {t('wlp.bulkActions')}
          </button>
          <button type="button" className="io-btn io-btn-danger" onClick={removeSelected}>
            {t('wlp.bulkRemove')}
          </button>
          <IconButton
            icon={X}
            size={14}
            label={t('wlp.bulkClear')}
            onClick={() => commitSelection([], null)}
          />
        </div>
      ) : null}
    </div>
  );
}
