import type { Chart, Drawing } from '@investopen/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistory } from '../commands/history';
import { useChartStore } from '../store/chart';
import { useIndicatorStore } from '../indicators/store';
import { useAppStore } from '../store/app';
import { useUiStore } from '../store/ui';
import { isToolAvailable } from '../toolbar/tools';
import { attachDrawings, engineTool, keepPerDrawingStyle } from './attach';
import {
  amendCreated,
  amendGesture,
  commit,
  copyDrawings,
  currentDrawings,
  findDrawing,
  finishTextEdit,
  flushGestures,
  foldHistorySince,
  historyMark,
  mergeChanges,
  pasteDrawings,
  removePaneDrawings,
  scopePatch,
  recordGesture,
  removeAllObjects,
  removeDrawings,
  reorderPane,
  setDrawingStyle,
  setScope,
  toggleLocked,
  updateDrawings,
  zOrder,
  zOrderStack,
} from './actions';
import { currentPreset, deepEqual, visibilityPreset } from './model';
import {
  STORAGE_KEY,
  applyToBuckets,
  backupKey,
  drawingsFor,
  loadDrawings,
  mergeBuckets,
  parseDrawings,
  serializeDrawings,
  setLoadState,
  startDrawingPersistence,
  useDrawingRuntime,
  useDrawingStore,
} from './store';
import { chartClipboardTarget } from './commands';
import { reconcileDrawings, type DrawingSink, type SyncedDrawings } from './sync';

let seq = 0;
function drw(patch: Partial<Drawing> = {}): Drawing {
  seq++;
  return {
    id: `d${seq}`,
    type: 'trend-line',
    points: [
      { time: 1000 * seq, price: 10 },
      { time: 2000 * seq, price: 20 },
    ],
    style: { lineColor: '#2962ff', lineWidth: 2 },
    text: '',
    locked: false,
    hidden: false,
    zIndex: seq,
    visibility: null,
    scope: 'symbol',
    symbol: 'AAPL',
    paneId: 'main',
    ...patch,
  };
}

const undo = () => useHistory.getState().undo();
const redo = () => useHistory.getState().redo();
const past = () => useHistory.getState().past;

function seed(...list: Drawing[]) {
  useDrawingStore.setState({ bySymbol: {}, synced: [] });
  useDrawingStore.getState().apply(list);
}

beforeEach(() => {
  useDrawingStore.setState({ bySymbol: {}, synced: [] });
  useHistory.getState().clear();
  useAppStore.setState({ symbol: 'AAPL', interval: '1D' });
  useIndicatorStore.setState({ instances: [] });
  flushGestures();
  useHistory.getState().clear();
  setLoadState({ warning: null, writable: true });
  useDrawingRuntime.setState({ dragging: false, textEdit: null, selection: [] });
});

/** In-memory Storage. */
function memStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
  };
}

describe('store and persistence', () => {
  it('routes drawings to symbol buckets or the synced bucket and moves them on scope change', () => {
    const a = drw();
    const b = drw({ symbol: 'MSFT' });
    const c = drw({ scope: 'all' });
    let s = applyToBuckets({ bySymbol: {}, synced: [] }, [a, b, c]);
    expect(s.bySymbol.AAPL!.map((d) => d.id)).toEqual([a.id]);
    expect(s.bySymbol.MSFT!.map((d) => d.id)).toEqual([b.id]);
    expect(s.synced.map((d) => d.id)).toEqual([c.id]);
    expect(drawingsFor(s, 'AAPL').map((d) => d.id)).toEqual([a.id, c.id]);

    s = applyToBuckets(s, [{ ...a, scope: 'all' }], [b.id]);
    expect(s.bySymbol).toEqual({});
    expect(s.synced.map((d) => d.id)).toEqual([c.id, a.id]);
  });

  it('round-trips the documented JSON shape and ignores bad data', () => {
    const a = drw();
    const c = drw({ scope: 'all' });
    const raw = serializeDrawings({ bySymbol: { AAPL: [a], EMPTY: [] }, synced: [c] });
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.bySymbol)).toEqual(['AAPL']);
    expect(parseDrawings(raw)).toEqual({ bySymbol: { AAPL: [a] }, synced: [c] });

    expect(parseDrawings(null)).toEqual({ bySymbol: {}, synced: [] });
    expect(parseDrawings('{nope')).toEqual({ bySymbol: {}, synced: [] });
    expect(parseDrawings(JSON.stringify({ version: 2, bySymbol: {}, synced: [] }))).toEqual({
      bySymbol: {},
      synced: [],
    });
    const junk = JSON.stringify({ version: 1, bySymbol: { X: [{ id: 1 }, a] }, synced: 'x' });
    expect(parseDrawings(junk)).toEqual({ bySymbol: { X: [a] }, synced: [] });
  });

  it('saves debounced on change and flushes on demand', () => {
    vi.useFakeTimers();
    const storage = { setItem: vi.fn() };
    const p = startDrawingPersistence(storage, 300);
    useDrawingStore.getState().apply([drw()]);
    useDrawingStore.getState().apply([drw()]);
    expect(storage.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem.mock.calls[0]![0]).toBe(STORAGE_KEY);
    useDrawingStore.getState().apply([drw()]);
    p.flush();
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(parseDrawings(storage.setItem.mock.calls[1]![1]).bySymbol.AAPL).toHaveLength(3);
    p.stop();
    vi.useRealTimers();
  });

  it('reports a failing storage once', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const storage = {
      setItem: () => {
        throw new Error('quota');
      },
    };
    const p = startDrawingPersistence(storage, 10, onError);
    useDrawingStore.getState().apply([drw()]);
    vi.advanceTimersByTime(10);
    useDrawingStore.getState().apply([drw()]);
    vi.advanceTimersByTime(10);
    expect(onError).toHaveBeenCalledTimes(1);
    p.stop();
    vi.useRealTimers();
  });
});

describe('undo/redo', () => {
  it('merges changes per id and drops no-ops', () => {
    const a = drw();
    const a2 = { ...a, locked: true };
    expect(
      mergeChanges([
        { before: null, after: a },
        { before: a, after: a2 },
      ]),
    ).toEqual([{ before: null, after: a2 }]);
    expect(
      mergeChanges([
        { before: a, after: a2 },
        { before: a2, after: a },
      ]),
    ).toEqual([]);
  });

  it('updates and removes as single undoable steps', () => {
    const a = drw();
    const b = drw();
    seed(a, b);
    updateDrawings([a.id, b.id], { style: { lineColor: '#f23645' } }, 'Color');
    expect(currentDrawings().map((d) => d.style.lineColor)).toEqual(['#f23645', '#f23645']);
    expect(findDrawing(a.id)!.style.lineWidth).toBe(2);
    removeDrawings([a.id]);
    expect(currentDrawings().map((d) => d.id)).toEqual([b.id]);
    expect(past().map((e) => e.label)).toEqual(['Color', 'Remove Trend line']);
    undo();
    expect(findDrawing(a.id)!.style.lineColor).toBe('#f23645');
    undo();
    expect(findDrawing(a.id)!.style.lineColor).toBe('#2962ff');
    redo();
    redo();
    expect(findDrawing(a.id)).toBeUndefined();
  });

  it('skips locked drawings for the Delete key only', () => {
    const a = drw({ locked: true });
    seed(a);
    removeDrawings([a.id], { skipLocked: true });
    expect(findDrawing(a.id)).toBeDefined();
    removeDrawings([a.id]);
    expect(findDrawing(a.id)).toBeUndefined();
  });

  it('coalesces repeated colour picks into one step', () => {
    const a = drw();
    seed(a);
    setDrawingStyle([a.id], { lineColor: '#111111' }, 'Change line color', 'color:lineColor');
    setDrawingStyle([a.id], { lineColor: '#222222' }, 'Change line color', 'color:lineColor');
    expect(past()).toHaveLength(1);
    undo();
    expect(findDrawing(a.id)!.style.lineColor).toBe('#2962ff');
  });

  it('records engine gestures of one task as one step (create + default style amend)', async () => {
    const created = drw();
    recordGesture('Create Trend line', [{ before: null, after: created }]);
    amendGesture(created.id, { style: { lineWidth: 4 } });
    expect(findDrawing(created.id)!.style.lineWidth).toBe(4);
    await Promise.resolve();
    expect(past().map((e) => e.label)).toEqual(['Create Trend line']);
    undo();
    expect(findDrawing(created.id)).toBeUndefined();
    redo();
    expect(findDrawing(created.id)!.style.lineWidth).toBe(4);
  });

  it('records a drag (drawingChanged) and undoes it', async () => {
    const a = drw();
    seed(a);
    const moved = {
      ...a,
      points: [
        { time: 5, price: 50 },
        { time: 6, price: 60 },
      ],
    };
    recordGesture('Move Trend line', [{ before: a, after: moved }]);
    await Promise.resolve();
    expect(findDrawing(a.id)!.points[0]!.price).toBe(50);
    undo();
    expect(findDrawing(a.id)!.points[0]!.price).toBe(10);
  });

  it('lock toggles and scope changes are undoable', () => {
    const a = drw();
    seed(a);
    toggleLocked([a.id]);
    expect(findDrawing(a.id)!.locked).toBe(true);
    setScope([a.id], 'all');
    expect(useDrawingStore.getState().synced.map((d) => d.id)).toEqual([a.id]);
    expect(drawingsFor(useDrawingStore.getState(), 'MSFT').map((d) => d.id)).toEqual([a.id]);
    undo();
    expect(useDrawingStore.getState().bySymbol.AAPL!.map((d) => d.id)).toEqual([a.id]);
    undo();
    expect(findDrawing(a.id)!.locked).toBe(false);
  });

  it('removes drawings and indicators together as one step', () => {
    seed(drw(), drw({ symbol: 'MSFT' }));
    const inst = { id: 'i1', type: 'sma' } as never;
    useIndicatorStore.setState({ instances: [inst] });
    removeAllObjects();
    expect(currentDrawings()).toHaveLength(0);
    expect(useDrawingStore.getState().bySymbol.MSFT).toHaveLength(1);
    expect(useIndicatorStore.getState().instances).toHaveLength(0);
    expect(past()).toHaveLength(1);
    undo();
    expect(currentDrawings()).toHaveLength(1);
    expect(useIndicatorStore.getState().instances).toEqual([inst]);
  });

  it('folds entries pushed since a mark into one', () => {
    const log: string[] = [];
    const h = useHistory.getState();
    h.push({ label: 'before', undo: () => {}, redo: () => {} });
    const mark = historyMark();
    h.push({ label: 'a', undo: () => log.push('undo a'), redo: () => log.push('redo a') });
    commit('b', [{ before: null, after: drw() }]);
    foldHistorySince(mark, 'Remove pane');
    expect(past().map((e) => e.label)).toEqual(['before', 'Remove pane']);
    undo();
    expect(log).toEqual(['undo a']);
    expect(currentDrawings()).toHaveLength(0);
  });
});

describe('history marks, pane removal, text editor steps', () => {
  const noop = (label: string) => ({ label, undo: () => {}, redo: () => {} });

  it('folds by entry identity even after the 200-entry cap trims the front', () => {
    const h = useHistory.getState();
    for (let i = 0; i < 200; i++) h.push(noop(`e${i}`));
    const mark = historyMark();
    h.push(noop('studies'));
    commit('drawings', [{ before: null, after: drw() }]);
    expect(past()).toHaveLength(200);
    foldHistorySince(mark, 'Remove pane');
    expect(past()).toHaveLength(199);
    expect(past().at(-2)).toBe(mark);
    expect(past().at(-1)!.label).toBe('Remove pane');
    undo();
    expect(currentDrawings()).toHaveLength(0);
    // A mark that is no longer in the history folds nothing.
    h.push(noop('x'));
    h.push(noop('y'));
    foldHistorySince(noop('gone'), 'Remove pane');
    expect(past().at(-1)!.label).toBe('y');
  });

  it('ignores entries pushed while an undo/redo runs and keeps the redo stack', () => {
    const h = useHistory.getState();
    h.push({
      label: 'a',
      undo: () => h.push(noop('side effect')),
      redo: () => h.push(noop('side effect')),
    });
    undo();
    expect(past()).toHaveLength(0);
    expect(useHistory.getState().future.map((e) => e.label)).toEqual(['a']);
    redo();
    expect(past().map((e) => e.label)).toEqual(['a']);
    expect(useHistory.getState().applying).toBe(false);
  });

  it("removes a pane's drawings of every symbol and restores them on undo", () => {
    const a = drw({ paneId: 'p2' });
    const m = drw({ paneId: 'p2', symbol: 'MSFT' });
    const s = drw({ paneId: 'p2', scope: 'all' });
    const keep = drw();
    seed(a, m, s, keep);
    removePaneDrawings('p2');
    const st = useDrawingStore.getState();
    expect(st.bySymbol.MSFT).toBeUndefined();
    expect(st.synced).toEqual([]);
    expect(st.bySymbol.AAPL!.map((d) => d.id)).toEqual([keep.id]);
    expect(past()).toHaveLength(1);
    undo();
    expect([a, m, s, keep].every((d) => findDrawing(d.id))).toBe(true);
    expect(useDrawingStore.getState().bySymbol.MSFT!.map((d) => d.id)).toEqual([m.id]);
  });

  it('a new text drawing left empty disappears with its Create step', async () => {
    const t = drw({ type: 'text', text: '' });
    recordGesture('Create Text', [{ before: null, after: t }]);
    await Promise.resolve();
    finishTextEdit(t.id, true, '   ');
    expect(findDrawing(t.id)).toBeUndefined();
    expect(past()).toEqual([]);
    // Esc (cancel) on a new empty drawing does the same.
    const u = drw({ type: 'text', text: '' });
    recordGesture('Create Text', [{ before: null, after: u }]);
    finishTextEdit(u.id, true, null);
    expect(findDrawing(u.id)).toBeUndefined();
    expect(past()).toEqual([]);
  });

  it('typed text folds into the Create step; later edits are their own step', async () => {
    const t = drw({ type: 'text', text: '' });
    recordGesture('Create Text', [{ before: null, after: t }]);
    await Promise.resolve();
    finishTextEdit(t.id, true, 'hello');
    expect(past().map((e) => e.label)).toEqual(['Create Text']);
    expect(findDrawing(t.id)!.text).toBe('hello');
    undo();
    expect(findDrawing(t.id)).toBeUndefined();
    redo();
    expect(findDrawing(t.id)!.text).toBe('hello');
    finishTextEdit(t.id, false, 'bye');
    expect(past().map((e) => e.label)).toEqual(['Create Text', 'Edit text']);
    // Not the newest step any more: amending falls back to a separate step.
    expect(amendCreated(t.id, null)).toBe(false);
  });
});

describe('copy/paste, scope, symbol', () => {
  it('repeated pastes land one more bar to the right each time', () => {
    const a = drw();
    seed(a);
    const paste = vi.fn(() => [] as Drawing[]);
    const chart = {
      copyDrawings: () => '{"version":1,"drawings":[]}',
      pasteDrawings: paste,
      getState: () => ({ panes: [{ id: 'main' }] }),
    };
    useChartStore.setState({ chart: chart as unknown as Chart });
    copyDrawings([a.id]);
    pasteDrawings();
    pasteDrawings();
    pasteDrawings();
    copyDrawings([a.id]);
    pasteDrawings();
    expect(paste.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      { offset: 1 },
      { offset: 2 },
      { offset: 3 },
      { offset: 1 },
    ]);
    useChartStore.setState({ chart: null });
  });

  it('per-symbol scope without a symbol takes the current symbol', () => {
    expect(scopePatch(drw({ symbol: '', scope: 'all' }), 'symbol')).toEqual({
      scope: 'symbol',
      symbol: 'AAPL',
    });
    expect(scopePatch(drw({ symbol: 'MSFT' }), 'all')).toEqual({ scope: 'all', symbol: 'MSFT' });
  });

  it('normalizes the app symbol like the engine (bucket keys match)', () => {
    useAppStore.getState().setSymbol(' msft ');
    expect(useAppStore.getState().symbol).toBe('MSFT');
    expect(useAppStore.getState().recentSymbols[0]).toBe('MSFT');
  });

  it('Mod+C/V/A only target drawings when focus is on the chart and no text is selected', () => {
    const root = { contains: (el: unknown) => el === inChart };
    const inChart = { id: 'canvas' };
    const body = { id: 'body' };
    const input = { id: 'input' };
    let active: unknown = body;
    let selected = '';
    let modal = false;
    vi.stubGlobal('document', {
      get activeElement() {
        return active;
      },
      body,
      querySelector: () => (modal ? {} : null),
    });
    vi.stubGlobal('window', { getSelection: () => ({ toString: () => selected }) });
    useChartStore.setState({ chart: { root } as unknown as Chart });
    try {
      expect(chartClipboardTarget()).toBe(true);
      active = inChart;
      expect(chartClipboardTarget()).toBe(true);
      active = input; // sidebar / dialog field
      expect(chartClipboardTarget()).toBe(false);
      active = body;
      selected = 'some text';
      expect(chartClipboardTarget()).toBe(false);
      selected = '';
      modal = true;
      expect(chartClipboardTarget()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      useChartStore.setState({ chart: null });
    }
  });
});

describe('persistence safety', () => {
  it('backs up unreadable data before anything can overwrite it', () => {
    for (const raw of ['{nope', JSON.stringify({ version: 2, bySymbol: { X: [drw()] } })]) {
      const st = memStorage({ [STORAGE_KEY]: raw });
      const r = loadDrawings(st, 42);
      expect(r.data).toEqual({ bySymbol: {}, synced: [] });
      expect(r.writable).toBe(true);
      expect(r.warning).toContain(backupKey(42));
      expect(st.data.get(backupKey(42))).toBe(raw);
      expect(st.data.get(STORAGE_KEY)).toBe(raw);
    }
  });

  it('backs up data with invalid entries and keeps the valid ones', () => {
    const a = drw();
    const raw = JSON.stringify({ version: 1, bySymbol: { AAPL: [a, { id: 3 }] }, synced: [] });
    const st = memStorage({ [STORAGE_KEY]: raw });
    const r = loadDrawings(st, 7);
    expect(r.data.bySymbol.AAPL).toEqual([a]);
    expect(r.warning).toContain('1 invalid entry');
    expect(st.data.get(backupKey(7))).toBe(raw);
    // Clean data: no backup, no warning.
    const ok = memStorage({ [STORAGE_KEY]: serializeDrawings({ bySymbol: {}, synced: [a] }) });
    expect(loadDrawings(ok, 7)).toMatchObject({ warning: null, writable: true });
    expect(ok.setItem).not.toHaveBeenCalled();
  });

  it('never saves over unread data it could not back up; warns once', () => {
    vi.useFakeTimers();
    const st = {
      getItem: () => '{nope',
      setItem: vi.fn(() => {
        throw new Error('quota');
      }),
    };
    const r = loadDrawings(st, 1);
    expect(r.writable).toBe(false);
    setLoadState(r);
    const onError = vi.fn();
    const p = startDrawingPersistence(st, 10, onError);
    useDrawingStore.getState().apply([drw()]);
    vi.advanceTimersByTime(10);
    expect(st.setItem).toHaveBeenCalledTimes(1); // only the failed backup attempt
    expect(onError).toHaveBeenCalledTimes(1);
    p.stop();
    startDrawingPersistence(st, 10, onError).stop();
    expect(onError).toHaveBeenCalledTimes(1); // reported once
    vi.useRealTimers();
  });

  it("merges another tab's save with this tab's unsaved edits", () => {
    vi.useFakeTimers();
    const a = drw();
    const gone = drw();
    seed(a, gone);
    const listeners: ((e: Event) => void)[] = [];
    const events = {
      addEventListener: (_t: string, fn: (e: Event) => void) => void listeners.push(fn),
      removeEventListener: () => {},
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
    const st = memStorage();
    const p = startDrawingPersistence(st, 10, () => {}, events);
    const fire = (key: string | null, newValue: string | null) =>
      listeners.forEach((fn) => fn({ key, newValue } as unknown as Event));

    // No local edits: adopt the other tab's data without writing it back.
    const b = drw();
    fire(STORAGE_KEY, serializeDrawings({ bySymbol: { AAPL: [a, gone, b] }, synced: [] }));
    expect(currentDrawings().map((d) => d.id)).toEqual([a.id, gone.id, b.id]);
    vi.advanceTimersByTime(10);
    expect(st.setItem).not.toHaveBeenCalled();

    // Local unsaved edits (lock a, remove gone) survive the other tab's save (adds c).
    updateDrawings([a.id], { locked: true }, 'Lock');
    removeDrawings([gone.id]);
    const c = drw({ scope: 'all' });
    fire(STORAGE_KEY, serializeDrawings({ bySymbol: { AAPL: [a, gone, b] }, synced: [c] }));
    expect(currentDrawings().map((d) => d.id)).toEqual([a.id, b.id, c.id]);
    expect(findDrawing(a.id)!.locked).toBe(true);
    vi.advanceTimersByTime(10);
    expect(parseDrawings(st.setItem.mock.calls.at(-1)![1]).synced.map((d) => d.id)).toEqual([c.id]);

    // Unreadable data from the other tab is not adopted.
    fire(STORAGE_KEY, '{nope');
    expect(currentDrawings()).toHaveLength(3);
    fire('other-key', null);
    expect(currentDrawings()).toHaveLength(3);
    p.stop();
    vi.useRealTimers();
  });

  it('mergeBuckets re-applies only local changes', () => {
    const a = drw();
    const base = { bySymbol: { AAPL: [a] }, synced: [] };
    const incoming = { bySymbol: {}, synced: [] };
    expect(mergeBuckets(base, base, incoming)).toBe(incoming);
  });
});

describe('attach (engine events and sync)', () => {
  type Handler = (e: unknown) => void;
  function fakeChart() {
    const handlers = new Map<string, Handler[]>();
    let list: Drawing[] = [];
    let beforeSet: (() => void) | null = null;
    let active: string | null = null;
    const toolCalls: { type: string | null; opts: unknown }[] = [];
    const chart = {
      on: (ev: string, fn: Handler) => {
        handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
        return () =>
          handlers.set(
            ev,
            (handlers.get(ev) ?? []).filter((f) => f !== fn),
          );
      },
      getActiveTool: () => active,
      setActiveTool: (type: string | null, opts?: unknown) => {
        active = type;
        toolCalls.push({ type, opts });
      },
      getDrawingOptions: () => ({ stayInDrawingMode: false, lockAll: false, hideAll: false }),
      setDrawingOptions: () => {},
      getSelection: () => [],
      getDrawing: (id: string) => structuredClone(list.find((d) => d.id === id) ?? null),
      addDrawing: (d: Drawing) => void list.push(structuredClone(d)),
      replaceDrawing: (d: Drawing) =>
        void (list = list.map((x) => (x.id === d.id ? structuredClone(d) : x))),
      removeDrawings: (ids: readonly string[]) =>
        void (list = list.filter((d) => !ids.includes(d.id))),
      setDrawings: (l: readonly Drawing[]) => {
        // Like the engine: abort() reports a pending eraser gesture first.
        const hook = beforeSet;
        beforeSet = null;
        hook?.();
        list = l.map((d) => structuredClone(d));
      },
    };
    const emit = (ev: string, payload: unknown) =>
      (handlers.get(ev) ?? []).forEach((fn) => fn(payload));
    return {
      chart: chart as unknown as Chart,
      emit,
      ids: () => list.map((d) => d.id),
      toolCalls,
      onNextSet: (fn: () => void) => (beforeSet = fn),
    };
  }

  function attach() {
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
    const f = fakeChart();
    const detach = attachDrawings(f.chart, {} as HTMLElement);
    return {
      ...f,
      detach: () => {
        detach();
        vi.unstubAllGlobals();
      },
    };
  }

  it('re-entrant store changes during setDrawings do not resurrect erased drawings', () => {
    const synced = drw({ scope: 'all' });
    const own = drw();
    seed(own, synced);
    const f = attach();
    expect(f.ids().sort()).toEqual([own.id, synced.id].sort());
    // The eraser removed `synced` mid-gesture; switching symbol aborts it,
    // which reports the removal from inside setDrawings.
    f.onNextSet(() => f.emit('drawingsRemoved', { drawings: [synced] }));
    useAppStore.setState({ symbol: 'MSFT' });
    expect(findDrawing(synced.id)).toBeUndefined();
    expect(f.ids()).toEqual([]);
    f.detach();
  });

  it('maps emoji/sticker/icon toolbar ids to the engine icon tool with a preset glyph', () => {
    const f = attach();
    f.toolCalls.length = 0;
    useUiStore.setState({ activeTool: 'sticker-bull' });
    expect(f.toolCalls).toEqual([{ type: 'icon', opts: { style: { glyph: '\u{1F402}' } } }]);
    // Another sticker re-arms the same engine type with its own glyph.
    useUiStore.setState({ activeTool: 'emoji-fire' });
    expect(f.toolCalls.at(-1)).toEqual({ type: 'icon', opts: { style: { glyph: '\u{1F525}' } } });
    useUiStore.setState({ activeTool: 'icon-star' });
    expect(f.toolCalls.at(-1)).toEqual({ type: 'icon', opts: { style: { glyph: '\u2605' } } });
    expect(f.toolCalls).toHaveLength(3);
    useUiStore.setState({ activeTool: 'trend-line' });
    expect(f.toolCalls.at(-1)).toEqual({ type: 'trend-line', opts: undefined });
    f.detach();
  });

  it('engineTool and isToolAvailable cover stickers', () => {
    expect(engineTool('emoji-rocket')).toEqual({ type: 'icon', style: { glyph: '\u{1F680}' } });
    expect(engineTool('trend-line')).toEqual({ type: 'trend-line' });
    expect(engineTool('cross')).toBeNull();
    for (const id of ['emoji-smile', 'sticker-whale', 'icon-bolt'])
      expect(isToolAvailable(id)).toBe(true);
  });

  it('maps the measure, zoom-in and Anchored VWAP entries to engine modes', () => {
    expect(engineTool('measure')).toEqual({ type: 'measure' });
    expect(engineTool('zoom-in')).toEqual({ type: 'zoom-in' });
    expect(engineTool('anchored-vwap')).toEqual({ type: 'pick-point' });
    expect(engineTool('replay-pick')).toMatchObject({ type: 'pick-point', cutPreview: true });
    expect(engineTool('replay-pick')?.cursor).toMatch(
      /^url\("data:image\/svg\+xml,.*\) 12 12, crosshair$/,
    );
    for (const id of ['measure', 'zoom-in', 'anchored-vwap'])
      expect(isToolAvailable(id)).toBe(true);
    const f = attach();
    useUiStore.setState({ activeTool: 'zoom-in' });
    expect(f.toolCalls.at(-1)).toEqual({ type: 'zoom-in', opts: undefined });
    f.detach();
  });

  it('Anchored VWAP: a picked point adds the indicator anchored at that bar time', () => {
    const f = attach();
    useUiStore.setState({ activeTool: 'anchored-vwap' });
    f.emit('pointPicked', { time: 1_700_000_000, price: 10, paneId: 'main' });
    const added = useIndicatorStore.getState().instances;
    expect(added).toHaveLength(1);
    expect(added[0]!.type).toBe('anchored-vwap');
    expect(added[0]!.inputs.anchor).toBe(1_700_000_000);
    // A pick while another tool is active (stale event) adds nothing.
    useUiStore.setState({ activeTool: 'cross' });
    f.emit('pointPicked', { time: 1_700_086_400, price: 10, paneId: 'main' });
    expect(useIndicatorStore.getState().instances).toHaveLength(1);
    f.detach();
  });

  it('saved default styles keep the placed icon glyph and the ghost feed seed', () => {
    expect(keepPerDrawingStyle('icon', { glyph: 'A', size: 9 }, { glyph: 'B' })).toEqual({
      glyph: 'B',
      size: 9,
    });
    expect(keepPerDrawingStyle('ghost-feed', { seed: 7, up: 'x' }, { seed: 42 })).toEqual({
      up: 'x',
      seed: 42,
    });
    // The saved seed never leaks into a drawing that has none of its own.
    expect(keepPerDrawingStyle('ghost-feed', { seed: 7, up: 'x' }, { up: 'y' })).toEqual({
      up: 'x',
    });
    expect(keepPerDrawingStyle('trend-line', { lineWidth: 3 }, { lineWidth: 1 })).toEqual({
      lineWidth: 3,
    });
  });

  it('labels Alt+drag clones "Clone", not "Create"', async () => {
    const f = attach();
    const c = drw();
    f.emit('drawingDrag', { ids: [c.id], phase: 'start' });
    f.emit('drawingDrag', { ids: [c.id], phase: 'end' });
    f.emit('drawingCreated', { drawing: c });
    await Promise.resolve();
    expect(past().map((e) => e.label)).toEqual(['Clone Trend line']);
    const d = drw();
    f.emit('drawingCreated', { drawing: d });
    await Promise.resolve();
    expect(past().at(-1)!.label).toBe('Create Trend line');
    f.detach();
  });

  it('"sync new drawings" makes tool-created drawings synced, not clones', async () => {
    useUiStore.setState({ syncNewDrawings: true });
    const f = attach();
    const d = drw();
    // Persistence follows the store: it must only ever see the final scope.
    const seen: string[] = [];
    const off = useDrawingStore.subscribe((st) => {
      const x = [...st.synced, ...Object.values(st.bySymbol).flat()].find((y) => y.id === d.id);
      if (x) seen.push(x.scope);
    });
    f.chart.addDrawing(d);
    f.emit('drawingCreated', { drawing: d });
    off();
    await Promise.resolve();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['all']));
    expect(findDrawing(d.id)!.scope).toBe('all');
    // The engine copy follows through the store -> engine sync.
    expect(f.chart.getDrawing(d.id)!.scope).toBe('all');
    const c = drw();
    f.emit('drawingDrag', { ids: [c.id], phase: 'start' });
    f.emit('drawingDrag', { ids: [c.id], phase: 'end' });
    f.emit('drawingCreated', { drawing: c });
    await Promise.resolve();
    expect(findDrawing(c.id)!.scope).toBe('symbol');
    // Undo removes the synced drawing in one step.
    undo();
    expect(findDrawing(c.id)).toBeUndefined();
    useUiStore.setState({ syncNewDrawings: false });
    f.detach();
  });

  it('folds pane removal across symbols into one step; skips it during undo/redo', async () => {
    const a = drw({ paneId: 'p2' });
    const m = drw({ paneId: 'p2', symbol: 'MSFT' });
    seed(a, m);
    const f = attach();
    f.emit('paneRemoved', { paneId: 'p2' });
    // The indicator controller pushes the studies' step in the same dispatch.
    useHistory.getState().push({ label: 'Remove RSI', undo: () => {}, redo: () => {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(past().map((e) => e.label)).toEqual(['Remove pane']);
    expect(findDrawing(m.id)).toBeUndefined();
    undo();
    expect(findDrawing(a.id) && findDrawing(m.id)).toBeTruthy();

    // A pane removed by an undo: no new entries, redo stack kept.
    useHistory.getState().clear();
    useHistory.getState().push({
      label: 'Add RSI',
      undo: () => f.emit('paneRemoved', { paneId: 'p2' }),
      redo: () => {},
    });
    undo();
    await Promise.resolve();
    await Promise.resolve();
    expect(past()).toEqual([]);
    expect(useHistory.getState().future.map((e) => e.label)).toEqual(['Add RSI']);
    expect(findDrawing(a.id)).toBeDefined();
    f.detach();
  });

  it('disables undo/redo while a drawing is dragged or text is edited', async () => {
    const { commands } = await import('../commands/registry');
    const { registerCoreCommands } = await import('../commands/core');
    const off = registerCoreCommands();
    useHistory.getState().push({ label: 'x', undo: () => {}, redo: () => {} });
    expect(commands.isEnabled('edit.undo')).toBe(true);
    useDrawingRuntime.setState({ dragging: true });
    expect(commands.isEnabled('edit.undo')).toBe(false);
    useDrawingRuntime.setState({
      dragging: false,
      textEdit: { id: 'x', x: 0, y: 0, created: true },
    });
    expect(commands.isEnabled('edit.undo')).toBe(false);
    useDrawingRuntime.setState({ textEdit: null });
    expect(commands.isEnabled('edit.undo')).toBe(true);
    off();
  });
});

describe('z-order', () => {
  it('computes front/back/forward/backward stacks', () => {
    const s = ['a', 'b', 'c', 'd'];
    expect(zOrderStack(s, new Set(['b']), 'front')).toEqual(['a', 'c', 'd', 'b']);
    expect(zOrderStack(s, new Set(['c']), 'back')).toEqual(['c', 'a', 'b', 'd']);
    expect(zOrderStack(s, new Set(['a', 'b']), 'forward')).toEqual(['c', 'a', 'b', 'd']);
    expect(zOrderStack(s, new Set(['d']), 'backward')).toEqual(['a', 'b', 'd', 'c']);
    expect(zOrderStack(s, new Set(['d']), 'forward')).toEqual(s);
  });

  it('renumbers a pane (object tree drag, no chart) as one undo step', () => {
    const a = drw({ zIndex: 1 });
    const b = drw({ zIndex: 2 });
    const other = drw({ zIndex: 3, paneId: 'p2' });
    seed(a, b, other);
    zOrder([a.id], 'front');
    expect(findDrawing(a.id)!.zIndex).toBeGreaterThan(findDrawing(b.id)!.zIndex);
    expect(findDrawing(other.id)!.zIndex).toBe(3);
    reorderPane('main', [a.id, b.id], 'Reorder');
    expect(findDrawing(a.id)!.zIndex).toBeLessThan(findDrawing(b.id)!.zIndex);
    undo();
    undo();
    expect([findDrawing(a.id)!.zIndex, findDrawing(b.id)!.zIndex]).toEqual([1, 2]);
  });
});

describe('visibility presets', () => {
  it('builds reference interval presets', () => {
    expect(visibilityPreset('1D', 'all')).toBeNull();
    const only = visibilityPreset('4h', 'only')!;
    expect(only.hours).toEqual({ enabled: true, min: 4, max: 4 });
    expect(only.minutes.enabled).toBe(false);
    expect(only.days.enabled).toBe(false);
    const above = visibilityPreset('60m', 'above')!;
    expect(above.hours).toEqual({ enabled: true, min: 1, max: 24 });
    expect(above.minutes.enabled).toBe(false);
    expect(above.weeks.enabled).toBe(true);
    const below = visibilityPreset('1W', 'below')!;
    expect(below.weeks).toEqual({ enabled: true, min: 1, max: 1 });
    expect(below.days.enabled).toBe(true);
    expect(below.months.enabled).toBe(false);
    expect(currentPreset(below, '1W')).toBe('below');
    expect(currentPreset(null, '1W')).toBe('all');
  });
});

describe('engine reconcile', () => {
  function sink(initial: Drawing[]) {
    let list = initial.map((d) => structuredClone(d));
    const calls: string[] = [];
    const s: DrawingSink = {
      getDrawing: (id) => {
        calls.push(`get ${id}`);
        const d = list.find((x) => x.id === id);
        return d ? structuredClone(d) : null;
      },
      addDrawing: (d) => {
        calls.push(`add ${d.id}`);
        list.push(structuredClone(d as Drawing));
        return d as Drawing;
      },
      replaceDrawing: (d) => {
        calls.push(`replace ${d.id}`);
        list = list.map((x) => (x.id === d.id ? structuredClone(d) : x));
      },
      removeDrawings: (ids) => {
        calls.push(`remove ${ids.join(',')}`);
        list = list.filter((d) => !ids.includes(d.id));
      },
      setDrawings: (l) => {
        calls.push('set');
        list = l.map((d) => structuredClone(d));
      },
    };
    return { s, calls, list: () => list };
  }
  const syncedOf = (list: Drawing[]): SyncedDrawings => new Map(list.map((d) => [d.id, d]));

  it('applies the minimal diff and skips unchanged store objects', () => {
    const a = drw();
    const b = drw();
    const c = drw();
    const k = sink([a, b]);
    const synced = syncedOf([a, b]);
    const a2 = { ...a, locked: true };
    reconcileDrawings(k.s, [a2, c], synced);
    expect(k.calls).toEqual([
      `get ${c.id}`,
      `remove ${b.id}`,
      `get ${a.id}`,
      `replace ${a.id}`,
      `get ${c.id}`,
      `add ${c.id}`,
    ]);
    k.calls.length = 0;
    // Same store objects again: nothing is read back or written.
    reconcileDrawings(k.s, [a2, c], synced);
    expect(k.calls).toEqual([]);
    // An equal copy is read back once, not rewritten.
    reconcileDrawings(k.s, [structuredClone(a2), c], synced);
    expect(k.calls).toEqual([`get ${a.id}`]);
  });

  it('replaces wholesale, so a removed style key leaves the engine (no endless updates)', () => {
    const a = drw({ style: { lineColor: '#fff', lineWidth: 2, extra: 1 } });
    const k = sink([a]);
    const synced = syncedOf([a]);
    const { extra: _x, ...style } = a.style;
    const a2 = { ...a, style };
    reconcileDrawings(k.s, [a2], synced);
    expect(k.list()[0]!.style).toEqual(style);
    k.calls.length = 0;
    reconcileDrawings(k.s, [{ ...a2 }], synced);
    expect(k.calls).toEqual([`get ${a.id}`]); // equal now: no replace
  });

  it('falls back to setDrawings for unknown tool types', () => {
    const k = sink([]);
    reconcileDrawings(k.s, [drw({ type: 'not-a-tool' })], new Map());
    expect(k.calls.at(-1)).toBe('set');
  });

  it('compares drawings structurally', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});
