import { ListPlus, ListFilter, Settings2, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import {
  HEATMAP_SCAN_FIELDS,
  ScreenerHeatmap,
  liveHeatmapSymbols,
} from '../../heatmap/ScreenerHeatmap';
import { HEATMAP_LIVE_CAP } from '../../heatmap/metrics';
import { useT } from '../../i18n';
import { downloadBlob } from '../../persist/layouts';
import { useLiveQuotes } from '../../quotes/hooks';
import { useQuoteStore } from '../../quotes/store';
import { useUiStore } from '../../store/ui';
import { DropdownMenu, type MenuItem } from '../../ui/Menu';
import { toast } from '../../ui/Toast';
import { useStableOrder } from '../../ui/useStableOrder';
import { sortedLists } from '../../watchlist/model';
import { useWatchlistStore } from '../../watchlist/store';
import { commands } from '../../commands/registry';
import { sortResults, EMPTY_FILTERS } from '../model';
import { FormulaColumnDialog } from '../rules/FormulaColumnDialog';
import { RuleBuilder } from '../rules/RuleBuilder';
import {
  countRules,
  parseGroup,
  serializeGroup,
  summarize,
  toRequest,
  type EditGroup,
} from '../rules/rules';
import { serverScreenerCsv, screenerCsvFilename } from '../screenerCsv';
import { useScreenerPrefs } from '../screenerPrefs';
import { MAX_LIMIT, scanAll, scanErrorDetail, scanKey } from '../server/api';
import { formulaColumnDef, serverColumnDefs } from '../server/columnDefs';
import {
  columnSortField,
  firstDir,
  formulaOfColumn,
  isFormulaColumn,
  MAX_FORMULA_COLUMNS,
  LIVE_SORT_FIELDS,
  requestFields,
  SERVER_ALL_COLUMNS,
  SERVER_PAGE_SIZES,
} from '../server/columns';
import { useFields, useLists, usePresets, useScan } from '../server/hooks';
import { specKey } from '../server/spec';
import type { ScanRequest, ScreenSpec, StatusResponse } from '../server/types';
import { getUniverse } from '../universe';
import { SCREENER_CLASSES, type ScreenerClass, type Universe } from '../universe/types';
import { addAllToList, openInChart, openRowMenu } from './actions';
import { ResultsTable } from './ResultsTable';
import { SavedScreensMenu } from './SavedScreensMenu';
import { ScanStrip } from './ScanStrip';
import { ScreenerDetail } from './ScreenerDetail';
import { ScreenerHeader } from './ScreenerHeader';
import { SnapshotBanner } from './SnapshotBanner';
import { UniversePicker } from './UniversePicker';
import { useHold } from './useHold';

/** The live order commits at most this often (ms). */
const ORDER_INTERVAL_MS = 1500;
const symbolOf = (s: { symbol: string }): string => s.symbol;

interface Props {
  status: StatusResponse;
  onRefresh: () => void;
}

/**
 * Server-mode screener: rules and sorting run on the server snapshot (`POST /screener/scan`,
 * DB only), the table pages through the answer, and live quotes are subscribed for the
 * visible page only and overlay the snapshot's last / change / volume.
 */
export function ServerScreener({ status, onRefresh }: Props) {
  const t = useT();
  const draft = useScreenerPrefs((s) => s.draft);
  const page = useScreenerPrefs((s) => s.page);
  const pageSize = useScreenerPrefs((s) => s.pageSize);
  const serverColumns = useScreenerPrefs((s) => s.serverColumns);
  const formulaLabels = useScreenerPrefs((s) => s.formulaLabels);
  const [fxColumnOpen, setFxColumnOpen] = useState(false);
  const density = useScreenerPrefs((s) => s.density);
  const detailOpen = useScreenerPrefs((s) => s.detailOpen);
  const activeScreenId = useScreenerPrefs((s) => s.activeScreenId);
  const view = useScreenerPrefs((s) => s.view);
  const groupBy = useScreenerPrefs((s) => s.groupBy);
  const heat = view === 'heatmap';
  const watchlists = useWatchlistStore((s) => s.lists);
  const searchRef = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState<string | null>(null);

  const tableLimit = Math.min(pageSize ?? MAX_LIMIT, MAX_LIMIT);
  // The heatmap draws one result set: the server's largest answer, never a page of it.
  const limit = heat ? MAX_LIMIT : tableLimit;
  const { fields, failed: fieldsFailed } = useFields(true);
  const presets = usePresets(true);
  const lists = useLists(true);

  // Class universes: tab counts and the offline name lookup.
  const [loaded, setLoaded] = useState<Partial<Record<ScreenerClass, Universe>>>({});
  useEffect(() => {
    let live = true;
    for (const cls of SCREENER_CLASSES) {
      void getUniverse(cls).then(
        (u) => {
          if (live) setLoaded((prev) => (prev[cls] ? prev : { ...prev, [cls]: u }));
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, []);

  // ---- rules: the draft keeps incomplete rows; only complete ones reach the prefs / scan.
  const [rb, setRb] = useState<EditGroup>(() =>
    parseGroup(useScreenerPrefs.getState().draft.filter),
  );
  const [rbOpen, setRbOpen] = useState(() => useScreenerPrefs.getState().draft.filter !== null);
  const editRules = useCallback((next: EditGroup) => {
    setRb(next);
    useScreenerPrefs.getState().setDraftFilter(serializeGroup(next));
  }, []);
  const loadSpec = useCallback((spec: ScreenSpec, id: string | null) => {
    useScreenerPrefs.getState().applySpec(spec, id);
    setRb(parseGroup(spec.filter));
    setRbOpen(spec.filter !== null);
    setFocus(null);
  }, []);

  const built = useMemo(() => (fields ? toRequest(rb, fields) : null), [rb, fields]);
  const filter = built ? built.filter : fieldsFailed ? serializeGroup(rb) : undefined;
  const req = useMemo<ScanRequest | null>(() => {
    if (filter === undefined || built?.blocking) return null;
    return {
      universe: draft.universe,
      filter,
      sort: draft.sort,
      limit,
      offset: heat ? 0 : page * limit,
      fields: [
        ...new Set([
          ...requestFields(serverColumns, draft.sort.field),
          // Sector grouping and the group aggregates need the sector and market cap.
          ...(heat ? HEATMAP_SCAN_FIELDS : groupBy === 'none' ? [] : ['sector', 'mcap']),
        ]),
      ],
    };
  }, [filter, built, draft.universe, draft.sort, limit, page, serverColumns, heat, groupBy]);
  const scan = useScan(req);

  // ---- rows of the visible page
  const data = scan.data;
  const pageRows = useMemo(
    () =>
      (data?.rows ?? []).map((r, i) => ({
        symbol: r.symbol,
        name: r.name,
        group: r.group,
        rank: (data?.offset ?? 0) + i + 1,
        ...(r.exchange ? { exchange: r.exchange } : {}),
      })),
    [data],
  );
  const snap = useMemo(
    () => Object.fromEntries((data?.rows ?? []).map((r) => [r.symbol, r])),
    [data],
  );
  const pageSymbols = useMemo(
    () => (heat ? liveHeatmapSymbols(pageRows, snap, HEATMAP_LIVE_CAP) : pageRows.map(symbolOf)),
    [heat, pageRows, snap],
  );
  const quotes = useLiveQuotes(pageSymbols);
  const missing = useQuoteStore((s) => s.missing);

  // Live overlays may re-order the page when it is sorted by a quote field; the server order
  // otherwise. Same hold / pause rules as the client table.
  const { onHold, manualPause, togglePause, frozen, holdReason } = useHold();
  const liveKey = LIVE_SORT_FIELDS[draft.sort.field];
  const liveSorted = useMemo(
    () =>
      liveKey ? sortResults(pageRows, { key: liveKey, dir: draft.sort.dir }, quotes) : pageRows,
    [pageRows, liveKey, draft.sort.dir, quotes],
  );
  const intent = req ? scanKey(req) : '';
  const [seenIntent, setSeenIntent] = useState(intent);
  const intentChanged = seenIntent !== intent;
  if (intentChanged) setSeenIntent(intent);
  const stable = useStableOrder(liveSorted, symbolOf, {
    intervalMs: intentChanged ? 0 : ORDER_INTERVAL_MS,
    frozen: frozen && !intentChanged,
  });
  const ordered = liveKey ? stable : pageRows;
  const orderedRef = useRef(ordered);
  useEffect(() => {
    orderedRef.current = ordered;
  }, [ordered]);

  const tabCls: ScreenerClass = draft.universe.kind === 'class' ? draft.universe.cls : 'stocks';
  const synthetic: Universe = useMemo(
    () => ({
      cls: tabCls,
      groupLabel: 'sector',
      capKind: 'mcap',
      symbols: pageRows,
      groups: [],
      exchanges: [],
    }),
    [tabCls, pageRows],
  );
  const formulaColumns = useMemo(() => serverColumns.filter(isFormulaColumn), [serverColumns]);
  const columnLabel = useCallback(
    (id: (typeof formulaColumns)[number]) => formulaLabels[id] || formulaOfColumn(id),
    [formulaLabels],
  );
  const columnDefs = useMemo(() => {
    const defs = serverColumnDefs(synthetic);
    for (const id of formulaColumns) defs[id] = formulaColumnDef(id, columnLabel(id));
    return defs;
  }, [synthetic, formulaColumns, columnLabel]);

  // ---- sort
  const onSort = useCallback((field: string) => {
    const cur = useScreenerPrefs.getState().draft.sort;
    useScreenerPrefs
      .getState()
      .setDraftSort(
        cur.field !== field
          ? { field, dir: firstDir(field) }
          : { field, dir: cur.dir === 'asc' ? 'desc' : 'asc' },
      );
  }, []);

  // ---- derived text
  const summary = useMemo(
    () => (built?.filter ? summarize(built.filter, fields ?? []) : ''),
    [built, fields],
  );
  const ruleCount = countRules(rb);
  const scanError = scan.error
    ? (scanErrorDetail(scan.error)?.message ?? errorMessage(scan.error))
    : null;
  const universeInfo = data
    ? data.coverage.withSnapshot < data.coverage.universe
      ? t('scr.srv.matchesPartial')
          .replace('{total}', String(data.total))
          .replace('{universe}', String(data.coverage.universe))
          .replace('{snap}', String(data.coverage.withSnapshot))
      : t('scr.srv.matches')
          .replace('{total}', String(data.total))
          .replace('{universe}', String(data.coverage.universe))
    : '';

  // ---- actions
  const clearRules = useCallback(() => editRules(parseGroup(null)), [editRules]);
  const exportCsv = useCallback(async () => {
    if (!req) {
      toast(t('scr.exportEmpty'), 'info');
      return;
    }
    try {
      const { universe, filter: f, sort, fields: flds } = req;
      const all = await scanAll({ universe, filter: f, sort, ...(flds ? { fields: flds } : {}) });
      if (!all.rows.length) {
        toast(t('scr.exportEmpty'), 'info');
        return;
      }
      const csv = serverScreenerCsv(all.rows, serverColumns, formulaLabels);
      downloadBlob(
        new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }),
        screenerCsvFilename(draft.universe.kind === 'class' ? draft.universe.cls : 'custom'),
      );
      toast(
        (all.truncated ? t('scr.srv.exportTruncated') : t('scr.exportDone'))
          .replace('{n}', String(all.rows.length))
          .replace('{total}', String(all.total)),
        'success',
      );
    } catch (e) {
      toast(t('scr.srv.exportFailed').replace('{error}', errorMessage(e)), 'error');
    }
  }, [req, serverColumns, formulaLabels, draft.universe, t]);

  const bulkItems: MenuItem[] = useMemo(() => {
    const mine = sortedLists(watchlists);
    return [
      {
        label: t('scr.addAllWatchlist').replace('{n}', String(ordered.length)),
        icon: ListPlus,
        disabled: ordered.length === 0,
        submenu: mine.length
          ? mine.map((l) => ({
              label: l.name,
              onSelect: () => addAllToList(l.id, orderedRef.current.map(symbolOf), t),
            }))
          : [{ label: t('scr.noLists'), onSelect: () => commands.execute('watchlist.create') }],
      },
    ];
  }, [watchlists, ordered.length, t]);

  // Escape: leave a rule field first, then clear focus, then close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (useUiStore.getState().dialog) return;
      const target = e.target as Element | null;
      if (target?.closest?.('[data-own-escape], .io-popover, [data-modal-open]')) return;
      if (target?.closest?.('.rb, .scr-screens')) {
        (target as HTMLElement).blur?.();
        e.preventDefault();
        return;
      }
      if (focus) {
        e.preventDefault();
        setFocus(null);
      } else {
        useUiStore.getState().closeScreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus]);

  // ---- options menu
  const [optsBtn, setOptsBtn] = useState<HTMLButtonElement | null>(null);
  const [optsOpen, setOptsOpen] = useState(false);
  const optionsItems: MenuItem[] = [
    {
      label: t('scr.rows'),
      submenu: SERVER_PAGE_SIZES.map((n): MenuItem => ({
        label: String(n),
        checked: n === tableLimit,
        onSelect: () => useScreenerPrefs.getState().setPageSize(n),
      })),
    },
    {
      label: t('scr.columns'),
      submenu: [
        ...SERVER_ALL_COLUMNS.map((id): MenuItem => ({
          label: columnDefs[id]?.title ?? id,
          checked: serverColumns.includes(id),
          onSelect: () => useScreenerPrefs.getState().toggleServerColumn(id),
        })),
        { type: 'separator' },
        // Formula columns: checked while shown; selecting one removes it.
        ...formulaColumns.map((id): MenuItem => ({
          label: columnLabel(id),
          title: `${t('scr.fx.colRemove')}: ${formulaOfColumn(id)}`,
          checked: true,
          onSelect: () => useScreenerPrefs.getState().removeFormulaColumn(id),
        })),
        {
          label: t('scr.fx.colMenu'),
          disabled: formulaColumns.length >= MAX_FORMULA_COLUMNS || !fields,
          title:
            formulaColumns.length >= MAX_FORMULA_COLUMNS
              ? t('scr.fx.colLimit', { n: MAX_FORMULA_COLUMNS })
              : t('scr.fx.colMenuTitle'),
          onSelect: () => setFxColumnOpen(true),
        },
      ],
    },
    {
      label: t('scr.density'),
      submenu: (
        [
          ['compact', 'scr.densityCompact'],
          ['cozy', 'scr.densityCozy'],
        ] as const
      ).map(([d, key]): MenuItem => ({
        label: t(key),
        checked: density === d,
        onSelect: () => useScreenerPrefs.getState().setDensity(d),
      })),
    },
  ];

  const spec: ScreenSpec = draft;
  const specNow = specKey(spec);

  return (
    <div
      className="scr-root"
      role="region"
      aria-label={t('scr.title')}
      data-testid="scr-root"
      data-mode="server"
    >
      <ScreenerHeader
        onBack={() => useUiStore.getState().closeScreen()}
        onExportCsv={() => void exportCsv()}
        extraItems={bulkItems}
        detailOpen={detailOpen}
        onToggleDetail={() => useScreenerPrefs.getState().setDetailOpen(!detailOpen)}
        view={view}
        onViewChange={(v) => useScreenerPrefs.getState().setView(v)}
        stamp={{
          text: status.asOf ?? '',
          title: t('scr.srv.stampTitle').replace('{date}', status.asOf ?? ''),
        }}
      />
      <SnapshotBanner status={status} onRefresh={onRefresh} />
      <UniversePicker
        value={draft.universe}
        onPick={(u) => useScreenerPrefs.getState().setUniverse(u)}
        loaded={loaded}
        lists={lists}
        serverMode
      />
      <div className="scr-toolbar" data-testid="scr-srv-toolbar">
        <SavedScreensMenu
          draft={draft}
          columns={serverColumns}
          activeId={activeScreenId}
          presets={presets}
          onLoad={loadSpec}
          onActive={(id) => useScreenerPrefs.getState().setActiveScreen(id)}
        />
        <button
          type="button"
          className={`scr-tool-btn scr-rules-btn${ruleCount > 0 ? ' on' : ''}`}
          aria-expanded={rbOpen}
          aria-controls="scr-rules-panel"
          data-testid="scr-rules-btn"
          onClick={() => setRbOpen((o) => !o)}
        >
          <ListFilter size={14} strokeWidth={1.6} aria-hidden="true" />
          {t('scr.rb.title')}
          {ruleCount > 0 ? <span className="scr-badge rs-num">{ruleCount}</span> : null}
        </button>
        <span className="scr-rule-summary" title={summary} data-testid="scr-rule-summary">
          {summary || t('scr.rb.noRules')}
        </span>
        <span className="scr-toolbar-spacer" />
        <button
          type="button"
          ref={setOptsBtn}
          className="scr-tool-btn"
          aria-haspopup="menu"
          aria-label={t('scr.options')}
          data-testid="scr-options-btn"
          onClick={() => setOptsOpen((o) => !o)}
        >
          <Settings2 size={14} strokeWidth={1.6} />
        </button>
        <DropdownMenu
          anchor={optsBtn}
          open={optsOpen}
          onClose={() => setOptsOpen(false)}
          items={optionsItems}
          placement="bottom-end"
        />
      </div>
      {rbOpen ? (
        <div id="scr-rules-panel">
          {fields ? (
            <RuleBuilder
              draft={rb}
              onChange={editRules}
              fields={fields}
              issues={built?.issues ?? []}
            />
          ) : (
            <div className="rb rb-loading">
              {fieldsFailed ? t('scr.rb.fieldsFailed') : t('scr.loading')}
            </div>
          )}
        </div>
      ) : null}
      {presets.length ? (
        <div
          className="scr-presets"
          role="group"
          aria-label={t('scr.presets')}
          data-testid="scr-presets"
        >
          <Zap size={12} strokeWidth={1.6} aria-hidden="true" className="scr-presets-label" />
          {presets.map((p) => {
            const spec2: ScreenSpec = { ...p.spec, universe: draft.universe };
            const on = specKey(spec2) === specNow;
            return (
              <button
                key={p.id}
                type="button"
                className={`scr-preset-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                data-testid={`scr-preset-${p.id}`}
                onClick={() => loadSpec(on ? { ...spec2, filter: null } : spec2, null)}
              >
                {p.name}
              </button>
            );
          })}
        </div>
      ) : null}
      <ScanStrip
        cls={tabCls}
        scanSymbols={pageSymbols}
        filters={EMPTY_FILTERS}
        onFilters={() => undefined}
        universeInfo={universeInfo}
        liveNote={null}
        sortLive={!frozen}
        manualPause={manualPause}
        holdReason={holdReason}
        onTogglePause={togglePause}
        loading={scan.loading}
      />
      <div className={`scr-main${detailOpen ? '' : ' no-detail'}`}>
        {heat ? (
          <ScreenerHeatmap
            universe={synthetic}
            rows={pageRows}
            quotes={quotes}
            snap={snap}
            groupBy={groupBy}
            onGroupBy={(by) => useScreenerPrefs.getState().setGroupBy(by)}
            focus={focus}
            onFocus={setFocus}
            onOpen={openInChart}
            onMenu={(symbol, x, y) => openRowMenu(symbol, x, y, t)}
            loading={scan.loading}
            error={scanError}
            onRetry={scan.retry}
            total={data?.total ?? 0}
            liveCount={pageSymbols.length}
          />
        ) : (
          <ResultsTable
            universe={synthetic}
            rows={ordered}
            quotes={quotes}
            missing={missing}
            loadingQuotes={false}
            conflict={null}
            onHold={onHold}
            columns={serverColumns}
            columnDefs={columnDefs}
            server={{
              total: data?.total ?? 0,
              rows: snap,
              sortFieldOf: columnSortField,
              onSort,
              loading: scan.loading,
              error: scanError,
              onRetry: scan.retry,
              pageSizes: SERVER_PAGE_SIZES,
            }}
            sort={{ key: draft.sort.field, dir: draft.sort.dir }}
            pageSize={tableLimit}
            density={density}
            focus={focus}
            onFocus={setFocus}
            onOpen={openInChart}
            onMenu={(symbol, x, y) => openRowMenu(symbol, x, y, t)}
            searchRef={searchRef}
            onClearFilters={clearRules}
            groupBy={groupBy}
            onGroupBy={(by) => useScreenerPrefs.getState().setGroupBy(by)}
          />
        )}
        {detailOpen ? (
          <ScreenerDetail
            symbol={focus}
            universe={synthetic}
            onOpen={openInChart}
            onClose={() => setFocus(null)}
          />
        ) : null}
      </div>
      {fxColumnOpen && fields ? (
        <FormulaColumnDialog
          fields={fields}
          existing={formulaColumns.map(formulaOfColumn)}
          onAdd={(formula, label) => useScreenerPrefs.getState().addFormulaColumn(formula, label)}
          onClose={() => setFxColumnOpen(false)}
        />
      ) : null}
    </div>
  );
}
