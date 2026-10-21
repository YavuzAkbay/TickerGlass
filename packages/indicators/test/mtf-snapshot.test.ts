// Dependents of a timeframe instance re-run only the chart bars of the forming
// timeframe bar (from a checkpoint) and must equal a full computation.
import { describe, expect, it } from 'vitest';
import { defineIndicator, IndicatorRegistry, listIndicators } from '../src/registry';
import { externalSymbols } from '../src/resolve';
import { IndicatorRuntime, type InstanceSpec } from '../src/runtime';
import { randomBars } from '../src/test-utils';
import type { BarArrays, InputValueMap } from '../src/types';
import '../src/builtins';
import { FIXTURES } from './fixtures';
import { barAt, dailyBars, feedLive, sliceBars, snapshot, toColumns } from './helpers';

/** Daily SMA of closes, aligned to the final value of the containing day. */
const HTF = defineIndicator({
  id: 'test-htf',
  name: 'HTF',
  shortName: 'HTF',
  category: 'other',
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 3 },
    tf: { kind: 'timeframe', label: 'Timeframe', default: '' },
  },
  outputs: [{ type: 'plot', id: 'ma', title: 'MA', kind: 'step', color: '#fff' }],
  setup({ inputs, ta }) {
    const ma = ta.sma(inputs.length);
    return (c) => c.set('ma', ma.update(c.close[c.i]!));
  },
});

let setups = 0;
/** Counts full computations (`setup` runs once per full pass). */
const COUNTED = defineIndicator({
  id: 'test-counted',
  name: 'Counted',
  shortName: 'Counted',
  category: 'other',
  overlay: true,
  inputs: { source: { kind: 'source', label: 'Source', default: 'close' } },
  outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
  setup({ ta }) {
    setups++;
    const ema = ta.ema(5);
    const hi = ta.highest(7);
    return (c) => c.set('v', ema.update(c.src.source![c.i]!) + hi.update(c.high[c.i]!));
  },
});

function registry(): IndicatorRegistry {
  const r = new IndicatorRegistry();
  for (const def of listIndicators()) r.register(def);
  r.register(HTF);
  r.register(COUNTED);
  return r;
}

/** Hourly bars over about 25 days: many chart bars per forming daily bar. */
const bars = randomBars(600, 11, 1_700_000_000, 3600);
const LIVE_FROM = 420;
const HTF_REF = { instanceId: 'h', outputId: 'ma' };

/** All live: chart and daily bars tick by tick. */
function live(specs: InstanceSpec[], cols: BarArrays = bars): IndicatorRuntime {
  const rt = new IndicatorRuntime({ registry: registry() });
  rt.add({ id: 'h', type: 'test-htf', inputs: { tf: '1D' } });
  for (const s of specs) rt.add(s);
  feedLive(rt, cols, LIVE_FROM, '1D');
  return rt;
}

/** Everything computed in one pass over the final data. */
function full(specs: InstanceSpec[], cols: BarArrays = bars): IndicatorRuntime {
  const rt = new IndicatorRuntime({ registry: registry() });
  rt.setBars(cols);
  rt.setTimeframeBars('1D', toColumns(dailyBars(cols)));
  rt.add({ id: 'h', type: 'test-htf', inputs: { tf: '1D' } });
  for (const s of specs) rt.add(s);
  return rt;
}

function expectSame(a: IndicatorRuntime, b: IndicatorRuntime): void {
  for (const id of b.ids()) {
    expect(a.status(id), id).toEqual(b.status(id));
    expect(snapshot(a.result(id)!), id).toEqual(snapshot(b.result(id)!));
  }
}

describe('timeframe dependents re-run from the forming bar', () => {
  it('re-runs only from the first chart bar of the forming day', () => {
    const specs = [{ id: 'd', type: 'test-counted', inputs: { source: HTF_REF } }];
    const rt = new IndicatorRuntime({ registry: registry() });
    rt.add({ id: 'h', type: 'test-htf', inputs: { tf: '1D' } });
    rt.add(specs[0]!);
    const n = 500;
    rt.setBars(sliceBars(bars, 0, n));
    const days = dailyBars(bars, n);
    rt.setTimeframeBars('1D', toColumns(days));
    let before = setups;
    const last = days[days.length - 1]!;
    // First chart bar of the forming day.
    let start = n - 1;
    while (start > 0 && bars.time[start - 1]! >= last.time) start--;
    expect(start).toBeLessThan(n - 1);
    const changes = rt.updateTimeframeBar('1D', { ...last, close: last.close * 1.1 });
    expect(changes).toEqual([
      { id: 'h', from: start },
      { id: 'd', from: start },
    ]);
    expect(setups).toBe(before);
    const ref = new IndicatorRuntime({ registry: registry() });
    ref.setBars(sliceBars(bars, 0, n));
    ref.setTimeframeBars(
      '1D',
      toColumns([...days.slice(0, -1), { ...last, close: last.close * 1.1 }]),
    );
    ref.add({ id: 'h', type: 'test-htf', inputs: { tf: '1D' } });
    ref.add(specs[0]!);
    expectSame(rt, ref);
    before = setups;
    // Chart ticks and appends keep the checkpoint; the next day moves it.
    for (let i = n; i < 560; i++) {
      rt.updateBar(i, barAt(bars, i));
      const d = dailyBars(bars, i + 1);
      rt.updateTimeframeBar('1D', d[d.length - 1]!);
    }
    expect(setups).toBe(before);
    expectSame(rt, full(specs, sliceBars(bars, 0, 560)));
  });

  it('equals a full computation through a chain of dependents', () => {
    const specs: InstanceSpec[] = [
      { id: 'd', type: 'test-counted', inputs: { source: HTF_REF } },
      { id: 'e', type: 'ema', inputs: { length: 4, source: { instanceId: 'd', outputId: 'v' } } },
      { id: 'r', type: 'rsi', inputs: { source: { instanceId: 'e', outputId: 'ema' } } },
      // Not reading the timeframe: never checkpoints, still exact.
      { id: 's', type: 'sma', inputs: { length: 9 } },
    ];
    expectSame(live(specs), full(specs));
  });

  it('starts over after history changes (setBars) and keeps equal', () => {
    const specs = [{ id: 'd', type: 'test-counted', inputs: { source: HTF_REF } }];
    const rt = live(specs, sliceBars(bars, 0, 500));
    // A history load replaces every bar: the checkpoint must not be reused.
    rt.setBars(bars);
    rt.setTimeframeBars('1D', toColumns(dailyBars(bars)));
    const d = dailyBars(bars);
    rt.updateTimeframeBar('1D', { ...d[d.length - 1]!, close: 1 });
    const ref = new IndicatorRuntime({ registry: registry() });
    ref.setBars(bars);
    ref.setTimeframeBars('1D', toColumns([...d.slice(0, -1), { ...d[d.length - 1]!, close: 1 }]));
    for (const s of [{ id: 'h', type: 'test-htf', inputs: { tf: '1D' } }, ...specs]) ref.add(s);
    expectSame(rt, ref);
  });

  /** Built-ins with a price source input (not repainting, no external symbols). */
  const ids = listIndicators()
    .filter((def) => {
      if (def.repaints) return false;
      const entries = Object.values(def.inputs);
      if (entries.some((d) => d.kind === 'timeframe' || d.kind === 'symbol')) return false;
      return entries.some((d) => d.kind === 'source');
    })
    .map((def) => def.id);

  it.each(ids)('%s on a timeframe output equals a full computation', (id) => {
    const def = listIndicators().find((d) => d.id === id)!;
    const inputs: InputValueMap = { ...FIXTURES[id]?.inputs };
    const key = Object.entries(def.inputs).find(([, d]) => d.kind === 'source')![0];
    inputs[key] = HTF_REF;
    if (externalSymbols(def, inputs).length) return;
    const specs = [{ id: 'x', type: id, inputs }];
    expectSame(live(specs), full(specs));
  });
});
