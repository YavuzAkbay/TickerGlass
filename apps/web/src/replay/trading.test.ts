import type { ChartMarker, ChartPriceLine } from '@investopen/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POSITION_LINE_GROUP,
  ReplayTrading,
  TRADE_MARKER_GROUP,
  selectTotal,
  useTrading,
} from './trading';

function setup() {
  let bar: { time: number; close: number } | null = { time: 1000, close: 100 };
  let ready = true;
  let clock = 990;
  const markers: Record<string, readonly ChartMarker[]> = {};
  const lines: Record<string, readonly ChartPriceLine[]> = {};
  const notify = vi.fn();
  const t = new ReplayTrading({
    symbol: () => 'AAPL',
    lastBar: () => bar,
    clock: () => clock,
    ready: () => ready,
    setMarkers: (g, m) => void (markers[g] = m),
    setPriceLines: (g, l) => void (lines[g] = l),
    notify,
  });
  return {
    t,
    markers,
    lines,
    notify,
    show: (close: number, time: number, tick = time) => {
      bar = { time, close };
      clock = tick;
      t.step();
    },
    setReady: (v: boolean) => (ready = v),
    noBar: () => (bar = null),
  };
}

beforeEach(() => {
  useTrading.setState({ qty: 1 });
});

describe('ReplayTrading', () => {
  it('fills at the close of the last revealed bar with the clock as fill time', () => {
    const { t, markers, lines } = setup();
    t.reset();
    expect(t.order('buy', 2)).toBeNull();
    const [trade] = useTrading.getState().paper.trades;
    expect(trade).toMatchObject({ symbol: 'AAPL', side: 'buy', qty: 2, price: 100, time: 990 });
    expect(markers[TRADE_MARKER_GROUP]).toHaveLength(1);
    expect(markers[TRADE_MARKER_GROUP]![0]).toMatchObject({
      time: 1000,
      shape: 'arrowUp',
      position: 'belowBar',
    });
    expect(lines[POSITION_LINE_GROUP]![0]).toMatchObject({ price: 100, label: 'Long 2 @ 100.00' });
  });

  it('buy, step, sell: realized and total P&L', () => {
    const { t, show } = setup();
    t.reset();
    t.order('buy', 1);
    show(110, 1060);
    expect(selectTotal(useTrading.getState())).toBe(10); // unrealized
    t.order('sell', 1);
    const s = useTrading.getState();
    expect(s.paper.realized).toBe(10);
    expect(s.paper.trades).toHaveLength(2);
    expect(selectTotal(s)).toBe(10);
  });

  it('close flattens and removes the position line; closing when flat is an error', () => {
    const { t, lines } = setup();
    t.reset();
    expect(t.close()).toBe('No open position');
    t.order('sell', 3);
    expect(lines[POSITION_LINE_GROUP]![0]).toMatchObject({ label: 'Short 3 @ 100.00' });
    expect(t.close()).toBeNull();
    expect(useTrading.getState().paper.positions).toEqual({});
    expect(lines[POSITION_LINE_GROUP]).toEqual([]);
  });

  it('rejects orders when not running, without a price or with a bad quantity', () => {
    const { t, setReady, noBar } = setup();
    t.reset();
    expect(t.order('buy', 0)).toBe('Enter a quantity above zero');
    expect(t.order('buy', NaN)).toBe('Enter a quantity above zero');
    setReady(false);
    expect(t.order('buy', 1)).toBe('Replay is not running');
    setReady(true);
    noBar();
    expect(t.order('buy', 1)).toBe('No price to trade at');
    expect(useTrading.getState().paper.trades).toHaveLength(0);
  });

  it('reset clears trades, markers and the line', () => {
    const { t, markers, lines } = setup();
    t.reset();
    t.order('buy', 1);
    t.reset();
    expect(useTrading.getState().paper.trades).toHaveLength(0);
    expect(markers[TRADE_MARKER_GROUP]).toEqual([]);
    expect(lines[POSITION_LINE_GROUP]).toEqual([]);
  });

  it('end summarizes only when there were trades', () => {
    const { t, notify } = setup();
    t.reset();
    t.end();
    expect(notify).not.toHaveBeenCalled();
    t.order('buy', 1);
    t.end();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain('1 trades');
  });

  it('steps only update state when the mark changed and never redraw the chart', () => {
    let draws = 0;
    let bar = { time: 1000, close: 100 };
    const t = new ReplayTrading({
      symbol: () => 'AAPL',
      lastBar: () => bar,
      clock: () => 0,
      ready: () => true,
      setMarkers: () => void draws++,
      setPriceLines: () => void draws++,
      notify: vi.fn(),
    });
    t.reset();
    const afterReset = draws;
    t.prime(); // first draw for this symbol
    const afterPrime = draws;
    const states: unknown[] = [];
    const off = useTrading.subscribe((s) => states.push(s.marks));
    t.step();
    t.step(); // same close: no state change, no draw
    expect(states).toHaveLength(0);
    expect(draws).toBe(afterPrime);
    bar = { time: 1060, close: 101 };
    t.step();
    expect(states).toHaveLength(1);
    expect(draws).toBe(afterPrime);
    off();
    expect(afterPrime).toBeGreaterThan(afterReset);
  });
});
