import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHistoryStore, useHistory } from '../commands/history';
import { addIndicator } from '../indicators/actions';
import { createCompareStore, useCompareStore } from '../compare/store';
import {
  createIndicatorPreviewStore,
  createIndicatorRuntimeStore,
  createIndicatorStore,
  useIndicatorStore,
} from '../indicators/store';
import { createCompareRuntimeStore } from '../compare/store';
import { createChartViewStore, useChartView } from '../store/chartView';
import { registerSession, setActiveChart, unregisterSession, useChartStore } from '../store/chart';
import type { ChartSession } from './session';
import { createStore } from 'zustand/vanilla';

/** A session without an engine chart (these tests only exercise the per-chart stores). */
function fakeSession(id: string): ChartSession {
  return {
    id,
    chart: null as never,
    view: createChartViewStore(),
    indicators: createIndicatorStore(),
    preview: createIndicatorPreviewStore(),
    indicatorRuntime: createIndicatorRuntimeStore(),
    compares: createCompareStore(),
    compareRuntime: createCompareRuntimeStore(),
    history: createHistoryStore(),
    info: createStore(() => ({ symbolInfo: null, crosshair: null, loading: false })),
    destroy: () => {},
  };
}

const ids = (s: ChartSession) => s.indicators.getState().instances.map((i) => i.id);
const item = (id: string) => ({
  id,
  symbol: 'MSFT',
  placement: 'own' as const,
  visible: true,
  color: '#ff0000',
  lineWidth: 1,
});

let a: ChartSession;
let b: ChartSession;

beforeEach(() => {
  for (const id of [...useChartStore.getState().sessions.keys()]) unregisterSession(id);
  a = fakeSession('a');
  b = fakeSession('b');
  a.indicators.setState({ instances: [] });
  b.indicators.setState({ instances: [] });
  registerSession(a);
  registerSession(b);
});

describe('chart sessions', () => {
  it('the first registered session is active', () => {
    expect(useChartStore.getState().activeId).toBe('a');
  });

  it('indicator, compare and undo on the active chart leave the other untouched', () => {
    const id = addIndicator('sma')!;
    expect(ids(a)).toEqual([id]);
    expect(ids(b)).toEqual([]);

    useCompareStore.getState().add(item('cmp-1'));
    expect(a.compares.getState().items).toHaveLength(1);
    expect(b.compares.getState().items).toHaveLength(0);

    expect(a.history.getState().past).toHaveLength(1);
    expect(b.history.getState().past).toHaveLength(0);

    // Undo on the second chart has nothing to undo; the first chart keeps its indicator.
    setActiveChart('b');
    useHistory.getState().undo();
    expect(ids(a)).toEqual([id]);

    setActiveChart('a');
    useHistory.getState().undo();
    expect(ids(a)).toEqual([]);
    expect(ids(b)).toEqual([]);
    expect(b.compares.getState().items).toHaveLength(0);
  });

  it('view settings are per chart', () => {
    useChartView.getState().setSymbol(' msft ');
    expect(a.view.getState().symbol).toBe('MSFT');
    expect(b.view.getState().symbol).toBe('AAPL');
    setActiveChart('b');
    expect(useChartView.getState().symbol).toBe('AAPL');
  });

  it('a facade rebinds on active change and notifies once', () => {
    const listener = vi.fn();
    const off = useIndicatorStore.subscribe(listener);

    addIndicator('sma');
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();
    setActiveChart('b');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toBe(b.indicators.getState());
    expect(listener.mock.calls[0]![1]).toBe(a.indicators.getState());

    // Changes on the old chart are no longer seen, changes on the new one are.
    listener.mockClear();
    a.indicators.getState().replaceAll([]);
    expect(listener).not.toHaveBeenCalled();
    b.indicators.getState().replaceAll([]);
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    listener.mockClear();
    setActiveChart('a');
    expect(listener).not.toHaveBeenCalled();
  });

  it('the chart store mirrors the active session', () => {
    a.info.setState({ loading: true });
    expect(useChartStore.getState().loading).toBe(true);
    b.info.setState({ loading: false });
    expect(useChartStore.getState().loading).toBe(true);
    setActiveChart('b');
    expect(useChartStore.getState().loading).toBe(false);
  });

  it('removing the active session activates another', () => {
    unregisterSession('a');
    expect(useChartStore.getState().activeId).toBe('b');
    expect(useChartStore.getState().sessions.size).toBe(1);
  });
});
