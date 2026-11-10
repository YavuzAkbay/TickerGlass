import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListPlus, NotebookPen, Plus, Search } from 'lucide-react';
import { commands } from '../../commands/registry';
import { useT } from '../../i18n';
import { useQuoteStore } from '../../quotes/store';
import { downloadBlob } from '../../persist/layouts';
import { useUiStore } from '../../store/ui';
import { toast } from '../../ui/Toast';
import { flagRows, isFlagRef, resolveActive, type SymbolMeta } from '../model';
import { useWatchlistPrefs } from '../prefs';
import { useWatchlistStore } from '../store';
import { type FlagColor, type ListRef, type WatchlistItem } from '../types';
import { WatchlistHeatmap } from '../../heatmap/WatchlistHeatmap';
import { peekSnapshots } from '../../screener/server/snapshot';
import { csvFilename, exportOrder, watchlistCsv } from './pageCsv';
import { filterItems } from './filter';
import { ListTabs } from './ListTabs';
import { OverviewStrip } from './OverviewStrip';
import { PageDetail } from './PageDetail';
import { PageHeader } from './PageHeader';
import { PageTable } from './PageTable';
import { useWatchlistPagePrefs } from './pagePrefs';
import { peekSymbolMeta, useSymbolMetaVersion, wantSymbolMetas } from './symbolMeta';
import './page.css';

/** Full-window watchlists screen (ui store `screen === 'watchlists'`). */
export function WatchlistsPage() {
  const t = useT();
  const lists = useWatchlistStore((s) => s.lists);
  const flags = useWatchlistStore((s) => s.flags);
  const activeId = useWatchlistPrefs((s) => s.activeId);
  const detailOpen = useWatchlistPagePrefs((s) => s.detailOpen);
  const setDetailOpen = useWatchlistPagePrefs((s) => s.setDetailOpen);
  const view = useWatchlistPagePrefs((s) => s.view);
  const setView = useWatchlistPagePrefs((s) => s.setView);

  const active = resolveActive(activeId, lists);
  const isFlag = !!active && isFlagRef(active);

  // Flag lists flatten into plain symbol items (same as the sidebar panel).
  const items: WatchlistItem[] = useMemo(() => {
    if (!active) return [];
    if (isFlag)
      return flagRows(flags, active.slice(5) as FlagColor).flatMap((r) =>
        r.kind === 'symbol' ? [{ type: 'symbol' as const, symbol: r.symbol }] : [],
      );
    return lists[active]?.items ?? [];
  }, [active, isFlag, flags, lists]);

  // Filter matches symbols and resolved names; sections survive when they (or
  // their title) match. Re-runs when names resolve (metaVersion).
  const [filter, setFilter] = useState('');
  const metaVersion = useSymbolMetaVersion();
  const filteredItems = useMemo(
    () => filterItems(items, filter, (sym) => peekSymbolMeta(sym)?.name),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- metaVersion tracks name resolution
    [items, filter, metaVersion],
  );
  // Filtering by name needs every name, not just the mounted rows'.
  const allSymbols = useMemo(
    () => items.flatMap((i) => (i.type === 'symbol' ? [i.symbol] : [])),
    [items],
  );
  const listSymbols = useMemo<ReadonlySet<string>>(() => new Set(allSymbols), [allSymbols]);
  const filtering = filter.trim() !== '';
  useEffect(() => {
    if (!filtering) return;
    wantSymbolMetas('page-filter', allSymbols);
    return () => wantSymbolMetas('page-filter', null);
  }, [filtering, allSymbols]);
  const filteredSymbols = useMemo(
    () => filteredItems.flatMap((i) => (i.type === 'symbol' ? [i.symbol] : [])),
    [filteredItems],
  );

  // Selection (multi) and the focused row (detail pane subject / keyboard cursor).
  const anchorRef = useRef<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  /** The table's displayed symbol order (sorted, collapsed sections omitted), for export. */
  const displayOrderRef = useRef<string[]>([]);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const onSelectionChange = useCallback((symbols: string[], anchor: string | null) => {
    setSelection(new Set(symbols));
    anchorRef.current = anchor;
  }, []);

  // Remembered per-list views of lists that no longer exist go away (flag lists always exist;
  // deleting a list already forgets its view). "Not in the store" only means "deleted" once the
  // server's lists were merged in: before that, lists made on other devices are missing, and
  // pruning would delete their views on every device.
  const listsLoaded = useWatchlistStore((s) => s.loaded);
  const listKey = useMemo(() => Object.keys(lists).join(','), [lists]);
  // Views can arrive (settings sync) after the lists did.
  const viewKey = useWatchlistPagePrefs((s) => Object.keys(s.views).join(','));
  useEffect(() => {
    if (listsLoaded && listKey) useWatchlistPagePrefs.getState().pruneViews(listKey.split(','));
  }, [listsLoaded, listKey, viewKey]);

  // A different list invalidates row-derived state.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on list change
    setFilter('');
    setFocus(null);
    setSelection(new Set());
    anchorRef.current = null;
  }, [active]);

  const openInChart = useCallback((symbol: string) => {
    commands.execute('chart.setSymbol', symbol);
    useUiStore.getState().closeScreen();
  }, []);

  // Escape stages through: clear filter → clear selection → back to charts.
  const stateRef = useRef({ filter: '', selected: 0 });
  useEffect(() => {
    stateRef.current = { filter, selected: selection.size };
  }, [filter, selection]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (useUiStore.getState().dialog) return;
      const target = e.target as Element | null;
      if (target?.closest?.('[data-own-escape], .io-popover, [data-modal-open]')) return;
      if (stateRef.current.filter) {
        e.preventDefault();
        setFilter('');
      } else if (stateRef.current.selected > 1) {
        e.preventDefault();
        setSelection(new Set());
        anchorRef.current = null;
      } else {
        useUiStore.getState().closeScreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const exportCsv = useCallback(() => {
    const ordered = exportOrder(displayOrderRef.current, filteredSymbols);
    if (!ordered.length) {
      toast(t('wlp.exportEmpty'), 'info');
      return;
    }
    const name = active && !isFlag ? (lists[active]?.name ?? 'watchlist') : 'watchlist';
    const all = useQuoteStore.getState().quotes;
    const quotes = Object.fromEntries(ordered.map((s) => [s, all[s]]));
    const meta: Record<string, SymbolMeta | undefined> = {};
    for (const s of ordered) meta[s] = peekSymbolMeta(s) ?? undefined;
    const csv = watchlistCsv(
      ordered,
      quotes,
      meta,
      useWatchlistPagePrefs.getState().columns,
      peekSnapshots(ordered),
    );
    downloadBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }), csvFilename(name));
    toast(t('wlp.exportDone').replace('{n}', String(ordered.length)), 'success');
  }, [filteredSymbols, active, isFlag, lists, t]);

  if (!active) return <NoLists onPick={(id) => useWatchlistPrefs.getState().setActive(id)} />;

  const listEmpty = items.every((i) => i.type !== 'symbol');

  return (
    <div className="wlp-root" role="region" aria-label={t('wlp.title')} data-testid="wlp-root">
      <PageHeader
        onBack={() => useUiStore.getState().closeScreen()}
        active={active}
        onExportCsv={exportCsv}
        detailOpen={detailOpen}
        onToggleDetail={() => setDetailOpen(!detailOpen)}
        view={view}
        onViewChange={setView}
      />
      <ListTabs active={active} onPick={(ref) => useWatchlistPrefs.getState().setActive(ref)} />
      <OverviewStrip symbols={filteredSymbols} />
      <div className={`wlp-main${detailOpen ? '' : ' no-detail'}`}>
        {view === 'heatmap' ? (
          <WatchlistHeatmap
            listRef={active}
            items={filteredItems}
            filter={filter}
            onFilterChange={setFilter}
            focus={focus}
            onFocus={setFocus}
            onOpen={openInChart}
            listEmpty={listEmpty}
          />
        ) : (
          <PageTable
            listRef={active}
            items={filteredItems}
            filter={filter}
            onFilterChange={setFilter}
            active={focus}
            onActive={setFocus}
            selection={selection}
            onSelectionChange={onSelectionChange}
            onOpen={openInChart}
            listEmpty={listEmpty}
            listSymbols={listSymbols}
            orderRef={displayOrderRef}
          />
        )}
        {detailOpen ? (
          <PageDetail
            symbol={focus}
            listRef={active}
            onOpen={openInChart}
            onClose={() => setFocus(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

/** First-run state: no watchlists exist yet. */
function NoLists({ onPick }: { onPick: (id: ListRef) => void }) {
  const t = useT();
  void onPick; // creating a list activates it via the command itself
  return (
    <div className="wlp-root" role="region" aria-label={t('wlp.title')}>
      <PageHeader
        minimal
        onBack={() => useUiStore.getState().closeScreen()}
        active={null}
        onExportCsv={() => undefined}
        detailOpen={false}
        onToggleDetail={() => undefined}
      />
      <div className="wlp-nolists">
        <ListPlus size={40} strokeWidth={1.1} aria-hidden="true" />
        <div className="wlp-empty-title">{t('wlp.noListsTitle')}</div>
        <div className="wlp-empty-text">{t('wlp.noListsText')}</div>
        <div className="wlp-nolists-actions">
          <button
            type="button"
            className="io-btn io-btn-primary"
            onClick={() => commands.execute('watchlist.create')}
          >
            <Plus size={14} />
            {t('wlp.newList')}
          </button>
          <button
            type="button"
            className="io-btn"
            onClick={() => commands.execute('watchlist.import')}
          >
            <NotebookPen size={14} />
            {t('wlp.importList')}
          </button>
          <button
            type="button"
            className="io-btn"
            onClick={() => commands.execute('watchlist.searchAdd')}
          >
            <Search size={14} />
            {t('wlp.addSymbol')}
          </button>
        </div>
      </div>
    </div>
  );
}
