/**
 * Startup and lifetime of user-data persistence (docs/persistence.md §6):
 * migration, restore of the last-used layout, drawings, settings, templates
 * and notes from the API, change tracking, and offline fallback with
 * reconnect. localStorage stays the offline cache throughout.
 */
import type { Chart } from '@investopen/engine';
import { errorMessage } from '../api/client';
import * as persistence from '../api/persistence';
import { startAlertNotifications } from '../alerts/notify';
import { startAlertsSync } from '../alerts/sync';
import { useCompareStore } from '../compare/store';
import { useIndicatorStore } from '../indicators/store';
import { useAppStore } from '../store/app';
import { useChartStore } from '../store/chart';
import { useUiStore } from '../store/ui';
import { actionToast, toast } from '../ui/Toast';
import { DrawingSync } from './drawingSync';
import { DrawingTemplatesSync } from './drawingTemplatesSync';
import { captureLayoutState } from './layoutState';
import { LayoutSession, useLayoutStatus, type Notifier } from './layouts';
import {
  LOCAL_BUNDLE_KEY,
  MIGRATED_LAYOUT_ID,
  dismissLocalData,
  importLocalData,
  localDataSummary,
  migrateExclusive,
} from './migration';
import { isObj, isTransient, readJson, safeStorage } from './net';
import { GENERAL_NOTE, NotesSync, useNotesStore } from './notes';
import { SettingsSync } from './settingsSync';
import { WatchlistSync } from './watchlists';

export interface Persistence {
  layouts: LayoutSession;
  drawings: DrawingSync;
  settings: SettingsSync;
  drawingTemplates: DrawingTemplatesSync;
  notes: NotesSync;
  watchlists: WatchlistSync;
  /** Try to reach the API now (no-op while connected). */
  reconnect: () => Promise<void>;
  /** Save everything pending now. */
  flushAll: () => Promise<void>;
  /**
   * Stop all syncing without sending anything more (no autosave, no pagehide
   * flush). Used before an import replaces the server data; reload afterwards.
   */
  halt: () => Promise<void>;
}

let active: Persistence | null = null;

/** The running persistence (null before startup / in tests). */
export const getPersistence = (): Persistence | null => active;

const RECONNECT_MS = 15_000;
/** Layout capture throttle: pans and zooms fire many events. */
const CHANGE_MS = 300;

const LAYOUT_FIELDS = [
  'symbol',
  'interval',
  'chartType',
  'chartStyle',
  'showPrevClose',
  'timezone',
  'prepost',
] as const;

const notifier: Notifier = {
  info: (m) => toast(m),
  error: (m) => toast(m, 'error', 6000),
  conflict: (m, actions) => actionToast(m, actions, 'error'),
};

/** Seed the notes store from the pre-API UI store once (offline first run). */
function seedLegacyNote(): void {
  const legacy = (useUiStore.getState() as { notes?: unknown }).notes;
  const notes = useNotesStore.getState().notes;
  if (typeof legacy === 'string' && legacy && !notes[GENERAL_NOTE])
    useNotesStore.setState({
      notes: { ...notes, [GENERAL_NOTE]: { id: null, text: legacy, revision: null, dirty: false } },
    });
}

/** Start persistence; returns a stop function (flushes pending saves). */
export function startPersistence(): () => void {
  const storage = safeStorage();
  const onError = (m: string) => toast(m, 'error', 6000);
  seedLegacyNote();
  let disposed = false;
  /** Aborted on stop: a migration this instance waits for stops being awaited. */
  const abort = new AbortController();
  let online = false;
  let offlineToast = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const setOnline = (on: boolean) => useLayoutStatus.setState({ online: on });
  const layouts = new LayoutSession({ notify: notifier });
  const drawings = new DrawingSync({
    onError,
    onOnline: setOnline,
    onPending: (p) => {
      if (useLayoutStatus.getState().drawingsPending !== p)
        useLayoutStatus.setState({ drawingsPending: p });
    },
  });
  const settings = new SettingsSync({ onError });
  const drawingTemplates = new DrawingTemplatesSync({ onError });
  const notes = new NotesSync({
    onError,
    onConflict: (_key, restore) =>
      actionToast(
        'A note was changed elsewhere; the saved version is shown.',
        [{ label: 'Keep mine', run: restore }],
        'error',
        10_000,
      ),
  });
  const watchlists = new WatchlistSync({
    onError,
    onConflict: (_id, name, restore) =>
      actionToast(
        `Watchlist “${name}” was changed elsewhere; the saved version is shown.`,
        [{ label: 'Keep mine', run: restore }],
        'error',
        10_000,
      ),
  });
  drawings.start();
  settings.start();
  drawingTemplates.start();
  notes.start();
  watchlists.start();
  const stopAlerts = startAlertsSync();
  const stopAlertNotify = startAlertNotifications();

  // ---------------------------------------------------------------- layout changes
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  const flushChange = () => {
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = null;
    layouts.onChange();
  };
  const changed = () => {
    if (!changeTimer) changeTimer = setTimeout(flushChange, CHANGE_MS);
  };
  let chartOffs: (() => void)[] = [];
  const watchChart = (chart: Chart | null) => {
    chartOffs.forEach((off) => off());
    chartOffs = chart
      ? [chart.on('stateChange', changed), chart.on('visibleRangeChange', changed)]
      : [];
  };
  watchChart(useChartStore.getState().chart);

  const offs = [
    useIndicatorStore.subscribe((s, p) => {
      if (s.instances !== p.instances) changed();
    }),
    useCompareStore.subscribe((s, p) => {
      if (s.items !== p.items || s.scaleRestore !== p.scaleRestore) changed();
    }),
    useAppStore.subscribe((s, p) => {
      if (LAYOUT_FIELDS.some((k) => s[k] !== p[k])) changed();
      if (s.symbol !== p.symbol && online)
        drawings.pull(s.symbol).catch((err) => report(err, 'Drawings could not be loaded'));
    }),
    useChartStore.subscribe((s, p) => {
      if (s.chart !== p.chart) watchChart(s.chart);
    }),
  ];

  const report = (err: unknown, what: string) => {
    if (isTransient(err)) goOffline();
    else onError(`${what}: ${errorMessage(err)}`);
  };

  // ---------------------------------------------------------------- connect
  const goOffline = () => {
    // A stopped instance (e.g. React StrictMode's first mount) stays quiet.
    if (disposed) return;
    online = false;
    setOnline(false);
    if (!offlineToast) {
      offlineToast = true;
      toast(
        'Server unreachable: working from this browser’s copy. Changes are kept and synced when it is back.',
        'error',
        8000,
      );
    }
    if (!reconnectTimer && !disposed)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, RECONNECT_MS);
  };

  let connecting: Promise<void> | null = null;
  const connect = (): Promise<void> => {
    connecting ??= doConnect().finally(() => (connecting = null));
    return connecting;
  };

  const doConnect = async () => {
    if (disposed || online) return;
    let fromLocal: string | undefined;
    let localData = false;
    try {
      const result = await migrateExclusive(persistence, storage, () => captureLayoutState(), {
        signal: abort.signal,
      });
      if (result === 'migrated') fromLocal = MIGRATED_LAYOUT_ID;
      localData = result === 'local-data';
    } catch (err) {
      if (disposed) return;
      if (isTransient(err)) {
        // Still restore the cached layout before going offline.
        await layouts.start();
        goOffline();
        return;
      }
      onError(`Saved data from this browser could not be imported: ${errorMessage(err)}`);
    }
    if (disposed) return;
    if (!(await layouts.start({ fromLocal }))) {
      goOffline();
      return;
    }
    if (disposed) return;
    const results = await Promise.allSettled([
      settings.load(),
      drawings.pull(),
      drawingTemplates.load(),
      notes.load(),
      watchlists.load(),
    ]);
    if (disposed) return;
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) {
      report(failed.reason, 'Saved data could not be loaded');
      if (isTransient(failed.reason)) return;
    }
    online = true;
    setOnline(true);
    if (localData) offerLocalData();
    if (offlineToast) {
      offlineToast = false;
      toast('Server reachable again: changes synced', 'success');
    }
  };

  /**
   * Another browser migrated first; this one has its own pre-API data (backed
   * up as `<key>.premigration`). Offer to import it when it adds something.
   */
  const offerLocalData = () => {
    const summary = localDataSummary(storage);
    if (!summary) return;
    const bundle = readJson<{ drawings?: { data?: unknown }[]; layouts?: { state?: unknown }[] }>(
      storage.get(LOCAL_BUNDLE_KEY),
    );
    const missing = (bundle?.drawings ?? []).filter(
      (d) => isObj(d.data) && !(String(d.data.id) in drawings.meta.revisions),
    ).length;
    const localIndicators = JSON.stringify(
      (isObj(bundle?.layouts?.[0]?.state) && bundle.layouts[0].state.indicators) || [],
    );
    const layoutDiffers =
      summary.layout && localIndicators !== JSON.stringify(captureLayoutState().indicators);
    if (!missing && !layoutDiffers) {
      dismissLocalData(storage); // nothing new; the backups stay
      return;
    }
    const parts = [
      missing ? `${missing} drawing${missing === 1 ? '' : 's'}` : '',
      layoutDiffers ? 'a layout' : '',
    ].filter(Boolean);
    actionToast(
      `This browser has ${parts.join(' and ')} saved before it used the server. Import them?`,
      [
        {
          label: 'Import',
          run: () =>
            void importLocalData(persistence, storage)
              .then(async (name) => {
                await drawings.pull().catch(() => undefined);
                toast(name ? `Imported; see layout "${name}"` : 'Imported', 'success');
              })
              .catch((err) => onError(`Import failed: ${errorMessage(err)}`)),
        },
        { label: 'Dismiss', run: () => dismissLocalData(storage) },
      ],
    );
  };

  // ---------------------------------------------------------------- page lifecycle
  const onPageHide = () => flushChange();
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    flushChange();
    // Unsynced work is kept in this browser and pushed on the next start;
    // still warn, since another device would not see it until then.
    if (!online && (layouts.hasUnsyncedChanges() || drawings.hasPending)) e.preventDefault();
  };
  const onVisible = () => {
    if (document.visibilityState === 'hidden') {
      flushChange();
      return;
    }
    if (!online) void connect();
    else {
      drawings
        .pull(useAppStore.getState().symbol)
        .catch((err) => report(err, 'Drawings could not be loaded'));
      // Cheap; picks up changes made on other devices.
      watchlists.load().catch((err) => report(err, 'Watchlists could not be loaded'));
    }
  };
  const onNetworkOnline = () => void connect();
  // Registered before the autosavers' own handlers run (they flush the cache we write here).
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onNetworkOnline);

  const flushAll = async () => {
    flushChange();
    await Promise.all([
      layouts.connected ? layouts.save().then(() => undefined) : Promise.resolve(),
      drawings.flush(),
      settings.flush(),
      drawingTemplates.flush(),
      notes.flush(),
      watchlists.flush(),
    ]);
  };

  const stop = (send: boolean): Promise<unknown> => {
    disposed = true;
    abort.abort();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (send) flushChange();
    else if (changeTimer) clearTimeout(changeTimer);
    offs.forEach((off) => off());
    watchChart(null);
    stopAlerts();
    stopAlertNotify();
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onNetworkOnline);
    if (active?.layouts === layouts) active = null;
    const parts = [layouts, drawings, settings, drawingTemplates, notes, watchlists];
    return Promise.all(parts.map((p) => (send ? p.dispose() : p.halt())));
  };

  active = {
    layouts,
    drawings,
    settings,
    drawingTemplates,
    notes,
    watchlists,
    reconnect: connect,
    flushAll,
    halt: () => stop(false).then(() => undefined),
  };
  void connect();

  return () => void stop(true);
}
