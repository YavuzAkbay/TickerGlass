import type { Chart, Drawing } from '@investopen/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Layout, LayoutSummary, StoredDrawing } from '../api/types';
import { useHistory } from '../commands/history';
import type { CompareState } from '../compare/model';
import { useCompareStore } from '../compare/store';
import { useDrawingStore, useDrawingTemplates, withRemoteApply } from '../drawings/store';
import {
  DEFAULT_VOLUME_ID,
  defaultVolumeInstance,
  withLegacyVolume,
  type IndicatorState,
} from '../indicators/model';
import {
  legacyAppVolume,
  migrateIndicatorPrefs,
  migrateIndicatorStore,
  useIndicatorPrefs,
  useIndicatorStore,
} from '../indicators/store';
import { useChartView } from '../store/chartView';
import { readChartTemplate } from './chartTemplates';
import { DrawingSync, DRAWING_SYNC_KEY, type DrawingApi } from './drawingSync';
import { capToasts } from '../ui/Toast';
import { retryableLazy } from '../ui/lazyRetry';
import { CACHE_KEYS, importBundle, isFullBundle, latestOnly, type TransferApi } from './transfer';
import {
  DEFAULT_TEMPLATE_NAME,
  DrawingTemplatesSync,
  type DrawingTemplateApi,
} from './drawingTemplatesSync';
import { applyIndicatorTemplate, instantiateTemplate } from './indicatorTemplates';
import {
  applyLayoutState,
  captureLayoutState,
  LAYOUT_SCHEMA_VERSION,
  parseLayoutState,
  type LayoutState,
} from './layoutState';
import {
  LAYOUT_CACHE_KEY,
  LAYOUT_ORPHAN_KEY,
  LayoutSession,
  useLayoutStatus,
  type LayoutApi,
  type LayoutCache,
  type Notifier,
} from './layouts';
import {
  LEGACY_KEYS,
  MIGRATED_LAYOUT_ID,
  MIGRATION_SETTING,
  LEASE_KEY,
  LOCAL_BUNDLE_KEY,
  backupKeyOf,
  buildMigrationBundle,
  dismissLocalData,
  importLocalData,
  migrateExclusive,
  runMigration,
  withMigrationLock,
  type LockManagerLike,
  type MigrationApi,
} from './migration';
import type { SafeStorage } from './net';
import { GENERAL_NOTE, NotesSync, useNotesStore, type NotesApi } from './notes';
import { SETTING_DEFS, SettingsSync, type SettingDef, type SettingsApi } from './settingsSync';

// ------------------------------------------------------------ helpers

function memStorage(
  init: Record<string, string> = {},
): SafeStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => {
      data.set(k, v);
      return true;
    },
    remove: (k) => void data.delete(k),
  };
}

const offline = () => new ApiError('Network error: API unreachable', 0);
const conflict = (detail: unknown) => new ApiError('conflict', 409, { detail });
const notFound = () => new ApiError('not found', 404, { detail: 'not found' });

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const state = (symbol: string, extra: Partial<LayoutState> = {}): LayoutState => ({
  chart: null,
  indicators: [],
  compares: { items: [], scaleRestore: null },
  chartSettings: {
    chartType: 'candles',
    chartStyle: {},
    showPrevClose: false,
    timezone: 'exchange',
    prepost: false,
  },
  ...extra,
  // Symbol travels in the chart state; tests use a marker indicator list instead.
  ...(symbol ? { indicators: [indicator(symbol)] } : {}),
});

function indicator(id: string, inputs: Record<string, unknown> = {}): IndicatorState {
  return {
    id,
    type: 'sma',
    inputs: inputs as IndicatorState['inputs'],
    styles: {},
    visible: true,
    visibility: null,
    placement: 'auto',
  };
}

/** In-memory layouts server. */
function fakeLayoutServer() {
  const layouts = new Map<string, Layout<LayoutState>>();
  let lastUsed: string | null = null;
  let seq = 0;
  let down = false;
  const t = () => new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)).toISOString();
  const summary = (l: Layout<LayoutState>): LayoutSummary => {
    const { state: _s, ...rest } = l;
    return { ...rest, isLastUsed: l.id === lastUsed };
  };
  const guard = () => {
    if (down) throw offline();
  };
  const api = {
    getLastUsedLayout: vi.fn(async () => {
      guard();
      return lastUsed ? structuredClone(layouts.get(lastUsed)!) : null;
    }),
    setLastUsedLayout: vi.fn(async (id: string) => {
      guard();
      lastUsed = id;
    }),
    createLayout: vi.fn(async (b: { name: string; state: LayoutState }) => {
      guard();
      const now = t();
      const l: Layout<LayoutState> = {
        id: `L${++seq}`,
        name: b.name,
        state: structuredClone(b.state),
        schemaVersion: 1,
        revision: 1,
        isLastUsed: false,
        createdAt: now,
        updatedAt: now,
      };
      layouts.set(l.id, l);
      return structuredClone(l);
    }),
    getLayout: vi.fn(async (id: string) => {
      guard();
      const l = layouts.get(id);
      if (!l) throw notFound();
      return structuredClone(l);
    }),
    saveLayout: vi.fn(async (id: string, b: { state: LayoutState; revision: number }) => {
      guard();
      const l = layouts.get(id);
      if (!l) throw notFound();
      if (l.revision !== b.revision)
        throw conflict({ message: 'stale', current: structuredClone(l) });
      l.state = structuredClone(b.state);
      l.revision++;
      l.updatedAt = t();
      return structuredClone(l);
    }),
    listLayouts: vi.fn(async () => {
      guard();
      return [...layouts.values()].reverse().map(summary);
    }),
    renameLayout: vi.fn(async (id: string, name: string) => {
      guard();
      layouts.get(id)!.name = name;
      return summary(layouts.get(id)!);
    }),
    duplicateLayout: vi.fn(async (id: string, name: string) => {
      guard();
      return api.createLayout({ name, state: layouts.get(id)!.state });
    }),
    deleteLayout: vi.fn(async (id: string) => {
      guard();
      layouts.delete(id);
      if (lastUsed === id) lastUsed = null;
    }),
    exportLayout: vi.fn(),
    importLayout: vi.fn(),
  };
  return {
    api: api as unknown as LayoutApi,
    fns: api,
    layouts,
    setDown: (d: boolean) => (down = d),
    seed: (name: string, s: LayoutState, revision = 1) => {
      const id = `L${++seq}`;
      layouts.set(id, {
        id,
        name,
        state: structuredClone(s),
        schemaVersion: 1,
        revision,
        isLastUsed: true,
        createdAt: t(),
        updatedAt: t(),
      });
      lastUsed = id;
      return id;
    },
  };
}

function notifier() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    conflict: vi.fn(),
  } satisfies Notifier;
}

/** A session over fake app state (`current`) instead of the real stores. */
function session(
  server: ReturnType<typeof fakeLayoutServer>,
  storage = memStorage(),
  now?: () => number,
) {
  let current = state('');
  const applied: LayoutState[] = [];
  const notify = notifier();
  const s = new LayoutSession({
    api: server.api,
    storage,
    notify,
    delay: 0,
    retryDelay: 0,
    ...(now ? { now } : {}),
    capture: () => structuredClone(current),
    apply: async (st) => {
      applied.push(structuredClone(st));
      current = structuredClone(st);
    },
  });
  return {
    s,
    notify,
    applied,
    storage,
    edit: (st: LayoutState) => {
      current = st;
      s.onChange();
    },
    current: () => current,
  };
}

const cacheOf = (storage: SafeStorage) =>
  JSON.parse(storage.get(LAYOUT_CACHE_KEY) ?? 'null') as LayoutCache | null;

beforeEach(() => {
  useLayoutStatus.setState({
    current: null,
    online: true,
    dirty: false,
    saving: false,
    ready: false,
    drawingsPending: false,
  });
  useDrawingStore.setState({ bySymbol: {}, synced: [] });
  useIndicatorStore.setState({ instances: [] });
  useHistory.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------------ layouts

describe('layout startup and restore', () => {
  it('creates "Untitled" from the current state when there is no layout', async () => {
    const server = fakeLayoutServer();
    const t = session(server);
    expect(await t.s.start()).toBe(true);
    expect(server.fns.createLayout).toHaveBeenCalledOnce();
    expect(server.fns.createLayout.mock.calls[0]![0].name).toBe('Untitled');
    const id = (await server.fns.createLayout.mock.results[0]!.value).id;
    expect(server.fns.setLastUsedLayout).toHaveBeenCalledWith(id);
    expect(useLayoutStatus.getState()).toMatchObject({
      current: { id, name: 'Untitled' },
      online: true,
      ready: true,
      dirty: false,
    });
    expect(cacheOf(t.storage)).toMatchObject({ id, revision: 1, dirty: false });
    // Made from what is shown: not re-applied over the user's view.
    expect(t.applied).toEqual([]);
  });

  it('a layout just migrated from this browser is not re-applied; later changes are saved', async () => {
    const server = fakeLayoutServer();
    const id = server.seed('Default', state('at-migration'));
    const t = session(server);
    // The user changed something between the migration snapshot and the restore.
    t.edit(state('now'));
    await t.s.start({ fromLocal: id });
    expect(t.applied).toEqual([]);
    await t.s.save();
    expect(server.layouts.get(id)!.state.indicators[0]!.id).toBe('now');
  });

  it('restores the last-used layout', async () => {
    const server = fakeLayoutServer();
    server.seed('Swing', state('rsi_1'), 3);
    const t = session(server);
    await t.s.start();
    expect(t.applied).toHaveLength(1);
    expect(t.applied[0]!.indicators.map((i) => i.id)).toEqual(['rsi_1']);
    expect(t.s.revision).toBe(3);
    expect(useLayoutStatus.getState().current?.name).toBe('Swing');
  });

  it('falls back to the cached layout when the API is down, then pushes offline edits', async () => {
    const server = fakeLayoutServer();
    const id = server.seed('Swing', state('server'), 2);
    const storage = memStorage({
      [LAYOUT_CACHE_KEY]: JSON.stringify({
        id,
        name: 'Swing',
        revision: 2,
        dirty: false,
        state: state('cached'),
      }),
    });
    server.setDown(true);
    const t = session(server, storage);
    expect(await t.s.start()).toBe(false);
    expect(t.applied.map((a) => a.indicators[0]!.id)).toEqual(['cached']);
    expect(useLayoutStatus.getState()).toMatchObject({ online: false, ready: true });
    expect(t.s.connected).toBe(false);

    // Edit while offline: cached as dirty (queued for the server).
    t.edit(state('offline-edit'));
    expect(cacheOf(storage)).toMatchObject({ dirty: true, revision: 2 });
    expect(useLayoutStatus.getState().dirty).toBe(true);

    // Reconnect: the offline edit is pushed on top of revision 2, not overwritten.
    server.setDown(false);
    expect(await t.s.start()).toBe(true);
    await t.s.save();
    expect(server.layouts.get(id)!.state.indicators[0]!.id).toBe('offline-edit');
    expect(server.layouts.get(id)!.revision).toBe(3);
    expect(cacheOf(storage)).toMatchObject({ dirty: false, revision: 3 });
  });

  it('a recovery copy that already landed (keepalive save) is not re-sent as a conflict', async () => {
    const server = fakeLayoutServer();
    const id = server.seed('A', state('same'), 5);
    const storage = memStorage({
      [LAYOUT_CACHE_KEY]: JSON.stringify({
        id,
        name: 'A',
        revision: 4,
        dirty: true,
        state: state('same'),
      }),
    });
    const t = session(server, storage);
    await t.s.start();
    await settle();
    expect(server.fns.saveLayout).not.toHaveBeenCalled();
    expect(t.notify.conflict).not.toHaveBeenCalled();
    expect(t.s.revision).toBe(5);
  });
});

describe('layout autosave and conflicts', () => {
  it('saves changes with the current revision and only when the state changed', async () => {
    const server = fakeLayoutServer();
    const id = server.seed('A', state('a'));
    const t = session(server);
    await t.s.start();
    t.s.onChange(); // nothing changed
    await t.s.save();
    expect(server.fns.saveLayout).not.toHaveBeenCalled();
    t.edit(state('b'));
    await t.s.save();
    expect(server.fns.saveLayout).toHaveBeenCalledOnce();
    expect(server.fns.saveLayout.mock.calls[0]![1].revision).toBe(1);
    expect(server.layouts.get(id)!.revision).toBe(2);
    expect(useLayoutStatus.getState().dirty).toBe(false);
  });

  it('409 offers Reload (take theirs) and Overwrite (keep mine)', async () => {
    const server = fakeLayoutServer();
    const id = server.seed('A', state('a'));
    const t = session(server);
    await t.s.start();
    // Another device saves.
    server.layouts.get(id)!.state = state('theirs');
    server.layouts.get(id)!.revision = 7;

    t.edit(state('mine'));
    await t.s.save();
    expect(t.notify.conflict).toHaveBeenCalledOnce();
    const actions = t.notify.conflict.mock.calls[0]![1] as { label: string; run: () => void }[];
    expect(actions.map((a) => a.label)).toEqual(['Reload', 'Overwrite']);

    actions[1]!.run(); // Overwrite
    await settle();
    expect(server.layouts.get(id)!.state.indicators[0]!.id).toBe('mine');
    expect(server.layouts.get(id)!.revision).toBe(8);

    // Conflict again; this time reload theirs.
    server.layouts.get(id)!.state = state('theirs2');
    server.layouts.get(id)!.revision = 20;
    t.edit(state('mine2'));
    await t.s.save();
    const again = t.notify.conflict.mock.calls[1]![1] as { label: string; run: () => void }[];
    again[0]!.run(); // Reload
    await settle();
    expect(t.current().indicators[0]!.id).toBe('theirs2');
    expect(t.s.revision).toBe(20);
    expect(useLayoutStatus.getState().dirty).toBe(false);
  });

  it('a rejected save (4xx) is reported and not retried', async () => {
    const server = fakeLayoutServer();
    server.seed('A', state('a'));
    const t = session(server);
    await t.s.start();
    server.fns.saveLayout.mockRejectedValueOnce(new ApiError('state too large', 422));
    t.edit(state('huge'));
    await t.s.save();
    expect(t.notify.error).toHaveBeenCalledWith(expect.stringContaining('too large'));
    expect(server.fns.saveLayout).toHaveBeenCalledOnce();
  });
});

describe('named layouts', () => {
  it('save as, rename, copy, load and delete', async () => {
    const server = fakeLayoutServer();
    const a = server.seed('A', state('a'));
    const t = session(server);
    await t.s.start();

    await t.s.saveAs('B');
    const b = useLayoutStatus.getState().current!.id!;
    expect(b).not.toBe(a);
    expect(server.layouts.get(b)!.name).toBe('B');

    await t.s.rename('B2');
    expect(useLayoutStatus.getState().current?.name).toBe('B2');
    expect(server.layouts.get(b)!.revision).toBe(1); // rename keeps the revision

    t.edit(state('b-edit'));
    await t.s.copy('C');
    const c = useLayoutStatus.getState().current!.id!;
    // The copy has the saved state of B.
    expect(server.layouts.get(b)!.state.indicators[0]!.id).toBe('b-edit');
    expect(server.layouts.get(c)!.state.indicators[0]!.id).toBe('b-edit');

    expect(await t.s.load(a)).toBe(true);
    expect(t.current().indicators[0]!.id).toBe('a');
    expect(useLayoutStatus.getState().current?.id).toBe(a);

    // Deleting another layout keeps the current one.
    await t.s.remove(c);
    expect(server.layouts.has(c)).toBe(false);
    expect(useLayoutStatus.getState().current?.id).toBe(a);
    // Deleting the current one switches to the newest remaining.
    await t.s.remove(a);
    expect(useLayoutStatus.getState().current?.id).toBe(b);
    // Deleting the last one creates "Untitled".
    await t.s.remove(b);
    expect(useLayoutStatus.getState().current?.name).toBe('Untitled');
    expect(server.layouts.size).toBe(1);
  });

  it('switching with changes that cannot be saved asks first', async () => {
    const server = fakeLayoutServer();
    const a = server.seed('A', state('a'));
    const b = server.seed('B', state('b'));
    const t = session(server);
    await t.s.start(); // B is last used
    server.fns.saveLayout.mockRejectedValue(offline());
    t.edit(state('unsaved'));
    const confirm = vi.fn(async () => false);
    expect(await t.s.load(a, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(useLayoutStatus.getState().current?.id).toBe(b);
    await t.s.dispose();
  });
});

describe('layout state parsing', () => {
  it('fills missing parts and rejects newer schema versions', () => {
    const s = parseLayoutState({
      indicators: [{ id: 'x', type: 'sma', inputs: {}, styles: {} }, 5],
    });
    expect(s!.indicators).toEqual([indicator('x')]);
    expect(s!.chart).toBeNull();
    expect(s!.chartSettings.chartType).toBe(useChartView.getState().chartType);
    expect(parseLayoutState({}, 99)).toBeNull();
  });

  const legacyChart = (volume: string, panes: { id: string; ratio: number }[] = []) => ({
    version: 1,
    symbol: 'AAPL',
    interval: '1D',
    volume,
    timeScale: { barSpacing: 6, rightOffset: 5 },
    crosshair: { mode: 'cross', magnet: 'off' },
    timezone: 'exchange',
    panes: [{ id: 'main', ratio: 3 }, ...panes].map((p) => ({
      ...p,
      collapsed: false,
      priceScale: { mode: 'linear', autoScale: true, invert: false },
    })),
    maximizedPane: null,
  });
  const legacy = (
    volume: string,
    indicators: unknown[] = [],
    panes: { id: string; ratio: number }[] = [],
  ) => ({
    chart: legacyChart(volume, panes),
    indicators,
    chartSettings: { chartType: 'candles', chartStyle: {}, volume, showPrevClose: false },
  });

  it('turns the built-in overlay volume of v1 layouts into a Volume indicator, once', () => {
    const s = parseLayoutState(legacy('overlay', [indicator('a')]), 1)!;
    expect(s.indicators.map((i) => [i.id, i.type, i.placement])).toEqual([
      [DEFAULT_VOLUME_ID, 'volume', 'main'],
      ['a', 'sma', 'auto'],
    ]);
    expect(s.chartSettings).not.toHaveProperty('volume');
    expect(s.chart!.volume).toBe('hidden');
    // Idempotent: the migrated state (saved as v2, or cached without a version) is unchanged.
    expect(parseLayoutState(s, 2)).toEqual(s);
    expect(parseLayoutState(s)).toEqual(s);
    expect(parseLayoutState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('moves a built-in volume pane to the Volume indicator, keeping its size', () => {
    const s = parseLayoutState(legacy('pane', [], [{ id: 'volume', ratio: 1.5 }]), 1)!;
    expect(s.indicators.map((i) => [i.id, i.placement])).toEqual([[DEFAULT_VOLUME_ID, 'own']]);
    expect(s.chart!.panes.map((p) => [p.id, p.ratio])).toEqual([
      ['main', 3],
      [`pane-${DEFAULT_VOLUME_ID}`, 1.5],
    ]);
    expect(parseLayoutState(s)).toEqual(s);
  });

  it('adds no Volume indicator for hidden volume or when one exists', () => {
    const hidden = parseLayoutState(legacy('hidden', [], [{ id: 'volume', ratio: 1 }]), 1)!;
    expect(hidden.indicators).toEqual([]);
    expect(hidden.chart!.panes.map((p) => p.id)).toEqual(['main']);
    const own = { ...indicator('v1'), type: 'volume', placement: 'own' as const };
    const both = parseLayoutState(legacy('overlay', [own]), 1)!;
    expect(both.indicators).toEqual([own]);
    expect(both.chart!.volume).toBe('hidden');
    // Indicator templates (no chart settings) are left alone.
    expect(parseLayoutState({ indicators: [indicator('x')] })!.indicators).toEqual([
      indicator('x'),
    ]);
  });
});

describe('layout state: compare overlays (v3)', () => {
  const cmp = (id: string, patch: Partial<CompareState> = {}): CompareState => ({
    id,
    symbol: 'MSFT',
    placement: 'same',
    visible: true,
    color: '#f2a93b',
    lineWidth: 2,
    ...patch,
  });

  beforeEach(() => useCompareStore.setState({ items: [], scaleRestore: null }));

  it('v2 layouts upgrade to no compares; newer versions are rejected', () => {
    expect(LAYOUT_SCHEMA_VERSION).toBe(4);
    const s = parseLayoutState({ indicators: [indicator('a')] }, 2)!;
    expect(s.compares).toEqual({ items: [], scaleRestore: null });
    expect(s.indicators).toEqual([indicator('a')]);
    // Unversioned (cached) states read as v1 keep their compares.
    const cached = parseLayoutState({ compares: { items: [cmp('cmp-a')], scaleRestore: 'log' } })!;
    expect(cached.compares).toEqual({ items: [cmp('cmp-a')], scaleRestore: 'log' });
    expect(parseLayoutState({}, 5)).toBeNull();
  });

  it('drops invalid compare items and re-canonicalizes symbols', () => {
    const s = parseLayoutState(
      {
        compares: {
          items: [
            cmp('cmp-ok', { symbol: ' (aapl+msft)/2 ' }),
            cmp('bad-id'),
            cmp('cmp-sym', { symbol: 'AAPL/' }),
            cmp('cmp-long', { symbol: `A${'+B'.repeat(70)}` }),
            cmp('cmp-place', { placement: 'left' as CompareState['placement'] }),
            cmp('cmp-color', { color: 'red' }),
            cmp('cmp-width', { lineWidth: 5 }),
            cmp('cmp-width2', { lineWidth: 1.5 }),
            cmp('cmp-ok'),
            { ...cmp('cmp-vis'), visible: undefined },
            'nope',
          ],
          scaleRestore: 'sideways',
        },
      },
      3,
    )!;
    expect(s.compares).toEqual({
      items: [cmp('cmp-ok', { symbol: '(AAPL+MSFT)/2' }), cmp('cmp-vis')],
      scaleRestore: null,
    });
    expect(parseLayoutState({ compares: 'x' }, 3)!.compares).toEqual({
      items: [],
      scaleRestore: null,
    });
  });

  it('capture and apply round-trip the compare store', async () => {
    const compares = {
      items: [cmp('cmp-a'), cmp('cmp-b', { symbol: 'AAPL/MSFT', placement: 'pane' })],
      scaleRestore: 'linear' as const,
    };
    useCompareStore.getState().replaceAll(compares);
    const captured = captureLayoutState(null);
    expect(captured.compares).toEqual(compares);
    expect(parseLayoutState(JSON.parse(JSON.stringify(captured)), 3)).toEqual(captured);
    useCompareStore.getState().replaceAll({ items: [], scaleRestore: null });
    await applyLayoutState(captured, null);
    expect(useCompareStore.getState()).toMatchObject(compares);
  });

  it('applyLayoutState removes pane-cmp-* panes without a compare item', async () => {
    const removed: string[] = [];
    const panes = ['main', 'pane-cmp-a', 'pane-cmp-gone', 'pane-rsi'];
    const chart = {
      setState: async () => {},
      getState: () => ({ panes: panes.map((id) => ({ id })) }),
      removePane: (id: string) => removed.push(id),
    } as unknown as Chart;
    const state = {
      ...captureLayoutState(null),
      chart: { version: 1, symbol: 'AAPL', interval: '1D', timeScale: {}, panes: [] } as never,
      compares: { items: [cmp('cmp-a', { placement: 'pane' })], scaleRestore: null },
    };
    await applyLayoutState(state, chart);
    expect(removed).toEqual(['pane-cmp-gone']);
  });
});

describe('default chart and local store migration', () => {
  it('starts new charts with Volume at the bottom of the price pane', () => {
    expect(defaultVolumeInstance()).toMatchObject({
      id: DEFAULT_VOLUME_ID,
      type: 'volume',
      placement: 'main',
      visible: true,
    });
    expect(withLegacyVolume([], legacyAppVolume(null)).map((i) => i.placement)).toEqual(['main']);
  });

  it('migrates the pre-indicator app volume setting of localStorage', () => {
    const app = (volume?: string) =>
      JSON.stringify({ state: volume ? { theme: 'dark', volume } : { theme: 'dark' }, version: 3 });
    expect(legacyAppVolume(app('pane'))).toBe('pane');
    expect(legacyAppVolume(app())).toBe('overlay');
    expect(
      withLegacyVolume([indicator('a')], legacyAppVolume(app('pane'))).map((i) => i.placement),
    ).toEqual(['own', 'auto']);
    expect(withLegacyVolume([indicator('a')], legacyAppVolume(app('hidden')))).toEqual([
      indicator('a'),
    ]);
    // Idempotent: a Volume indicator already there is kept as the only one.
    const once = withLegacyVolume([], 'overlay');
    expect(withLegacyVolume(once, 'overlay')).toEqual(once);
  });
});

// ------------------------------------------------------------ drawings

function drw(id: string, over: Partial<Drawing> = {}): Drawing {
  return {
    id,
    type: 'trend-line',
    points: [
      { time: 1, price: 1 },
      { time: 2, price: 2 },
    ],
    style: { lineColor: '#fff' },
    text: '',
    locked: false,
    hidden: false,
    zIndex: 0,
    visibility: null,
    scope: 'symbol',
    symbol: 'AAPL',
    paneId: 'main',
    ...over,
  } as Drawing;
}

/** In-memory drawings server with the batch semantics of docs/persistence.md §3. */
function fakeDrawingServer() {
  const rows = new Map<string, StoredDrawing<Drawing>>();
  const row = (d: Drawing, revision: number): StoredDrawing<Drawing> => ({
    id: d.id,
    symbol: d.scope === 'all' ? null : d.symbol,
    paneId: d.paneId,
    z: d.zIndex,
    data: structuredClone(d),
    schemaVersion: 1,
    revision,
    updatedAt: '',
  });
  const api = {
    getDrawings: vi.fn(async (q: { symbol?: string } = {}) =>
      [...rows.values()]
        .filter((r) => !q.symbol || r.symbol === q.symbol || r.symbol === null)
        .map((r) => structuredClone(r)),
    ),
    batchDrawings: vi.fn(
      async (b: {
        upserts?: { drawing: Drawing; baseRevision?: number | null }[];
        deletes?: { id: string; baseRevision?: number | null }[];
      }) => {
        const conflicts: unknown[] = [];
        for (const u of b.upserts ?? []) {
          const cur = rows.get(u.drawing.id);
          if ((u.baseRevision ?? null) !== (cur?.revision ?? null))
            conflicts.push({
              id: u.drawing.id,
              revision: cur?.revision ?? null,
              drawing: cur ?? null,
            });
        }
        for (const d of b.deletes ?? []) {
          const cur = rows.get(d.id);
          if (d.baseRevision != null && cur && cur.revision !== d.baseRevision)
            conflicts.push({ id: d.id, revision: cur.revision, drawing: cur });
        }
        if (conflicts.length) throw conflict({ message: 'conflict', conflicts });
        const out: StoredDrawing<Drawing>[] = [];
        for (const u of b.upserts ?? []) {
          const r = row(u.drawing, (rows.get(u.drawing.id)?.revision ?? 0) + 1);
          rows.set(r.id, r);
          out.push(structuredClone(r));
        }
        const deleted: string[] = [];
        for (const d of b.deletes ?? []) if (rows.delete(d.id)) deleted.push(d.id);
        return { drawings: out, deleted };
      },
    ),
  };
  return {
    api: api as unknown as DrawingApi,
    fns: api,
    rows,
    put: (d: Drawing, rev = 1) => rows.set(d.id, row(d, rev)),
  };
}

const store = () => useDrawingStore.getState();
const stored = (id: string) =>
  [...store().synced, ...Object.values(store().bySymbol).flat()].find((d) => d.id === id);

describe('drawing batch sync', () => {
  it('sends creates, edits and deletes with their base revisions', async () => {
    const server = fakeDrawingServer();
    const storage = memStorage();
    const sync = new DrawingSync({
      api: server.api,
      storage,
      delay: 0,
      retryDelay: 0,
      onError: vi.fn(),
    });
    sync.start();
    await sync.pull();

    store().apply([drw('a'), drw('b', { scope: 'all', symbol: '' })]);
    await sync.flush();
    let call = server.fns.batchDrawings.mock.calls.at(-1)![0];
    expect(call.upserts!.map((u) => [u.drawing.id, u.baseRevision]).sort()).toEqual([
      ['a', null],
      ['b', null],
    ]);
    expect(sync.meta.revisions).toEqual({ a: 1, b: 1 });
    expect(sync.hasPending).toBe(false);

    // Several edits coalesce into one batch.
    store().apply([drw('a', { text: 'x' })]);
    store().apply([drw('a', { text: 'y' })], ['b']);
    await sync.flush();
    expect(server.fns.batchDrawings).toHaveBeenCalledTimes(2);
    call = server.fns.batchDrawings.mock.calls.at(-1)![0];
    expect(call.upserts).toEqual([
      { drawing: expect.objectContaining({ id: 'a', text: 'y' }), baseRevision: 1 },
    ]);
    expect(call.deletes).toEqual([{ id: 'b', baseRevision: 1 }]);
    expect(server.rows.get('a')!.revision).toBe(2);
    expect(server.rows.has('b')).toBe(false);
    // Pending ids and revisions survive a reload.
    expect(JSON.parse(storage.get(DRAWING_SYNC_KEY)!)).toEqual({
      revisions: { a: 2 },
      pending: {},
      owners: {},
    });
    await sync.dispose();
  });

  it('a pull waits for the batch in flight: new drawings stay, edits are not reverted', async () => {
    const server = fakeDrawingServer();
    const sync = new DrawingSync({
      api: server.api,
      storage: memStorage(),
      delay: 60_000,
      onError: vi.fn(),
    });
    server.put(drw('a'));
    sync.start();
    await sync.pull();
    // Hold the batch until the pull has been requested.
    const realBatch = server.fns.batchDrawings.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.fns.batchDrawings.mockImplementationOnce(async (b) => {
      await gate;
      return realBatch(b);
    });
    store().apply([drw('n'), drw('a', { text: 'edited' })]);
    const flushing = sync.flush();
    await settle();
    expect(server.fns.batchDrawings).toHaveBeenCalledOnce(); // in flight
    const pulling = sync.pull('AAPL'); // e.g. tab became visible / symbol switch
    await settle();
    expect(server.fns.getDrawings).toHaveBeenCalledTimes(1); // not yet: serialized
    release();
    await Promise.all([flushing, pulling]);
    expect(server.fns.getDrawings).toHaveBeenCalledTimes(2);
    expect(stored('n')).toBeTruthy();
    expect(stored('a')!.text).toBe('edited');
    expect(sync.meta.revisions).toEqual({ a: 2, n: 1 });
    await sync.dispose();
  });

  it('ignores server rows older than a known revision', async () => {
    const server = fakeDrawingServer();
    const sync = new DrawingSync({
      api: server.api,
      storage: memStorage(),
      delay: 0,
      onError: vi.fn(),
    });
    server.put(drw('a'));
    sync.start();
    await sync.pull();
    store().apply([drw('a', { text: 'v2' })]);
    await sync.flush();
    expect(sync.meta.revisions.a).toBe(2);
    // A read that started before the batch landed (stale replica, other tab, ...).
    server.fns.getDrawings.mockResolvedValueOnce([
      {
        id: 'a',
        symbol: 'AAPL',
        paneId: 'main',
        z: 0,
        data: drw('a'),
        schemaVersion: 1,
        revision: 1,
        updatedAt: '',
      },
    ]);
    await sync.pull();
    expect(stored('a')!.text).toBe('v2');
    expect(sync.meta.revisions.a).toBe(2);
    await sync.dispose();
  });

  it('does not send until the first pull: early edits are based on the server revision', async () => {
    const server = fakeDrawingServer();
    server.put(drw('a'), 3);
    // Cached from a previous session, but no sync metadata (e.g. it was cleared).
    store().apply([drw('a')]);
    const onError = vi.fn();
    const sync = new DrawingSync({ api: server.api, storage: memStorage(), delay: 0, onError });
    sync.start();
    store().apply([drw('a', { text: 'early' })]);
    await sync.flush();
    expect(server.fns.getDrawings).toHaveBeenCalledOnce();
    expect(server.fns.batchDrawings.mock.calls[0]![0].upserts![0]!.baseRevision).toBe(3);
    expect(server.rows.get('a')!.data.text).toBe('early');
    expect(onError).not.toHaveBeenCalled();
    await sync.dispose();
  });

  it('multi-tab: edits and deletes of drawings that came from another tab are based on the server', async () => {
    const server = fakeDrawingServer();
    const onError = vi.fn();
    const sync = new DrawingSync({ api: server.api, storage: memStorage(), delay: 0, onError });
    sync.start();
    await sync.pull();
    // Tab B created x and y and saved them; this tab got them via the storage merge.
    server.put(drw('x'));
    server.put(drw('y'));
    withRemoteApply(() => store().apply([drw('x'), drw('y')]));
    store().apply([drw('x', { text: 'mine' })], ['y']);
    expect(sync.meta.pending).toEqual({ x: 'unknown', y: 'unknown' });
    await sync.flush();
    const call = server.fns.batchDrawings.mock.calls[0]![0];
    expect(call.upserts).toEqual([
      { drawing: expect.objectContaining({ id: 'x' }), baseRevision: 1 },
    ]);
    expect(call.deletes).toEqual([{ id: 'y', baseRevision: 1 }]);
    expect(server.rows.get('x')!.data.text).toBe('mine');
    expect(server.rows.has('y')).toBe(false); // no resurrection
    expect(onError).not.toHaveBeenCalled();
    await sync.dispose();
  });

  it("multi-tab: learns revisions from storage events and keeps other tabs' pending ids", async () => {
    const server = fakeDrawingServer();
    const storage = memStorage();
    const events = new EventTarget() as unknown as Window;
    const sync = new DrawingSync({
      api: server.api,
      storage,
      events,
      delay: 60_000,
      onError: vi.fn(),
    });
    sync.start();
    await sync.pull();
    withRemoteApply(() => store().apply([drw('x')]));
    store().apply([drw('x', { text: 'mine' })]);
    expect(sync.meta.pending.x).toBe('unknown');
    // Tab B saved x (revision 4) and has its own pending "z".
    const other = JSON.stringify({
      revisions: { x: 4 },
      pending: { z: null },
      owners: { z: 'tabB' },
    });
    storage.set(DRAWING_SYNC_KEY, other);
    events.dispatchEvent(
      Object.assign(new Event('storage'), { key: DRAWING_SYNC_KEY, newValue: other }),
    );
    expect(sync.meta.revisions.x).toBe(4);
    expect(sync.meta.pending.x).toBe(4);
    // Saving my metadata keeps B's pending id (B may close before sending it).
    store().apply([drw('x', { text: 'mine2' })]);
    const file = JSON.parse(storage.get(DRAWING_SYNC_KEY)!);
    expect(file.pending).toEqual({ z: null, x: 4 });
    expect(file.owners).toEqual({ z: 'tabB', x: sync.tab });
    await sync.dispose();
  });

  it('symbol drawings without a symbol stay local (the server would reject the batch)', async () => {
    const server = fakeDrawingServer();
    const onError = vi.fn();
    const sync = new DrawingSync({ api: server.api, storage: memStorage(), delay: 0, onError });
    sync.start();
    store().apply([drw('ok'), drw('blank', { symbol: '' })]);
    await sync.flush();
    expect([...server.rows.keys()]).toEqual(['ok']);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('no symbol'));
    expect(stored('blank')).toBeTruthy();
    expect(sync.hasPending).toBe(false);
    await sync.dispose();
  });

  it('a created-then-removed drawing is never sent', async () => {
    const server = fakeDrawingServer();
    const sync = new DrawingSync({
      api: server.api,
      storage: memStorage(),
      delay: 0,
      onError: vi.fn(),
    });
    sync.start();
    store().apply([drw('t')]);
    store().apply([], ['t']);
    await sync.flush();
    expect(server.fns.batchDrawings).not.toHaveBeenCalled();
    await sync.dispose();
  });

  it('409: adopts the server copy of conflicting ids and resends the rest', async () => {
    const server = fakeDrawingServer();
    const onError = vi.fn();
    const sync = new DrawingSync({ api: server.api, storage: memStorage(), delay: 0, onError });
    server.put(drw('a'));
    server.put(drw('b'));
    sync.start();
    await sync.pull();
    // Someone else edits "a" on the server.
    server.put(drw('a', { text: 'theirs' }), 2);
    store().apply([drw('a', { text: 'mine' }), drw('b', { text: 'mine' })]);
    await sync.flush();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('1 drawing was changed elsewhere'),
    );
    expect(stored('a')!.text).toBe('theirs');
    expect(server.rows.get('b')!.data.text).toBe('mine');
    expect(sync.meta.revisions).toEqual({ a: 2, b: 2 });
    expect(sync.hasPending).toBe(false);
    await sync.dispose();
  });

  it('pull merges server drawings, drops ones deleted there, keeps local pending edits', async () => {
    const server = fakeDrawingServer();
    const sync = new DrawingSync({
      api: server.api,
      storage: memStorage(),
      delay: 60_000,
      onError: vi.fn(),
    });
    server.put(drw('keep'));
    server.put(drw('gone'));
    sync.start();
    await sync.pull();
    expect(stored('gone')).toBeTruthy();
    server.rows.delete('gone');
    server.put(drw('new', { symbol: 'MSFT' }));
    server.put(drw('keep', { text: 'server' }), 2);
    store().apply([drw('keep', { text: 'local' })]); // pending local edit
    await sync.pull();
    expect(stored('gone')).toBeUndefined();
    expect(stored('new')).toBeTruthy();
    expect(stored('keep')!.text).toBe('local');
    expect(sync.meta.pending).toEqual({ keep: 1 });
    await sync.dispose();
  });

  it('changes merged from another tab are not pushed again', async () => {
    const server = fakeDrawingServer();
    const sync = new DrawingSync({
      api: server.api,
      storage: memStorage(),
      delay: 0,
      onError: vi.fn(),
    });
    sync.start();
    withRemoteApply(() => store().apply([drw('other-tab')]));
    await sync.flush();
    expect(server.fns.batchDrawings).not.toHaveBeenCalled();
    await sync.dispose();
  });

  it('offline: keeps pending changes and retries', async () => {
    vi.useFakeTimers();
    const server = fakeDrawingServer();
    const onOnline = vi.fn();
    const sync = new DrawingSync({
      api: server.api,
      storage: memStorage(),
      delay: 0,
      retryDelay: 100,
      onError: vi.fn(),
      onOnline,
    });
    sync.start();
    server.fns.batchDrawings.mockRejectedValueOnce(offline());
    store().apply([drw('a')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onOnline).toHaveBeenLastCalledWith(false);
    expect(sync.hasPending).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(server.rows.has('a')).toBe(true);
    expect(sync.hasPending).toBe(false);
    expect(onOnline).toHaveBeenLastCalledWith(true);
    await sync.dispose();
  });
});

// ------------------------------------------------------------ migration

function legacyStorage() {
  return memStorage({
    'investopen-drawings': JSON.stringify({
      version: 1,
      bySymbol: { AAPL: [drw('d1', { symbol: '' })] },
      synced: [drw('d2', { scope: 'all', symbol: '' })],
    }),
    'investopen-indicators': JSON.stringify({
      state: { instances: [indicator('i1')] },
      version: 1,
    }),
    'investopen-app': JSON.stringify({
      state: { theme: 'light', favoriteIntervals: ['1D'], symbol: 'AAPL', chartType: 'line' },
      version: 3,
    }),
    'investopen-indicator-prefs': JSON.stringify({
      state: { favorites: ['rsi'], defaults: { rsi: { inputs: { length: 9 } } } },
      version: 1,
    }),
    'investopen-drawing-templates': JSON.stringify({
      state: {
        byType: { 'trend-line': [{ name: 'Red', style: { lineColor: 'red' } }] },
        defaults: { 'trend-line': { lineColor: 'blue' } },
      },
      version: 1,
    }),
    'investopen-ui': JSON.stringify({
      state: { notes: 'hello', syncNewDrawings: true },
      version: 0,
    }),
  });
}

/** Server that applies merge imports keyed like the backend. */
function fakeImportServer() {
  const settings = new Map<string, unknown>();
  const entities = {
    layouts: new Map<string, unknown>(),
    drawings: new Map<string, unknown>(),
    drawingTemplates: new Map<string, unknown>(),
    notes: new Map<string, unknown>(),
  };
  let failMarker = 0;
  const api = {
    getSetting: vi.fn(async (k: string) => {
      if (!settings.has(k)) throw notFound();
      return settings.get(k);
    }),
    putSetting: vi.fn(async (k: string, v: unknown) => {
      if (failMarker > 0) {
        failMarker--;
        throw offline();
      }
      settings.set(k, v);
    }),
    importAll: vi.fn(async (b: Record<string, unknown>, o: { dryRun?: boolean }) => {
      if (o.dryRun) return {};
      for (const l of (b.layouts ?? []) as { id: string }[]) entities.layouts.set(l.id, l);
      for (const d of (b.drawings ?? []) as { data: { id: string } }[])
        entities.drawings.set(d.data.id, d);
      for (const t of (b.drawingTemplates ?? []) as { toolType: string; name: string }[])
        entities.drawingTemplates.set(`${t.toolType}/${t.name}`, t);
      for (const n of (b.notes ?? []) as { id: string }[]) entities.notes.set(n.id, n);
      for (const [k, v] of Object.entries((b.settings ?? {}) as Record<string, unknown>))
        settings.set(k, v);
      return {};
    }),
  };
  return {
    api: api as unknown as MigrationApi,
    fns: api,
    settings,
    entities,
    failMarkerOnce: () => (failMarker = 1),
  };
}

describe('localStorage migration', () => {
  it('builds a bundle from every legacy key', () => {
    const b = buildMigrationBundle(legacyStorage(), state('i1'))!;
    expect(b.app).toBe('investopen');
    expect(b.layouts).toEqual([
      expect.objectContaining({ id: MIGRATED_LAYOUT_ID, name: 'Default', isLastUsed: true }),
    ]);
    expect(b.drawings!.map((d) => (d.data as { id: string }).id).sort()).toEqual(['d1', 'd2']);
    // A blank symbol is filled from its bucket (the server rejects blank ones).
    expect(b.drawings!.find((d) => d.data.id === 'd1')!.data.symbol).toBe('AAPL');
    expect(b.drawingTemplates).toEqual([
      { toolType: 'trend-line', name: 'Red', style: { lineColor: 'red' }, isDefault: false },
      {
        toolType: 'trend-line',
        name: DEFAULT_TEMPLATE_NAME,
        style: { lineColor: 'blue' },
        isDefault: true,
      },
    ]);
    expect(b.settings).toMatchObject({
      'indicators.favorites': ['rsi'],
      'app.prefs': { theme: 'light', favoriteIntervals: ['1D'] },
      'ui.prefs': { syncNewDrawings: true },
    });
    expect(b.notes).toEqual([expect.objectContaining({ symbol: null, text: 'hello' })]);
    expect(buildMigrationBundle(memStorage(), state(''))).toBeNull();
  });

  it('is idempotent: runs once, survives an interrupted run, keeps backups', async () => {
    const server = fakeImportServer();
    const storage = legacyStorage();
    server.failMarkerOnce(); // imported, but the marker write fails
    await expect(runMigration(server.api, storage, () => state('i1'))).rejects.toThrow();
    expect(server.entities.drawings.size).toBe(2);
    // Next start: imports again (same ids/names -> no duplicates), writes the marker.
    expect(await runMigration(server.api, storage, () => state('i1'))).toBe('migrated');
    expect(server.entities.drawings.size).toBe(2);
    expect(server.entities.layouts.size).toBe(1);
    expect(server.entities.drawingTemplates.size).toBe(2);
    expect(server.entities.notes.size).toBe(1);
    expect(server.settings.get(MIGRATION_SETTING)).toMatchObject({ version: 1, imported: true });
    // Dry run before the real import, every time.
    expect(server.fns.importAll.mock.calls.map((c) => c[1])).toEqual([
      { mode: 'merge', dryRun: true },
      { mode: 'merge' },
      { mode: 'merge', dryRun: true },
      { mode: 'merge' },
    ]);
    // Then never again.
    expect(await runMigration(server.api, storage, () => state('i1'))).toBe('done');
    expect(server.fns.importAll).toHaveBeenCalledTimes(4);
    // Originals untouched, backups written.
    for (const k of LEGACY_KEYS) {
      expect(storage.get(k)).not.toBeNull();
      expect(storage.get(backupKeyOf(k))).toBe(storage.get(k));
    }
  });

  it('marks an empty browser as migrated without importing', async () => {
    const server = fakeImportServer();
    expect(await runMigration(server.api, memStorage(), () => state(''))).toBe('empty');
    expect(server.fns.importAll).not.toHaveBeenCalled();
    expect(server.settings.get(MIGRATION_SETTING)).toMatchObject({ imported: false });
  });
});

// ------------------------------------------------------------ templates

describe('indicator templates', () => {
  it('instantiates with new ids and rewired sources', () => {
    const src = indicator('ema_1');
    const dep = indicator('sma_1', { source: { instanceId: 'ema_1', outputId: 'ema' } });
    const [a, b] = instantiateTemplate([src, dep]);
    expect(a!.id).not.toBe('ema_1');
    expect(b!.inputs.source).toEqual({ instanceId: a!.id, outputId: 'ema' });
    expect(src.id).toBe('ema_1'); // input untouched
  });

  it('applies by replacing or adding, as one undo step', () => {
    useIndicatorStore.setState({ instances: [indicator('old')] });
    expect(applyIndicatorTemplate([indicator('t1')], 'add', 'T')).toBeNull();
    expect(useIndicatorStore.getState().instances).toHaveLength(2);
    expect(applyIndicatorTemplate([indicator('t1'), indicator('t2')], 'replace', 'T')).toBeNull();
    expect(useIndicatorStore.getState().instances).toHaveLength(2);
    expect(useIndicatorStore.getState().instances.some((i) => i.id === 'old')).toBe(false);
    useHistory.getState().undo();
    expect(useIndicatorStore.getState().instances).toHaveLength(2);
    expect(useIndicatorStore.getState().instances[0]!.id).toBe('old');
    expect(applyIndicatorTemplate([{ bogus: 1 }], 'add', 'Bad')).toMatch(/no indicators/);
    expect(applyIndicatorTemplate([{ ...indicator('u'), type: 'nope' }], 'add', 'U')).toMatch(
      /Unknown indicator/,
    );
  });
});

describe('drawing templates sync', () => {
  function fakeTemplateServer() {
    const rows = new Map<
      string,
      { id: string; toolType: string; name: string; style: object; isDefault: boolean }
    >();
    let seq = 0;
    const api = {
      listDrawingTemplates: vi.fn(async () => [...rows.values()].map((r) => ({ ...r }))),
      saveDrawingTemplate: vi.fn(
        async (b: { toolType: string; name: string; style: object; isDefault?: boolean }) => {
          const key = `${b.toolType}/${b.name}`;
          const id = rows.get(key)?.id ?? `t${++seq}`;
          const row = {
            id,
            toolType: b.toolType,
            name: b.name,
            style: b.style,
            isDefault: !!b.isDefault,
          };
          rows.set(key, row);
          return row;
        },
      ),
      deleteDrawingTemplate: vi.fn(async (id: string) => {
        for (const [k, r] of rows) if (r.id === id) rows.delete(k);
      }),
    };
    return { api: api as unknown as DrawingTemplateApi, fns: api, rows };
  }

  beforeEach(() => useDrawingTemplates.setState({ byType: {}, defaults: {} }));

  it('loads server templates into the store and pushes local edits', async () => {
    const server = fakeTemplateServer();
    await server.api.saveDrawingTemplate({
      toolType: 'ray',
      name: 'Blue',
      style: { lineColor: 'blue' },
    });
    await server.api.saveDrawingTemplate({
      toolType: 'ray',
      name: DEFAULT_TEMPLATE_NAME,
      style: { lineWidth: 3 },
      isDefault: true,
    });
    const sync = new DrawingTemplatesSync({
      api: server.api,
      storage: memStorage(),
      delay: 0,
      onError: vi.fn(),
    });
    sync.start();
    await sync.load();
    expect(useDrawingTemplates.getState().byType.ray).toEqual([
      { name: 'Blue', style: { lineColor: 'blue' } },
    ]);
    expect(useDrawingTemplates.getState().defaults.ray).toEqual({ lineWidth: 3 });

    useDrawingTemplates.getState().saveTemplate('ray', 'Red', { lineColor: 'red' });
    useDrawingTemplates.getState().removeTemplate('ray', 'Blue');
    useDrawingTemplates.getState().clearDefault('ray');
    await sync.flush();
    expect([...server.rows.keys()]).toEqual(['ray/Red']);
    expect(sync.dirty).toBe(false);
    await sync.dispose();
  });

  it('offline edits are pushed on the next start instead of being overwritten', async () => {
    const server = fakeTemplateServer();
    const storage = memStorage();
    const first = new DrawingTemplatesSync({
      api: server.api,
      storage,
      delay: 0,
      onError: vi.fn(),
    });
    first.start();
    useDrawingTemplates.getState().saveDefault('ray', { lineColor: 'green' });
    expect(first.dirty).toBe(true);
    await first.dispose();
    const next = new DrawingTemplatesSync({ api: server.api, storage, delay: 0, onError: vi.fn() });
    next.start();
    await next.load();
    await next.flush();
    expect(server.rows.get(`ray/${DEFAULT_TEMPLATE_NAME}`)).toMatchObject({
      isDefault: true,
      style: { lineColor: 'green' },
    });
    expect(useDrawingTemplates.getState().defaults.ray).toEqual({ lineColor: 'green' });
    await next.dispose();
  });
});

describe('chart templates', () => {
  it('apply only known, well-typed values', () => {
    const base = {
      theme: 'dark' as const,
      crosshair: 'cross' as const,
      magnet: 'off' as const,
      prepost: false,
      timezone: 'exchange',
      chartStyle: {},
      showPrevClose: false,
      scale: null,
    };
    const out = readChartTemplate(base, {
      theme: 'light',
      // Legacy built-in volume mode (now the Volume indicator): ignored.
      volume: 'pane',
      prepost: 'yes',
      chartStyle: { candles: { upColor: '#0f0' } },
      extra: 1,
    });
    expect(out).toEqual({ ...base, theme: 'light', chartStyle: { candles: { upColor: '#0f0' } } });
    expect(readChartTemplate(base, null)).toEqual(base);
  });
});

// ------------------------------------------------------------ settings and notes

describe('settings sync', () => {
  function defs(): { defs: SettingDef[]; value: { v: unknown }; fire: () => void } {
    const value = { v: 1 as unknown };
    let listener: (() => void) | null = null;
    return {
      value,
      fire: () => listener?.(),
      defs: [
        {
          key: 'k',
          read: () => value.v,
          write: (v) => (value.v = v),
          subscribe: (fn) => {
            listener = fn;
            return () => (listener = null);
          },
        },
      ],
    };
  }
  const api = (server: Record<string, unknown>) =>
    ({
      getSettings: vi.fn(async () => ({ ...server })),
      patchSettings: vi.fn(async (p: Record<string, unknown>) => Object.assign(server, p)),
    }) as unknown as SettingsApi & { patchSettings: ReturnType<typeof vi.fn> };

  it('adopts server values and pushes later edits', async () => {
    const server: Record<string, unknown> = { k: 5 };
    const d = defs();
    const a = api(server);
    const sync = new SettingsSync({
      api: a,
      storage: memStorage(),
      defs: d.defs,
      delay: 0,
      onError: vi.fn(),
    });
    sync.start();
    await sync.load();
    expect(d.value.v).toBe(5);
    d.value.v = 6;
    d.fire();
    await sync.flush();
    expect(server.k).toBe(6);
    expect(a.patchSettings).toHaveBeenCalledOnce();
    await sync.dispose();
  });

  it('edits made offline before loading win over the server', async () => {
    const server: Record<string, unknown> = { k: 5 };
    const storage = memStorage();
    const d = defs();
    const offlineSync = new SettingsSync({
      api: api(server),
      storage,
      defs: d.defs,
      onError: vi.fn(),
    });
    offlineSync.start();
    d.value.v = 9;
    d.fire();
    await offlineSync.dispose();
    const sync = new SettingsSync({
      api: api(server),
      storage,
      defs: d.defs,
      delay: 0,
      onError: vi.fn(),
    });
    sync.start();
    await sync.load();
    await sync.flush();
    expect(d.value.v).toBe(9);
    expect(server.k).toBe(9);
    expect(sync.dirty.size).toBe(0);
    await sync.dispose();
  });

  it('real stores: indicator favorites round-trip', async () => {
    const server: Record<string, unknown> = { 'indicators.favorites': ['macd', 3] };
    const sync = new SettingsSync({
      api: api(server),
      storage: memStorage(),
      delay: 0,
      onError: vi.fn(),
    });
    sync.start();
    await sync.load();
    expect(useIndicatorPrefs.getState().favorites).toEqual(['macd']);
    useIndicatorPrefs.getState().toggleFavorite('rsi');
    await sync.flush();
    expect(server['indicators.favorites']).toEqual(['macd', 'rsi']);
    await sync.dispose();
  });
});

describe('notes sync', () => {
  it('creates, updates with revision, and resolves conflicts', async () => {
    useNotesStore.setState({ notes: {} });
    let server = { id: '', symbol: 'AAPL' as string | null, text: '', revision: 0 };
    const api = {
      listNotes: vi.fn(async () => []),
      createNote: vi.fn(async (b: { text: string; symbol?: string | null }) => {
        server = { id: 'n1', symbol: b.symbol ?? null, text: b.text, revision: 1 };
        return { ...server, createdAt: '', updatedAt: '' };
      }),
      updateNote: vi.fn(async (_id: string, b: { text: string; revision?: number }) => {
        if (b.revision !== undefined && b.revision !== server.revision)
          throw conflict({
            message: 'stale',
            current: { ...server, createdAt: '', updatedAt: '' },
          });
        server = { ...server, text: b.text, revision: server.revision + 1 };
        return { ...server, createdAt: '', updatedAt: '' };
      }),
    };
    const onConflict = vi.fn();
    const sync = new NotesSync({
      api: api as unknown as NotesApi,
      delay: 0,
      onError: vi.fn(),
      onConflict,
    });
    sync.start();
    await sync.load();
    useNotesStore.getState().edit('AAPL', 'buy');
    await sync.flush();
    expect(api.createNote).toHaveBeenCalledWith({ text: 'buy', symbol: 'AAPL' });
    useNotesStore.getState().edit('AAPL', 'buy more');
    await sync.flush();
    expect(api.updateNote.mock.calls[0]![1]).toEqual({
      text: 'buy more',
      symbol: 'AAPL',
      revision: 1,
    });
    expect(useNotesStore.getState().notes.AAPL).toMatchObject({ revision: 2, dirty: false });

    server = { ...server, text: 'sold', revision: 5 }; // edited on another device
    useNotesStore.getState().edit('AAPL', 'hold');
    await sync.flush();
    expect(useNotesStore.getState().notes.AAPL).toMatchObject({
      text: 'sold',
      revision: 5,
      dirty: false,
    });
    // "Keep mine" re-applies my text on top of the server revision.
    onConflict.mock.calls[0]![1]();
    await sync.flush();
    expect(server.text).toBe('hold');
    expect(useNotesStore.getState().notes[GENERAL_NOTE]).toBeUndefined();
    await sync.dispose();
  });
});

// ------------------------------------------------------------ review regressions

describe('migration: mutual exclusion and other browsers', () => {
  it('the localStorage lease lets one tab migrate at a time; the second sees the marker', async () => {
    const server = fakeImportServer();
    const shared = legacyStorage(); // two tabs of one browser share localStorage
    let inside = 0;
    let maxInside = 0;
    const slowImport = server.fns.importAll.getMockImplementation()!;
    server.fns.importAll.mockImplementation(async (b, o) => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 5));
      inside--;
      return slowImport(b, o);
    });
    const tab = () =>
      withMigrationLock(() => runMigration(server.api, shared, () => state('i1')), {
        locks: null,
        storage: shared,
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
      });
    const results = await Promise.all([tab(), tab()]);
    expect(results.sort()).toEqual(['done', 'migrated']);
    expect(maxInside).toBe(1);
    expect(server.fns.importAll).toHaveBeenCalledTimes(2); // one dry run + one import
    expect(shared.get(LEASE_KEY)).toBeNull(); // released
  });

  it('takes over an expired lease and honours an abort while waiting', async () => {
    const storage = memStorage({ [LEASE_KEY]: JSON.stringify({ owner: 'crashed', until: 0 }) });
    expect(await withMigrationLock(async () => 'ran', { locks: null, storage })).toBe('ran');
    storage.set(LEASE_KEY, JSON.stringify({ owner: 'other', until: Date.now() + 60_000 }));
    const ctl = new AbortController();
    const waiting = withMigrationLock(async () => 'never', {
      locks: null,
      storage,
      signal: ctl.signal,
      sleep: () => new Promise((r) => setTimeout(r, 1)),
    });
    ctl.abort();
    await expect(waiting).rejects.toThrow(/Abort/);
  });

  it('uses Web Locks when available', async () => {
    const request = vi.fn(async (_name: string, _o: unknown, fn: () => Promise<unknown>) => fn());
    const locks = { request } as unknown as LockManagerLike;
    expect(await withMigrationLock(async () => 7, { locks, storage: memStorage() })).toBe(7);
    expect(request.mock.calls[0]![0]).toBe('investopen-migration');
  });

  it('concurrent starts in one page share one run; an aborted caller stops waiting only', async () => {
    const server = fakeImportServer();
    const storage = legacyStorage();
    const first = new AbortController();
    const a = migrateExclusive(server.api, storage, () => state('i1'), {
      locks: null,
      signal: first.signal,
    });
    const b = migrateExclusive(server.api, storage, () => state('i1'), { locks: null });
    first.abort(); // StrictMode: the first mount is disposed
    await expect(a).rejects.toThrow(/Abort/);
    expect(await b).toBe('migrated');
    expect(server.fns.importAll).toHaveBeenCalledTimes(2);
  });

  it('another browser migrated first: backs up this one and offers its data once', async () => {
    const server = fakeImportServer();
    server.settings.set(MIGRATION_SETTING, { version: 1 });
    const storage = legacyStorage();
    expect(await runMigration(server.api, storage, () => state('i1'))).toBe('local-data');
    for (const k of LEGACY_KEYS) expect(storage.get(backupKeyOf(k))).toBe(storage.get(k));
    expect(storage.get(LOCAL_BUNDLE_KEY)).not.toBeNull();
    expect(server.fns.importAll).not.toHaveBeenCalled(); // nothing written without consent
    // Still offered on the next start until the user decides.
    expect(await runMigration(server.api, storage, () => state('i1'))).toBe('local-data');

    expect(await importLocalData(server.api, storage, Date.UTC(2026, 4, 2))).toBe(
      'From this browser (2026-05-02)',
    );
    const imported = server.fns.importAll.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(imported.settings).toBeUndefined(); // server prefs untouched
    expect(imported.drawingTemplates).toBeUndefined();
    const [layout] = imported.layouts as { id: string; isLastUsed: boolean }[];
    expect(layout!.id).not.toBe(MIGRATED_LAYOUT_ID);
    expect(layout!.isLastUsed).toBe(false);
    expect(await runMigration(server.api, storage, () => state('i1'))).toBe('done');
  });

  it('dismissing keeps the backups and stops offering', async () => {
    const server = fakeImportServer();
    server.settings.set(MIGRATION_SETTING, { version: 1 });
    const storage = legacyStorage();
    await runMigration(server.api, storage, () => state('i1'));
    dismissLocalData(storage);
    expect(await runMigration(server.api, storage, () => state('i1'))).toBe('done');
    expect(storage.get(backupKeyOf('investopen-drawings'))).not.toBeNull();
  });
});

describe('layouts: offline caches and deleted layouts', () => {
  it("a layout made offline becomes a new layout, not a write over the server's last-used one", async () => {
    const server = fakeLayoutServer();
    const other = server.seed('Other device', state('theirs'), 4);
    const storage = memStorage({
      [LAYOUT_CACHE_KEY]: JSON.stringify({
        id: null,
        name: 'Untitled',
        revision: 0,
        dirty: true,
        state: state('offline'),
      }),
    });
    const t = session(server, storage);
    await t.s.start();
    expect(server.layouts.get(other)!.state.indicators[0]!.id).toBe('theirs');
    expect(server.layouts.get(other)!.revision).toBe(4);
    const mine = [...server.layouts.values()].find((l) => l.id !== other)!;
    expect(mine.name).toBe('Untitled (offline)');
    expect(mine.state.indicators[0]!.id).toBe('offline');
    expect(useLayoutStatus.getState().current?.id).toBe(mine.id);
  });

  it('unsaved changes of a layout that is no longer last-used reopen it and are saved', async () => {
    const server = fakeLayoutServer();
    const a = server.seed('A', state('a'), 2);
    server.seed('B', state('b')); // another device switched to B
    const storage = memStorage({
      [LAYOUT_CACHE_KEY]: JSON.stringify({
        id: a,
        name: 'A',
        revision: 2,
        dirty: true,
        state: state('a-edit'),
      }),
    });
    const t = session(server, storage);
    await t.s.start();
    await t.s.save();
    expect(useLayoutStatus.getState().current?.id).toBe(a);
    expect(server.layouts.get(a)!.state.indicators[0]!.id).toBe('a-edit');
  });

  it('a layout deleted elsewhere: one notice, saving stops, "Save as new layout" restores it', async () => {
    const server = fakeLayoutServer();
    const a = server.seed('A', state('a'));
    const t = session(server);
    await t.s.start();
    server.layouts.delete(a);
    t.edit(state('e1'));
    await t.s.save();
    t.edit(state('e2'));
    await t.s.save();
    expect(t.notify.conflict).toHaveBeenCalledOnce();
    expect(t.notify.error).not.toHaveBeenCalled();
    expect(server.fns.saveLayout).toHaveBeenCalledOnce(); // not retried per edit
    expect(JSON.parse(t.storage.get(LAYOUT_ORPHAN_KEY)!).state.indicators[0].id).toBe('e2');
    const [action] = t.notify.conflict.mock.calls[0]![1] as { label: string; run: () => void }[];
    expect(action!.label).toBe('Save as new layout');
    action!.run();
    await settle();
    const restored = [...server.layouts.values()][0]!;
    expect(restored.name).toBe('A (restored)');
    expect(restored.state.indicators[0]!.id).toBe('e2');
    expect(t.storage.get(LAYOUT_ORPHAN_KEY)).toBeNull();
  });

  it('a dirty cache of a layout deleted while this browser was away is kept and offered', async () => {
    const server = fakeLayoutServer();
    server.seed('B', state('b'));
    const storage = memStorage({
      [LAYOUT_CACHE_KEY]: JSON.stringify({
        id: 'gone',
        name: 'Gone',
        revision: 3,
        dirty: true,
        state: state('unsaved'),
      }),
    });
    const t = session(server, storage);
    await t.s.start();
    expect(t.notify.conflict).toHaveBeenCalledOnce();
    expect(JSON.parse(storage.get(LAYOUT_ORPHAN_KEY)!).state.indicators[0].id).toBe('unsaved');
  });

  it('edits made while another layout loads are saved to the old layout', async () => {
    const server = fakeLayoutServer();
    const a = server.seed('A', state('a'));
    const b = server.seed('B', state('b'));
    const t = session(server);
    await t.s.start(); // B
    const realGet = server.fns.getLayout.getMockImplementation()!;
    server.fns.getLayout.mockImplementationOnce(async (id: string) => {
      t.edit(state('b-late-edit')); // typed while the request was in flight
      return realGet(id);
    });
    expect(await t.s.load(a)).toBe(true);
    expect(server.layouts.get(b)!.state.indicators[0]!.id).toBe('b-late-edit');
    expect(useLayoutStatus.getState().current?.id).toBe(a);
  });

  it('view-only changes while the chart settles after a switch are not saved', async () => {
    let clock = 1_000_000;
    const server = fakeLayoutServer();
    const chart = (barSpacing: number) =>
      ({
        version: 1,
        symbol: 'AAPL',
        interval: '1D',
        timeScale: { barSpacing, rightOffset: 0 },
        crosshair: { mode: 'cross', magnet: 'off' },
        timezone: 'exchange',
        panes: [],
        maximizedPane: null,
      }) as unknown as NonNullable<LayoutState['chart']>;
    server.seed('A', { ...state('a'), chart: chart(6) });
    const t = session(server, memStorage(), () => clock);
    await t.s.start();
    t.edit({ ...state('a'), chart: chart(7) }); // the chart clamps after loading
    await t.s.save();
    expect(server.fns.saveLayout).not.toHaveBeenCalled();
    t.edit({ ...state('a2'), chart: chart(7) }); // a real edit is still saved
    await t.s.save();
    expect(server.fns.saveLayout).toHaveBeenCalledOnce();
    clock += 5000; // later, zooming is an edit
    t.edit({ ...state('a2'), chart: chart(9) });
    await t.s.save();
    expect(server.fns.saveLayout).toHaveBeenCalledTimes(2);
  });
});

describe('data import', () => {
  const full = {
    version: 1,
    app: 'investopen' as const,
    layouts: [],
    drawings: [],
    indicatorTemplates: [],
    drawingTemplates: [],
    chartTemplates: [],
    settings: {},
    notes: [],
  };

  it('saves, stops persistence, imports, keeps the migration marker, drops caches, reloads', async () => {
    const order: string[] = [];
    const api = {
      importAll: vi.fn(
        async (_b: unknown, o: unknown) => void order.push(`import ${JSON.stringify(o)}`),
      ),
      putSetting: vi.fn(async (k: string) => void order.push(`put ${k}`)),
    } as unknown as TransferApi;
    const storage = memStorage(Object.fromEntries(CACHE_KEYS.map((k) => [k, 'x'])));
    const reload = vi.fn(() => order.push('reload'));
    await importBundle(full, 'replace', {
      api,
      storage,
      reload,
      persistence: {
        flushAll: async () => void order.push('flush'),
        halt: async () => void order.push('halt'),
        drawings: { hasPending: false } as DrawingSync,
        layouts: {} as LayoutSession,
      },
    });
    expect(order).toEqual([
      'flush',
      'halt',
      'import {"mode":"replace","confirm":true}',
      `put ${MIGRATION_SETTING}`,
      'reload',
    ]);
    for (const k of CACHE_KEYS) expect(storage.get(k)).toBeNull();
  });

  it('does nothing when local changes could not be saved first', async () => {
    const api = { importAll: vi.fn(), putSetting: vi.fn() } as unknown as TransferApi;
    const halt = vi.fn();
    await expect(
      importBundle(full, 'merge', {
        api,
        storage: memStorage(),
        reload: vi.fn(),
        persistence: {
          flushAll: async () => {},
          halt,
          drawings: { hasPending: true } as DrawingSync,
          layouts: {} as LayoutSession,
        },
      }),
    ).rejects.toThrow(/nothing was imported/);
    expect(halt).not.toHaveBeenCalled();
    expect(api.importAll).not.toHaveBeenCalled();
  });

  it('replace is only for full backups; stale dry runs are ignored', () => {
    expect(isFullBundle(full)).toBe(true);
    const { notes: _n, ...partial } = full;
    expect(isFullBundle(partial)).toBe(false);
    const req = latestOnly();
    const merge = req.begin();
    const replace = req.begin(); // mode switched before the first answered
    expect(merge()).toBe(false);
    expect(replace()).toBe(true);
    req.invalidate();
    expect(replace()).toBe(false);
  });
});

describe('rejected saves keep local edits', () => {
  const noteApi = () => ({
    listNotes: vi.fn(async () => [] as unknown[]),
    createNote: vi.fn(async () => {
      throw new ApiError('text too long', 422);
    }),
    updateNote: vi.fn(),
  });

  it('notes: a rejected note stays dirty, is not resent, and survives the next load', async () => {
    useNotesStore.setState({ notes: {} });
    const api = noteApi();
    const onError = vi.fn();
    const sync = new NotesSync({
      api: api as unknown as NotesApi,
      delay: 0,
      onError,
      onConflict: vi.fn(),
    });
    sync.start();
    await sync.load();
    useNotesStore.getState().edit('AAPL', 'long text');
    await sync.flush();
    await sync.flush();
    expect(api.createNote).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('kept in this browser'));
    expect(useNotesStore.getState().notes.AAPL).toMatchObject({ text: 'long text', dirty: true });
    await sync.dispose();
    // Next start: the server has an older note for AAPL; mine is not replaced silently.
    api.listNotes.mockResolvedValue([
      { id: 'n9', symbol: 'AAPL', text: 'server text', revision: 3, createdAt: '', updatedAt: '' },
    ]);
    const onConflict = vi.fn();
    const next = new NotesSync({ api: api as unknown as NotesApi, delay: 0, onError, onConflict });
    next.start();
    await next.load();
    expect(onConflict).toHaveBeenCalledOnce();
    expect(api.updateNote).not.toHaveBeenCalled(); // never a revision-less overwrite
    onConflict.mock.calls[0]![1](); // keep mine
    api.updateNote.mockImplementation(
      async (_id: string, b: { text: string; revision: number }) => ({
        id: 'n9',
        symbol: 'AAPL',
        text: b.text,
        revision: 4,
        createdAt: '',
        updatedAt: '',
      }),
    );
    await next.flush();
    expect(api.updateNote.mock.calls[0]![1]).toEqual({
      text: 'long text',
      symbol: 'AAPL',
      revision: 3,
    });
    await next.dispose();
  });

  it('settings: a rejected value stays dirty and is pushed again on the next start', async () => {
    const server: Record<string, unknown> = { k: 1 };
    const value = { v: 1 as unknown };
    const defs: SettingDef[] = [
      { key: 'k', read: () => value.v, write: (v) => (value.v = v), subscribe: () => () => {} },
    ];
    const patchSettings = vi.fn(async () => {
      throw new ApiError('too large', 422);
    });
    const storage = memStorage();
    const api = {
      getSettings: async () => ({ ...server }),
      patchSettings,
    } as unknown as SettingsApi;
    const sync = new SettingsSync({ api, storage, defs, delay: 0, onError: vi.fn() });
    sync.start();
    await sync.load();
    value.v = 2;
    (sync as unknown as { onChange: (d: SettingDef) => void }).onChange(defs[0]!);
    await sync.flush();
    await sync.flush();
    expect(patchSettings).toHaveBeenCalledOnce();
    expect(sync.dirty.has('k')).toBe(true);
    await sync.dispose();
    const next = new SettingsSync({ api, storage, defs, delay: 0, onError: vi.fn() });
    next.start();
    await next.load();
    expect(value.v).toBe(2); // not replaced by the server's 1
  });
});

describe('ui: toasts and lazy dialogs', () => {
  it('action toasts are never pushed out by newer plain toasts', () => {
    const conflict = { id: 0, actions: [{}] };
    const plain = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, actions: [] }));
    const kept = capToasts([conflict, ...plain]);
    expect(kept[0]).toBe(conflict);
    expect(kept.map((t) => t.id)).toEqual([0, 3, 4, 5, 6]);
  });

  it('a failed dialog chunk import is retried', async () => {
    const importer = vi
      .fn<() => Promise<{ default: () => null }>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValue({ default: () => null });
    const dlg = retryableLazy(importer);
    const before = dlg.get();
    await expect(dlg.load()).rejects.toThrow('chunk failed');
    dlg.reset();
    expect(dlg.get()).not.toBe(before);
    await expect(dlg.load()).resolves.toHaveProperty('default');
    expect(importer).toHaveBeenCalledTimes(2);
  });
});

describe('renamed indicator ids', () => {
  const OLD = ['pivots-hl', 'auto-fib', 'relative-volume'];
  const NEW = ['swing-hl', 'swing-fib', 'tod-relative-volume'];
  const typed = (id: string, type: string) => ({ ...indicator(id), type });
  const types = (s: { indicators: IndicatorState[] }) => s.indicators.map((i) => i.type);

  it('layout upgrade (v3 -> v4) retypes old ids and is idempotent', () => {
    const raw = { indicators: OLD.map((t, i) => typed(`i${i}`, t)).concat([typed('s', 'sma')]) };
    const s = parseLayoutState(raw, 3)!;
    expect(types(s)).toEqual([...NEW, 'sma']);
    expect(parseLayoutState(s)!.indicators).toEqual(s.indicators);
    expect(types(parseLayoutState(raw, 1)!)).toEqual([...NEW, 'sma']);
  });

  it('indicator templates retype old ids on apply', () => {
    useIndicatorStore.setState({ instances: [] });
    expect(
      applyIndicatorTemplate(
        OLD.map((t, i) => typed(`t${i}`, t)),
        'add',
        'T',
      ),
    ).toBeNull();
    expect(useIndicatorStore.getState().instances.map((i) => i.type)).toEqual(NEW);
  });

  it('indicator store migrate retypes persisted instances', () => {
    const migrate = migrateIndicatorStore;
    const out = migrate({ instances: OLD.map((t, i) => typed(`i${i}`, t)) }, 2) as {
      instances: IndicatorState[];
    };
    expect(out.instances.map((i) => i.type)).toEqual(NEW);
    const cur = migrate({ instances: [typed('a', 'sma')] }, 3) as { instances: IndicatorState[] };
    expect(cur.instances.map((i) => i.type)).toEqual(['sma']);
  });

  it('prefs migrate maps favorites (deduped) and defaults', () => {
    const migrate = migrateIndicatorPrefs;
    const out = migrate(
      {
        favorites: ['rsi', 'auto-fib', 'swing-fib', 'relative-volume', 7],
        defaults: { 'pivots-hl': { inputs: { a: 1 } }, sma: { inputs: {} } },
      },
      1,
    ) as { favorites: string[]; defaults: Record<string, unknown> };
    expect(out.favorites).toEqual(['rsi', 'swing-fib', 'tod-relative-volume']);
    expect(Object.keys(out.defaults).sort()).toEqual(['sma', 'swing-hl']);
  });

  it('synced favorites and defaults settings map old ids on write', () => {
    const fav = SETTING_DEFS.find((d) => d.key === 'indicators.favorites')!;
    const def = SETTING_DEFS.find((d) => d.key === 'indicators.defaults')!;
    fav.write(['auto-fib', 'rsi']);
    def.write({ 'relative-volume': { inputs: {} } });
    expect(useIndicatorPrefs.getState().favorites).toEqual(['swing-fib', 'rsi']);
    expect(Object.keys(useIndicatorPrefs.getState().defaults)).toEqual(['tod-relative-volume']);
    useIndicatorPrefs.setState({ favorites: [], defaults: {} });
  });
});
