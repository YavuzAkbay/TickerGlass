import { ChartLine, ListPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { commands } from '../../commands/registry';
import { ScreenerHeatmap } from '../../heatmap/ScreenerHeatmap';
import { HEATMAP_LIVE_CAP } from '../../heatmap/metrics';
import { useT } from '../../i18n';
import { useLiveQuotes } from '../../quotes/hooks';
import { useQuoteStore } from '../../quotes/store';
import { downloadBlob } from '../../persist/layouts';
import { useUiStore } from '../../store/ui';
import { useContextMenuOpen } from '../../ui/ContextMenu';
import type { MenuItem } from '../../ui/Menu';
import { useStableOrder } from '../../ui/useStableOrder';
import { toast } from '../../ui/Toast';
import { sortedLists } from '../../watchlist/model';
import { useWatchlistStore } from '../../watchlist/store';
import {
  applyLiveFilters,
  CLASS_LABEL,
  countFilters,
  effectiveUniverseSize,
  EMPTY_FILTERS,
  hasQuoteFilters,
  invalidRanges,
  sanitizeFilters,
  scanPlan,
  sortResults,
  type RangeFilter,
  type ScreenerFilters,
} from '../model';
import { presetOf } from '../presets';
import { useScreenerPrefs } from '../screenerPrefs';
import { screenerCsv, screenerCsvFilename } from '../screenerCsv';
import { getUniverse } from '../universe';
import { SCREENER_CLASSES, type ScreenerClass, type Universe } from '../universe/types';
import { screenerMode } from '../server/mode';
import { useScreenerStatus } from '../server/hooks';
import type { StatusResponse } from '../server/types';
import { addAllToList, openInChart, openRowMenu } from './actions';
import { ClassTabs } from './ClassTabs';
import { FilterBar } from './FilterBar';
import { ResultsTable, type HoldKind } from './ResultsTable';
import { ScanStrip } from './ScanStrip';
import { ScreenerDetail } from './ScreenerDetail';
import { ScreenerHeader } from './ScreenerHeader';
import { ServerScreener } from './ServerScreener';
import { SnapshotBanner } from './SnapshotBanner';
import { useStickyRows } from './useStickyRows';
import './page.css';

/** The live order commits at most this often (ms). */
const ORDER_INTERVAL_MS = 1500;

const symbolOf = (s: { symbol: string }): string => s.symbol;

/**
 * Full-window market screener (ui store `screen === 'screener'`). Two engines
 * behind one page: with a finished server snapshot (`status.supported && asOf`) the
 * rules, sorting and paging run on the server (`ServerScreener`); otherwise the
 * live-only client screener below runs, with the snapshot banner explaining why.
 */
export function ScreenerPage() {
  const t = useT();
  const { status, loaded, refresh } = useScreenerStatus();
  if (!loaded)
    return (
      <div className="scr-root" role="region" aria-label={t('scr.title')} data-testid="scr-root">
        <ScreenerHeader
          onBack={() => useUiStore.getState().closeScreen()}
          onExportCsv={() => undefined}
          detailOpen={false}
          onToggleDetail={() => undefined}
        />
        <div className="scr-loading" aria-live="polite">
          <ChartLine size={34} strokeWidth={1.1} aria-hidden="true" />
          <div className="scr-empty-title">{t('scr.loading')}</div>
        </div>
      </div>
    );
  return screenerMode(status) === 'server' && status ? (
    <ServerScreener status={status} onRefresh={refresh} />
  ) : (
    <ClientScreener status={status} onRefresh={refresh} />
  );
}

/**
 * The live-only screener. Scans a static universe with live quotes; filtering,
 * sorting and paging are all client-side. Static filters (search, group, exchange, cap) cut the
 * whole class universe first, then only the top N of what is left is
 * subscribed for quotes, so quote demand is bounded by the universe option and
 * never by the result count. Price / change / volume bounds can only judge
 * those subscribed symbols.
 */
function ClientScreener({
  status,
  onRefresh,
}: {
  status: StatusResponse | null;
  onRefresh: () => void;
}) {
  const t = useT();
  const prefs = useScreenerPrefs();
  const {
    tab,
    filters,
    sort,
    pageSize,
    universeSize,
    columns,
    density,
    detailOpen,
    view,
    groupBy,
  } = prefs;
  const heat = view === 'heatmap';
  const searchRef = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState<string | null>(null);

  // Class universes come from the API (cached for the session). A class the API could not
  // supply shows an error state with a Retry, never a stale bundled copy.
  const [loaded, setLoaded] = useState<Partial<Record<ScreenerClass, Universe>>>({});
  const [failed, setFailed] = useState<Partial<Record<ScreenerClass, boolean>>>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    for (const cls of SCREENER_CLASSES) {
      if (loaded[cls] || failed[cls]) continue;
      void getUniverse(cls).then(
        (u) => {
          if (live) setLoaded((prev) => ({ ...prev, [cls]: u }));
        },
        () => {
          if (live) setFailed((prev) => ({ ...prev, [cls]: true }));
        },
      );
    }
    return () => {
      live = false;
    };
  }, [loaded, failed, attempt]);
  const retryUniverse = useCallback(() => {
    setFailed({});
    setAttempt((n) => n + 1);
  }, []);

  const universe = loaded[tab];
  // The heatmap draws the filtered set of at most the largest HEATMAP_LIVE_CAP symbols.
  const tableScan = effectiveUniverseSize(pageSize, universeSize);
  const scanSize = heat ? Math.min(tableScan ?? HEATMAP_LIVE_CAP, HEATMAP_LIVE_CAP) : tableScan;
  // A saved group/exchange the universe no longer has falls back to "all".
  const classFilters: ScreenerFilters = useMemo(
    () => (universe ? sanitizeFilters(filters[tab], universe) : filters[tab]),
    [universe, filters, tab],
  );
  const plan = useMemo(
    () =>
      universe
        ? scanPlan(universe.symbols, classFilters, scanSize)
        : { candidates: [], scanned: [] },
    [universe, classFilters, scanSize],
  );
  const scanSymbols = useMemo(() => plan.scanned.map(symbolOf), [plan.scanned]);
  // Extended-hours quotes only when a column needs them (same as the watchlist table).
  const ext = columns.includes('extChangePercent');
  const quotes = useLiveQuotes(scanSymbols, { ext });
  const missing = useQuoteStore((s) => s.missing);

  const setFilters = useCallback(
    (f: ScreenerFilters) =>
      useScreenerPrefs.getState().setFilters(useScreenerPrefs.getState().tab, f),
    [],
  );
  const noFilters = useCallback(
    (): ScreenerFilters => ({
      ...classFilters,
      search: '',
      group: null,
      exchange: null,
      priceMin: null,
      priceMax: null,
      chgMin: null,
      chgMax: null,
      volMin: null,
      volMax: null,
      capMin: null,
    }),
    [classFilters],
  );

  // Persist the fallback so the stored filters match what is shown.
  useEffect(() => {
    if (universe && classFilters !== filters[tab]) setFilters(classFilters);
  }, [universe, classFilters, filters, tab, setFilters]);

  const capKind = universe?.capKind ?? null;
  const quoteBound = hasQuoteFilters(classFilters) || classFilters.capMin !== null;
  const matching = useMemo(
    () => applyLiveFilters(plan.scanned, quotes, classFilters, capKind),
    [plan.scanned, quotes, classFilters, capKind],
  );

  // Freeze the live order while the user is reading: pointer over the rows, the
  // keyboard in the grid, a context menu open, or the Paused toggle.
  const [hold, setHold] = useState({ pointer: false, focus: false });
  const menuOpen = useContextMenuOpen();
  const [manualPause, setManualPause] = useState(false);
  const onHold = useCallback((kind: HoldKind, on: boolean) => {
    setHold((h) => (h[kind] === on ? h : { ...h, [kind]: on }));
  }, []);
  const held = hold.pointer || hold.focus || menuOpen;
  const frozen = manualPause || held;
  const holdReason = menuOpen ? 'menu' : hold.focus ? 'focus' : hold.pointer ? 'pointer' : null;

  // Anything the user changed applies at once; only quote ticks are smoothed.
  const intent = `${tab}|${scanSize}|${sort?.key}:${sort?.dir}|${JSON.stringify(classFilters)}`;
  const [seenIntent, setSeenIntent] = useState(intent);
  const intentChanged = seenIntent !== intent;
  if (intentChanged) setSeenIntent(intent);

  const kept = useStickyRows(matching, symbolOf, {
    resetKey: intent,
    frozen: frozen && !intentChanged,
  });
  const sorted = useMemo(
    () => sortResults(kept, sort, quotes, capKind),
    [kept, sort, quotes, capKind],
  );
  const filtered = useStableOrder(sorted, symbolOf, {
    intervalMs: intentChanged ? 0 : ORDER_INTERVAL_MS,
    frozen: frozen && !intentChanged,
  });

  const pendingQuotes = useMemo(
    () => scanSymbols.some((sym) => !quotes[sym] && !missing[sym]),
    [scanSymbols, quotes, missing],
  );
  const conflicts: RangeFilter[] = invalidRanges(classFilters);
  const conflictText = conflicts.length
    ? t('scr.rangeConflict').replace(
        '{filter}',
        conflicts
          .map((r) =>
            t(r === 'price' ? 'scr.rangePrice' : r === 'chg' ? 'scr.rangeChg' : 'scr.rangeVol'),
          )
          .join(', '),
      )
    : null;

  // A different class invalidates row-derived state.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on class change
    setFocus(null);
  }, [tab]);

  const rowMenu = useCallback(
    (symbol: string, x: number, y: number) => openRowMenu(symbol, x, y, t),
    [t],
  );

  // Escape stages through: clear filters → clear focus → back to charts.
  const filterCount = useScreenerPrefs((s) => countFilters(s.filters[s.tab]));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (useUiStore.getState().dialog) return;
      const target = e.target as Element | null;
      if (target?.closest?.('[data-own-escape], .io-popover, [data-modal-open]')) return;
      if (filterCount > 0) {
        e.preventDefault();
        useScreenerPrefs
          .getState()
          .setFilters(useScreenerPrefs.getState().tab, { ...EMPTY_FILTERS });
      } else if (focus) {
        e.preventDefault();
        setFocus(null);
      } else {
        useUiStore.getState().closeScreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filterCount, focus, classFilters]);

  // Latest displayed rows for menu actions that outlive a render.
  const filteredRef = useRef(filtered);
  useEffect(() => {
    filteredRef.current = filtered;
  }, [filtered]);

  const exportCsv = useCallback(() => {
    const rows = filteredRef.current;
    if (!universe || !rows.length) {
      toast(t('scr.exportEmpty'), 'info');
      return;
    }
    const all = useQuoteStore.getState().quotes;
    const quoted = Object.fromEntries(rows.map((s) => [s.symbol, all[s.symbol]]));
    // Displayed (sorted) order, visible columns only.
    const csv = screenerCsv(universe, rows, quoted, columns);
    downloadBlob(
      new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }),
      screenerCsvFilename(tab),
    );
    toast(t('scr.exportDone').replace('{n}', String(rows.length)), 'success');
  }, [universe, columns, tab, t]);

  const addAllTo = useCallback(
    (listId: string) => addAllToList(listId, filteredRef.current.map(symbolOf), t),
    [t],
  );

  const watchlists = useWatchlistStore((s) => s.lists);
  const bulkItems: MenuItem[] = useMemo(() => {
    const lists = sortedLists(watchlists);
    return [
      {
        label: t('scr.addAllWatchlist').replace('{n}', String(filtered.length)),
        icon: ListPlus,
        disabled: filtered.length === 0,
        submenu: lists.length
          ? lists.map((l) => ({ label: l.name, onSelect: () => addAllTo(l.id) }))
          : [{ label: t('scr.noLists'), onSelect: () => commands.execute('watchlist.create') }],
      },
    ];
  }, [watchlists, filtered.length, addAllTo, t]);

  const total = universe?.symbols.length ?? 0;
  const universeInfo = !universe
    ? ''
    : plan.candidates.length < total
      ? plan.scanned.length < plan.candidates.length
        ? t('scr.scanInfoFiltered')
            .replace('{n}', String(plan.scanned.length))
            .replace('{matches}', String(plan.candidates.length))
            .replace('{total}', String(total))
        : t('scr.matchInfoAll')
            .replace('{matches}', String(plan.candidates.length))
            .replace('{total}', String(total))
      : scanSize === null
        ? t('scr.universeInfoAll').replace('{total}', String(total))
        : t('scr.universeInfo')
            .replace('{n}', String(Math.min(scanSize, total)))
            .replace('{total}', String(total));
  const liveNote = quoteBound
    ? t('scr.liveNote').replace('{n}', String(plan.scanned.length))
    : null;

  return (
    <div className="scr-root" role="region" aria-label={t('scr.title')} data-testid="scr-root">
      <ScreenerHeader
        onBack={() => useUiStore.getState().closeScreen()}
        onExportCsv={exportCsv}
        extraItems={bulkItems}
        detailOpen={detailOpen}
        onToggleDetail={() => useScreenerPrefs.getState().setDetailOpen(!detailOpen)}
        view={view}
        onViewChange={(v) => useScreenerPrefs.getState().setView(v)}
      />
      <SnapshotBanner status={status} onRefresh={onRefresh} />
      <ClassTabs
        active={tab}
        onPick={(cls) => useScreenerPrefs.getState().setTab(cls)}
        loaded={loaded}
      />
      {universe ? (
        <>
          <FilterBar
            universe={universe}
            filters={classFilters}
            onFilters={setFilters}
            preset={presetOf(sort)}
            onPreset={(p) => useScreenerPrefs.getState().setPreset(p)}
            searchRef={searchRef}
          />
          <ScanStrip
            cls={tab}
            scanSymbols={scanSymbols}
            filters={classFilters}
            onFilters={setFilters}
            universeInfo={universeInfo}
            liveNote={liveNote}
            sortLive={!frozen}
            manualPause={manualPause}
            holdReason={holdReason}
            onTogglePause={() => setManualPause((p) => !p)}
            loading={scanSymbols.every((s) => !quotes[s])}
          />
          <div className={`scr-main${detailOpen ? '' : ' no-detail'}`}>
            {heat ? (
              <ScreenerHeatmap
                universe={universe}
                rows={filtered}
                quotes={quotes}
                groupBy={groupBy}
                onGroupBy={(by) => useScreenerPrefs.getState().setGroupBy(by)}
                focus={focus}
                onFocus={setFocus}
                onOpen={openInChart}
                onMenu={rowMenu}
                loading={scanSymbols.every((s) => !quotes[s])}
                liveCount={scanSymbols.length}
              />
            ) : (
              <ResultsTable
                universe={universe}
                rows={filtered}
                quotes={quotes}
                missing={missing}
                loadingQuotes={quoteBound && pendingQuotes}
                conflict={conflictText}
                onHold={onHold}
                columns={columns}
                sort={sort}
                pageSize={pageSize}
                density={density}
                focus={focus}
                onFocus={setFocus}
                onOpen={openInChart}
                onMenu={rowMenu}
                searchRef={searchRef}
                onClearFilters={() => setFilters(noFilters())}
                groupBy={groupBy}
                onGroupBy={(by) => useScreenerPrefs.getState().setGroupBy(by)}
              />
            )}
            {detailOpen ? (
              <ScreenerDetail
                symbol={focus}
                universe={universe}
                onOpen={openInChart}
                onClose={() => setFocus(null)}
              />
            ) : null}
          </div>
        </>
      ) : failed[tab] ? (
        <div className="scr-loading" role="alert" data-testid="scr-universe-error">
          <ChartLine size={34} strokeWidth={1.1} aria-hidden="true" />
          <div className="scr-empty-title">{t('scr.universeUnavailable')}</div>
          <div className="scr-empty-text">
            {t('scr.classLabel').replace('{class}', CLASS_LABEL[tab])}
          </div>
          <button type="button" className="io-btn scr-empty-btn" onClick={retryUniverse}>
            {t('scr.universeRetry')}
          </button>
        </div>
      ) : (
        <div className="scr-loading" aria-live="polite">
          <ChartLine size={34} strokeWidth={1.1} aria-hidden="true" />
          <div className="scr-empty-title">{t('scr.loading')}</div>
          <div className="scr-empty-text">
            {t('scr.classLabel').replace('{class}', CLASS_LABEL[tab])}
          </div>
        </div>
      )}
    </div>
  );
}
