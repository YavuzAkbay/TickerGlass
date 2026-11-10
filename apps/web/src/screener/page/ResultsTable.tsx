import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, SearchX } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { GroupSelect } from '../../heatmap/GroupSelect';
import { groupEntries, groupRows, type GroupEntry } from '../../heatmap/grouping';
import { useT } from '../../i18n';
import type { LiveQuote } from '../../quotes/types';
import { changeClass, fmtCap, fmtSigned } from '../../sidebar/format';
import { useChartView } from '../../store/chartView';
import { DropdownMenu } from '../../ui/Menu';
import { useVirtualRows } from '../../ui/virtualRows';
import { clampPage, PAGE_SIZES, pageCount, pageResults, type ScreenerSortKey } from '../model';
import { ROW_H, useScreenerPrefs, type Density, type ScreenerGroupBy } from '../screenerPrefs';
import type { ServerColumnDef } from '../server/columnDefs';
import type { ScanRow } from '../server/types';
import type { Universe, UniverseSymbol } from '../universe/types';
import type { ScreenerColumnId } from '../screenerPrefs';
import {
  aggregateRows,
  effectiveGroupBy,
  groupByChoices,
  groupByLabelKey,
  groupKeyOf,
} from './groupBy';
import { columnSortKey, scrColumns, SCR_SORT_KEYS } from './pageColumns';
import { ResultRow } from './ResultRow';

/** Why the live order is held: the pointer is over the rows, or the keyboard is in the grid. */
export type HoldKind = 'pointer' | 'focus';

/** Server mode: the rows are already one page, sorted and counted by the server. */
export interface ServerTableProps {
  /** Rows matching the scan (all pages). */
  total: number;
  /** Snapshot values by symbol. */
  rows: Record<string, ScanRow | undefined>;
  /** Server sort field of a column id (null: not sortable). */
  sortFieldOf: (id: string) => string | null;
  /** Header click. */
  onSort: (field: string) => void;
  /** A scan is pending / in flight. */
  loading: boolean;
  /** Message of a failed scan. */
  error: string | null;
  onRetry: () => void;
  /** Rows-per-page choices (server limit is at most 500). */
  pageSizes: readonly number[];
}

interface Props {
  universe: Universe;
  /** Filtered rows, already in displayed (sorted, order-stabilised) order. */
  rows: UniverseSymbol[];
  quotes: Record<string, LiveQuote | undefined>;
  /** Symbols the provider answered without data (unknown or delisted). */
  missing: Record<string, true>;
  /** Quote-bound filters are active and quotes are still on their way. */
  loadingQuotes: boolean;
  /** Inline explanation when the filters contradict each other (min > max). */
  conflict: string | null;
  onHold: (kind: HoldKind, on: boolean) => void;
  columns: readonly string[];
  /** Column definitions; default: the client table's (`scrColumns(universe)`). */
  columnDefs?: Record<string, ServerColumnDef>;
  /** Server mode (omit for the client-side table). */
  server?: ServerTableProps;
  /** Sort key is a `ScreenerSortKey` in client mode, a server field id in server mode. */
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  pageSize: number | null;
  density: Density;
  focus: string | null;
  onFocus: (symbol: string | null) => void;
  onOpen: (symbol: string) => void;
  onMenu: (symbol: string, x: number, y: number) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  onClearFilters: () => void;
  /** Group the (page of) rows; omit for a flat table. */
  groupBy?: ScreenerGroupBy;
  onGroupBy?: (by: ScreenerGroupBy) => void;
}

/** Sortable, virtualized, paged results grid of the screener. */
export function ResultsTable({
  universe,
  rows,
  quotes,
  missing,
  loadingQuotes,
  conflict,
  onHold,
  columns,
  columnDefs: defsProp,
  server,
  sort,
  pageSize,
  density,
  focus,
  onFocus,
  onOpen,
  onMenu,
  searchRef,
  onClearFilters,
  groupBy = 'none',
  onGroupBy,
}: Props) {
  const t = useT();
  const chartSymbol = useChartView((s) => s.symbol);
  const rowH = ROW_H[density];
  const columnDefs = useMemo<Record<string, ServerColumnDef>>(
    () => defsProp ?? scrColumns(universe),
    [defsProp, universe],
  );

  const total = server ? server.total : rows.length;
  const pages = pageCount(total, pageSize);
  // Filters shrank the matches while a later page was open: clamp for display.
  const page = clampPage(
    useScreenerPrefs((s) => s.page),
    total,
    pageSize,
  );
  const shown = useMemo(
    () => (server ? rows : pageResults(rows, page, pageSize)),
    [server, rows, page, pageSize],
  );
  const by = effectiveGroupBy(groupBy, !!server);
  // Collapsed groups are remembered per grouping, so switching the grouping starts expanded.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const snapRows = server?.rows;
  const entries = useMemo<GroupEntry<UniverseSymbol>[]>(() => {
    if (by === 'none') return shown.map((row) => ({ kind: 'row', row, group: '' }));
    const groups = groupRows(shown, (s) => groupKeyOf(by, s, snapRows?.[s.symbol]));
    const closed = new Set(groups.filter((g) => collapsed.has(`${by}:${g.key}`)).map((g) => g.key));
    return groupEntries(groups, closed, (members) => aggregateRows(members, quotes, snapRows));
  }, [by, shown, collapsed, quotes, snapRows]);
  /** Symbols in displayed order (collapsed groups' rows are not navigable). */
  const navSymbols = useMemo(
    () => entries.flatMap((e) => (e.kind === 'row' ? [e.row.symbol] : [])),
    [entries],
  );
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      const id = `${by}:${key}`;
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const { scrollerRef, range, scrollToRow } = useVirtualRows(entries.length, rowH);

  const [sizeBtn, setSizeBtn] = useState<HTMLButtonElement | null>(null);
  const [sizeOpen, setSizeOpen] = useState(false);

  // The detail pane follows the focused row.
  useEffect(() => {
    const i = focus ? entries.findIndex((e) => e.kind === 'row' && e.row.symbol === focus) : -1;
    if (i >= 0) scrollToRow(i);
  }, [focus, entries, scrollToRow]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Typing in the grid: hold the live order so the rows under the cursor stay put.
    onHold('focus', true);
    if (e.target !== e.currentTarget || e.nativeEvent.isComposing) return;
    const symbols = navSymbols;
    const idx = focus ? symbols.indexOf(focus) : -1;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      handled();
      searchRef.current?.focus();
      searchRef.current?.select();
    } else if (e.altKey || e.ctrlKey || e.metaKey) {
      return;
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      handled();
      const to =
        idx < 0
          ? 0
          : Math.max(0, Math.min(symbols.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      if (symbols[to]) onFocus(symbols[to]!);
    } else if (e.key === 'Home' || e.key === 'End') {
      handled();
      const next = e.key === 'Home' ? symbols[0] : symbols[symbols.length - 1];
      if (next) onFocus(next);
    } else if (e.key === 'Enter') {
      handled();
      if (focus && idx >= 0) onOpen(focus);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      handled();
      const el = focus ? document.getElementById(`scr-row-${focus}`) : null;
      if (focus && el) {
        const r = el.getBoundingClientRect();
        onMenu(focus, r.left + 16, r.bottom);
      }
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      handled();
      if (pageSize !== null)
        useScreenerPrefs.getState().setPage(page + (e.key === 'PageDown' ? 1 : -1));
    }
  };

  const toggleSort = (key: string) => {
    if (server) {
      server.onSort(key);
      return;
    }
    const first =
      key === 'symbol' || key === 'name' || key === 'group' || key === 'exchange' ? 'asc' : 'desc';
    const cur = useScreenerPrefs.getState().sort;
    const k = key as ScreenerSortKey;
    if (!cur || cur.key !== k) useScreenerPrefs.getState().setSort({ key: k, dir: first });
    else if (cur.dir === first)
      useScreenerPrefs.getState().setSort({ key: k, dir: first === 'asc' ? 'desc' : 'asc' });
    else useScreenerPrefs.getState().setSort(null);
  };

  const shownColumns = columns.filter((c) => columnDefs[c]);
  const template = `minmax(76px, 1.2fr) ${shownColumns.map((c) => columnDefs[c]!.width).join(' ')} 24px`;

  const headCell = (
    key: string,
    label: string,
    title: string,
    align: 'left' | 'right',
    sortable: boolean,
    testKey: string = key,
  ) => {
    const activeSort = sort?.key === key;
    if (!sortable)
      return (
        <span
          key={key}
          role="columnheader"
          className={`scr-th${align === 'right' ? ' right' : ''}`}
          title={title}
        >
          {label}
        </span>
      );
    return (
      <span
        key={key}
        role="columnheader"
        aria-sort={activeSort ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        data-testid={`scr-col-${testKey}`}
        className={`scr-th${activeSort ? ' sorted' : ''}${align === 'right' ? ' right' : ''}`}
        title={`${t('scr.sortBy')} ${title}`}
        onClick={() => toggleSort(key)}
      >
        {label}
        {activeSort ? sort!.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : null}
      </span>
    );
  };

  const sizeChoices: readonly (number | null)[] = server ? server.pageSizes : PAGE_SIZES;
  const sizeItems = sizeChoices.map((n) => ({
    label: n === null ? t('scr.all') : String(n),
    checked: n === pageSize,
    onSelect: () => useScreenerPrefs.getState().setPageSize(n),
  }));
  const from = total === 0 ? 0 : page * (pageSize ?? 0) + 1;
  const to = pageSize === null ? total : Math.min(total, (page + 1) * pageSize);

  return (
    <div className={`scr-table ${density}`} style={{ '--scr-row-h': `${rowH}px` } as CSSProperties}>
      <div
        role="grid"
        aria-label={t('scr.tableLabel')}
        aria-rowcount={entries.length + 1}
        aria-activedescendant={focus && navSymbols.includes(focus) ? `scr-row-${focus}` : undefined}
        tabIndex={0}
        className="scr-grid"
        style={{ '--scr-cols': template } as CSSProperties}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          if (e.target.matches(':focus-visible')) onHold('focus', true);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) onHold('focus', false);
        }}
      >
        <div role="row" className="scr-head">
          {headCell('symbol', t('scr.colSymbol'), t('scr.colSymbol'), 'left', true)}
          {shownColumns.map((id) => {
            const def = columnDefs[id]!;
            if (server) {
              const field = server.sortFieldOf(id);
              return headCell(field ?? id, def.label, def.title, def.align, field !== null, id);
            }
            const key = columnSortKey(id as ScreenerColumnId);
            return headCell(
              key,
              def.label,
              def.title,
              def.align,
              key !== 'rank' && SCR_SORT_KEYS.includes(key),
            );
          })}
          <span role="columnheader" className="scr-th scr-th-gutter" />
        </div>
        <div
          role="presentation"
          ref={scrollerRef}
          className="scr-body"
          onPointerEnter={() => onHold('pointer', true)}
          onPointerLeave={() => onHold('pointer', false)}
        >
          {entries.length ? (
            <>
              <div role="presentation" style={{ height: range.start * rowH }} />
              {entries.slice(range.start, range.end).map((e, i) => {
                if (e.kind === 'group')
                  return (
                    <div
                      key={`group:${e.key}`}
                      role="row"
                      className="scr-grouprow"
                      data-testid={`scr-group-${e.key || 'none'}`}
                    >
                      <button
                        type="button"
                        className="scr-group-toggle"
                        aria-expanded={!e.collapsed}
                        data-testid={`scr-group-toggle-${e.key || 'none'}`}
                        onClick={() => toggleGroup(e.key)}
                      >
                        {e.collapsed ? (
                          <ChevronRight size={13} aria-hidden="true" />
                        ) : (
                          <ChevronDown size={13} aria-hidden="true" />
                        )}
                        <span className="scr-group-name">{e.key || t('hm.ungrouped')}</span>
                        <span className="scr-group-count rs-num">
                          {t('scr.grp.count', { n: e.agg.count })}
                        </span>
                      </button>
                      <span className="scr-group-agg rs-num">
                        <span title={t('scr.grp.avgTitle')}>
                          {t('scr.grp.avg')}{' '}
                          <span className={changeClass(e.agg.avgChange)}>
                            {fmtSigned(e.agg.avgChange, 2, '%')}
                          </span>
                        </span>
                        <span title={t('scr.grp.capTitle')}>
                          {t('scr.grp.cap')} {fmtCap(e.agg.totalCap)}
                        </span>
                      </span>
                    </div>
                  );
                const s = e.row;
                return (
                  <ResultRow
                    key={s.symbol}
                    s={s}
                    index={range.start + i}
                    q={quotes[s.symbol]}
                    missing={!!missing[s.symbol] && !quotes[s.symbol]}
                    columns={shownColumns}
                    columnDefs={columnDefs}
                    row={server?.rows[s.symbol]}
                    active={s.symbol === focus}
                    current={s.symbol === chartSymbol}
                    onOpen={onOpen}
                    onFocus={onFocus}
                    onMenu={onMenu}
                  />
                );
              })}
              <div role="presentation" style={{ height: (entries.length - range.end) * rowH }} />
            </>
          ) : null}
        </div>
      </div>

      {server?.error ? (
        <div className="scr-empty" data-testid="scr-scan-error" role="alert">
          <SearchX size={30} strokeWidth={1.2} aria-hidden="true" />
          <div className="scr-empty-title">{t('scr.srv.scanFailed')}</div>
          <div className="scr-empty-text">{server.error}</div>
          <button type="button" className="io-btn scr-empty-btn" onClick={server.onRetry}>
            {t('scr.srv.retry')}
          </button>
        </div>
      ) : total === 0 && (loadingQuotes || server?.loading) ? (
        <div className="scr-empty scr-skeleton" data-testid="scr-loading-quotes" role="status">
          <div className="scr-skel-rows" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className="scr-skel-row" />
            ))}
          </div>
          <div className="scr-empty-title">
            {server ? t('scr.srv.scanning') : t('scr.loadingQuotes')}
          </div>
          <div className="scr-empty-text">
            {server ? t('scr.srv.scanningText') : t('scr.loadingQuotesText')}
          </div>
        </div>
      ) : total === 0 ? (
        <div className="scr-empty" data-testid="scr-empty">
          <SearchX size={30} strokeWidth={1.2} aria-hidden="true" />
          <div className="scr-empty-title">
            {conflict ? t('scr.rangeConflictTitle') : t('scr.noMatchTitle')}
          </div>
          <div className="scr-empty-text">{conflict ?? t('scr.noMatchText')}</div>
          <button type="button" className="io-btn scr-empty-btn" onClick={onClearFilters}>
            {t('scr.clearFilters')}
          </button>
        </div>
      ) : (
        <div className="scr-foot" data-testid="scr-foot">
          <span className="scr-foot-count rs-num" data-testid="scr-foot-count">
            {t('scr.showingRange')
              .replace('{from}', String(from))
              .replace('{to}', String(to))
              .replace('{total}', String(total))}
          </span>
          <span className="scr-foot-spacer" />
          {onGroupBy ? (
            <GroupSelect
              testId="scr-groupby"
              value={by}
              options={groupByChoices(!!server).map((g) => ({
                value: g,
                label: t(groupByLabelKey(g, universe, !!server)),
              }))}
              onChange={onGroupBy}
            />
          ) : null}
          <button
            type="button"
            className="io-btn"
            ref={setSizeBtn}
            aria-haspopup="menu"
            data-testid="scr-pagesize-btn"
            onClick={() => setSizeOpen((o) => !o)}
          >
            {pageSize === null ? t('scr.all') : `${pageSize} ${t('scr.rowsUnit')}`}
          </button>
          <DropdownMenu
            anchor={sizeBtn}
            open={sizeOpen}
            onClose={() => setSizeOpen(false)}
            items={sizeItems}
            placement="bottom-end"
          />
          <div className="scr-pager">
            <button
              type="button"
              className="io-btn scr-pager-btn"
              aria-label={t('scr.pagePrev')}
              disabled={page <= 0}
              data-testid="scr-page-prev"
              onClick={() => useScreenerPrefs.getState().setPage(page - 1)}
            >
              <ChevronLeft size={14} />
            </button>
            <span className="scr-pager-info rs-num" data-testid="scr-page-info">
              {t('scr.pageInfo')
                .replace('{page}', String(page + 1))
                .replace('{pages}', String(pages))}
            </span>
            <button
              type="button"
              className="io-btn scr-pager-btn"
              aria-label={t('scr.pageNext')}
              disabled={page >= pages - 1}
              data-testid="scr-page-next"
              onClick={() => useScreenerPrefs.getState().setPage(page + 1)}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
