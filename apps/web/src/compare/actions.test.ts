import type { Chart, ChartState, PriceScaleMode } from '@investopen/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistory } from '../commands/history';
import { useChartStore } from '../store/chart';
import {
  addCompare,
  onMainScaleMode,
  removeCompare,
  removeCompares,
  setComparePlacement,
  toggleCompareVisible,
  updateCompare,
} from './actions';
import { MAX_COMPARES } from './model';
import { useCompareStore } from './store';

const toasts = vi.hoisted(() => [] as string[]);
vi.mock('../ui/Toast', () => ({ toast: (m: string) => toasts.push(m) }));

/** Just the main pane scale of a chart, reporting mode changes like stateChange. */
function fakeChart(mode: PriceScaleMode = 'linear') {
  const ps = { mode, autoScale: true, invert: false };
  let prev: PriceScaleMode = mode;
  const chart = {
    getState: () => ({ panes: [{ id: 'main', priceScale: { ...ps } }] }) as unknown as ChartState,
    setPriceScaleMode: (_pane: string, m: PriceScaleMode) => {
      ps.mode = m;
      ps.autoScale = true;
      // As attachCompares: forward the change.
      const p = prev;
      prev = m;
      if (p !== m) onMainScaleMode(p, m);
    },
    setAutoScale: (_pane: string, on: boolean) => {
      ps.autoScale = on;
    },
  };
  useChartStore.setState({ chart: chart as unknown as Chart });
  return { mode: () => ps.mode, set: (m: PriceScaleMode) => chart.setPriceScaleMode('main', m) };
}

const items = () => useCompareStore.getState().items;
const scaleRestore = () => useCompareStore.getState().scaleRestore;
const history = () => useHistory.getState();

beforeEach(() => {
  toasts.length = 0;
  useCompareStore.setState({ items: [], scaleRestore: null });
  useHistory.getState().clear();
  useChartStore.setState({ chart: null });
});

describe('compare actions', () => {
  it('adds canonical symbols with palette colours, refusing invalid input', () => {
    fakeChart('percent');
    const id = addCompare(' aapl/msft ', 'pane')!;
    expect(items()).toEqual([
      { id, symbol: 'AAPL/MSFT', placement: 'pane', visible: true, color: '#f7a21b', lineWidth: 2 },
    ]);
    expect(addCompare('MSFT', 'own')).not.toBeNull();
    expect(items()[1]!.color).toBe('#e91e63');
    expect(addCompare('AAPL/', 'same')).toBeNull();
    expect(toasts.at(-1)).toMatch(/Expected a symbol/);
    expect(items()).toHaveLength(2);
  });

  it('refuses a duplicate symbol on the same placement and beyond the cap', () => {
    fakeChart();
    expect(addCompare('MSFT', 'same')).not.toBeNull();
    expect(addCompare('msft', 'same')).toBeNull();
    expect(toasts.at(-1)).toBe('MSFT is already compared on the same % scale');
    const own = addCompare('MSFT', 'own')!;
    expect(own).not.toBeNull();
    expect(setComparePlacement(own, 'same')).toBe(false);
    expect(items()).toHaveLength(2);
    for (let i = items().length; i < MAX_COMPARES; i++) addCompare(`S${i}`, 'pane');
    expect(items()).toHaveLength(MAX_COMPARES);
    expect(addCompare('ONE.MORE', 'pane')).toBeNull();
    expect(toasts.at(-1)).toBe(`At most ${MAX_COMPARES} symbols can be compared`);
  });

  it('the first same-scale overlay switches to percent in one undo step', () => {
    const chart = fakeChart('log');
    const id = addCompare('MSFT', 'same')!;
    expect(chart.mode()).toBe('percent');
    expect(scaleRestore()).toBe('log');
    expect(history().past).toHaveLength(1);
    history().undo();
    expect(items()).toEqual([]);
    expect(chart.mode()).toBe('log');
    expect(scaleRestore()).toBeNull();
    history().redo();
    expect(items().map((i) => i.id)).toEqual([id]);
    expect(chart.mode()).toBe('percent');
    expect(scaleRestore()).toBe('log');
    // A second one changes nothing about the scale.
    addCompare('AAPL', 'same');
    expect(scaleRestore()).toBe('log');
  });

  it('new price scale and new pane overlays leave the scale alone', () => {
    const chart = fakeChart('linear');
    addCompare('MSFT', 'own');
    addCompare('AAPL', 'pane');
    expect(chart.mode()).toBe('linear');
    expect(scaleRestore()).toBeNull();
  });

  it('removing the last same-scale overlay restores the scale; undo brings both back', () => {
    const chart = fakeChart('linear');
    const a = addCompare('MSFT', 'same')!;
    const b = addCompare('AAPL', 'same')!;
    removeCompare(a);
    expect(chart.mode()).toBe('percent');
    removeCompare(b);
    expect(chart.mode()).toBe('linear');
    expect(scaleRestore()).toBeNull();
    history().undo();
    expect(items().map((i) => i.id)).toEqual([b]);
    expect(chart.mode()).toBe('percent');
    expect(scaleRestore()).toBe('linear');
  });

  it('moving the last same-scale overlay away restores the scale', () => {
    const chart = fakeChart('linear');
    const id = addCompare('MSFT', 'same')!;
    expect(setComparePlacement(id, 'pane')).toBe(true);
    expect(items()[0]!.placement).toBe('pane');
    expect(chart.mode()).toBe('linear');
    history().undo();
    expect(items()[0]!.placement).toBe('same');
    expect(chart.mode()).toBe('percent');
  });

  it('a manual scale change clears scaleRestore: removal then keeps the chosen scale', () => {
    const chart = fakeChart('linear');
    const id = addCompare('MSFT', 'same')!;
    chart.set('log');
    expect(scaleRestore()).toBeNull();
    chart.set('percent');
    removeCompare(id);
    expect(chart.mode()).toBe('percent');
  });

  it('only restores when the pane is still percent', () => {
    const chart = fakeChart('linear');
    const id = addCompare('MSFT', 'same')!;
    // e.g. a layout that stored the mode while indexed
    useCompareStore.setState({ scaleRestore: 'log' });
    chart.set('indexed');
    useCompareStore.setState({ scaleRestore: 'log' });
    removeCompare(id);
    expect(chart.mode()).toBe('indexed');
    expect(scaleRestore()).toBeNull();
  });

  it('hiding keeps the scale; showing a same overlay on a linear scale switches again', () => {
    const chart = fakeChart('linear');
    const id = addCompare('MSFT', 'same')!;
    toggleCompareVisible(id);
    expect(items()[0]!.visible).toBe(false);
    expect(chart.mode()).toBe('percent');
    chart.set('linear');
    toggleCompareVisible(id);
    expect(chart.mode()).toBe('percent');
    expect(scaleRestore()).toBe('linear');
  });

  it('validates style patches, one undo step each', () => {
    fakeChart('percent');
    const id = addCompare('MSFT', 'pane')!;
    expect(updateCompare(id, { color: '#00ff00', lineWidth: 3 }, 'Style')).toBe(true);
    expect(items()[0]).toMatchObject({ color: '#00ff00', lineWidth: 3 });
    expect(updateCompare(id, { color: 'green' }, 'Style')).toBe(false);
    expect(updateCompare(id, { lineWidth: 0 }, 'Style')).toBe(false);
    expect(updateCompare(id, { lineWidth: 3 }, 'Style')).toBe(false);
    expect(history().past.map((e) => e.label)).toEqual(['Compare MSFT', 'Style']);
    history().undo();
    expect(items()[0]).toMatchObject({ color: '#f7a21b', lineWidth: 2 });
  });

  it('removes several overlays as one step', () => {
    fakeChart('percent');
    const a = addCompare('MSFT', 'pane')!;
    const b = addCompare('AAPL', 'pane')!;
    addCompare('IBM', 'own');
    history().clear();
    removeCompares([a, b, 'cmp-unknown']);
    expect(items().map((i) => i.symbol)).toEqual(['IBM']);
    expect(history().past.map((e) => e.label)).toEqual(['Remove compares']);
    history().undo();
    expect(items().map((i) => i.symbol)).toEqual(['MSFT', 'AAPL', 'IBM']);
    removeCompares([]);
    expect(history().past).toHaveLength(0);
  });

  it('works without a chart (no scale changes)', () => {
    const id = addCompare('MSFT', 'same')!;
    expect(scaleRestore()).toBeNull();
    removeCompare(id);
    expect(items()).toEqual([]);
  });
});
