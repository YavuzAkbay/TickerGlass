import { describe, expect, it } from 'vitest';
import { defineIndicator, IndicatorRegistry } from './registry';
import { IndicatorRuntime } from './runtime';
import { EMA, SMA } from './builtins';
import { barAt, randomBars, slice } from './test-utils';
import type { BarArrays } from './types';

/** Snapshot of every output of every instance, for exact comparison. */
function dump(rt: IndicatorRuntime): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const id of rt.ids()) {
    const r = rt.result(id)!;
    for (const [k, v] of Object.entries(r.values))
      out[`${id}.${k}`] = Array.from(v.subarray(0, r.length));
    for (const [k, c] of Object.entries(r.colors))
      out[`${id}.${k}#`] = Array.from(c.subarray(0, r.length));
  }
  return out;
}

/** Stateful test indicator: SAR-like flip using vars, history, palettes and own outputs. */
const FLIP = defineIndicator({
  id: 'test-flip',
  name: 'Flip',
  shortName: 'Flip',
  category: 'other',
  overlay: false,
  inputs: { length: { kind: 'int', label: 'Length', default: 5, min: 1 } },
  outputs: [
    { type: 'plot', id: 'x', title: 'X', kind: 'histogram', color: ['#0f0', '#f00'] },
    {
      type: 'shape',
      id: 'sig',
      title: 'Signal',
      shape: 'triangleUp',
      location: 'belowBar',
      color: '#0f0',
    },
  ],
  setup({ inputs, ta }) {
    const hi = ta.highest(inputs.length);
    const lo = ta.lowest(inputs.length);
    const sd = ta.stdev(inputs.length);
    const prev = ta.history(3);
    const st = ta.vars({ dir: 1, flips: 0 });
    return (c) => {
      const h = hi.update(c.high[c.i]!);
      const l = lo.update(c.low[c.i]!);
      const d = sd.update(c.close[c.i]!);
      prev.push(c.close[c.i]!);
      const dir = c.close[c.i]! > (h + l) / 2 ? 1 : -1;
      if (dir !== st.dir) {
        st.flips++;
        c.set('sig', 1);
      }
      st.dir = dir;
      const last = c.get('x', c.i - 1);
      const back = prev.get(2);
      const v =
        (Number.isNaN(last) ? 0 : last * 0.5) +
        st.flips +
        (Number.isNaN(back) ? 0 : back * 1e-3) +
        d;
      c.set('x', v, dir > 0 ? 0 : 1);
    };
  },
});

function registry(): IndicatorRegistry {
  const r = new IndicatorRegistry();
  r.register(SMA);
  r.register(EMA);
  r.register(FLIP);
  return r;
}

function setup(rt: IndicatorRuntime): void {
  rt.add({ id: 'sma', type: 'sma', inputs: { length: 10 } });
  rt.add({ id: 'ema', type: 'ema', inputs: { length: 7, source: 'hl2' } });
  rt.add({ id: 'flip', type: 'test-flip', inputs: { length: 6 } });
  // Indicator-on-indicator chain: EMA of SMA, then SMA of that.
  rt.add({
    id: 'ema-of-sma',
    type: 'ema',
    inputs: { length: 5, source: { instanceId: 'sma', outputId: 'ma' } },
  });
  rt.add({
    id: 'sma-of-ema',
    type: 'sma',
    inputs: { length: 3, source: { instanceId: 'ema-of-sma', outputId: 'ema' } },
  });
}

describe('IndicatorRuntime', () => {
  it('incremental updates and appends equal a full recompute', () => {
    const all = randomBars(300, 7);
    const live = new IndicatorRuntime({ registry: registry() });
    setup(live);
    live.setBars(slice(all, 0, 50));
    const ticks = randomBars(300, 99);
    for (let i = 50; i < 300; i++) {
      const bar = barAt(all, i);
      // A few intrabar ticks on the new bar before its final value.
      live.updateBar(i, { ...bar, close: ticks.close[i]!, high: bar.high + 1 });
      live.updateBar(i, { ...bar, close: ticks.open[i]!, low: bar.low - 1 });
      live.updateBar(i, bar);
      if (i % 37 === 0) live.updateBar(i, bar);
    }
    const full = new IndicatorRuntime({ registry: registry() });
    setup(full);
    full.setBars(all);
    expect(dump(live)).toEqual(dump(full));
    expect(live.status('flip')).toEqual({ state: 'ok' });
  });

  it('reports the last index as changed on a live update', () => {
    const rt = new IndicatorRuntime({ registry: registry() });
    setup(rt);
    const all = randomBars(60);
    rt.setBars(slice(all, 0, 59));
    const changes = rt.updateBar(59, barAt(all, 59));
    expect(changes.map((c) => c.from)).toEqual([59, 59, 59, 59, 59]);
    expect(() => rt.updateBar(10, barAt(all, 10))).toThrow(RangeError);
  });

  it('computes indicator-on-indicator in dependency order regardless of add order', () => {
    const rt = new IndicatorRuntime({ registry: registry() });
    rt.add({
      id: 'b',
      type: 'ema',
      inputs: { length: 4, source: { instanceId: 'a', outputId: 'ma' } },
    });
    rt.add({ id: 'a', type: 'sma', inputs: { length: 3 } });
    expect(rt.ids()).toEqual(['a', 'b']);
    rt.setBars(randomBars(40));
    const a = rt.result('a')!.values.ma!;
    const b = rt.result('b')!.values.ema!;
    // EMA seeds after 4 valid SMA values: first SMA at 2, first EMA at 5.
    expect(Number.isNaN(b[4]!)).toBe(true);
    expect(b[5]).toBeCloseTo((a[2]! + a[3]! + a[4]! + a[5]!) / 4, 12);
    expect(b[6]).toBeCloseTo(0.4 * a[6]! + 0.6 * b[5]!, 12);
  });

  it('rejects cycles and keeps the previous inputs', () => {
    const rt = new IndicatorRuntime({ registry: registry() });
    rt.add({ id: 'a', type: 'sma' });
    rt.add({ id: 'b', type: 'ema', inputs: { source: { instanceId: 'a', outputId: 'ma' } } });
    expect(() => rt.setInputs('a', { source: { instanceId: 'b', outputId: 'ema' } })).toThrow(
      /cycle/,
    );
    expect(rt.spec('a')!.inputs!.source).toBe('close');
    expect(rt.ids()).toEqual(['a', 'b']);
  });

  it('puts dependents in the error state when their source is removed', () => {
    const rt = new IndicatorRuntime({ registry: registry() });
    rt.setBars(randomBars(30));
    rt.add({ id: 'a', type: 'sma' });
    rt.add({ id: 'b', type: 'ema', inputs: { source: { instanceId: 'a', outputId: 'ma' } } });
    rt.remove('a');
    expect(rt.status('b')?.state).toBe('error');
    expect(Array.from(rt.result('b')!.values.ema!.subarray(0, 30)).every(Number.isNaN)).toBe(true);
  });

  it('turns exceptions in step into an error status', () => {
    const reg = registry();
    reg.register(
      defineIndicator({
        id: 'bad',
        name: 'Bad',
        shortName: 'Bad',
        category: 'other',
        overlay: false,
        inputs: {},
        outputs: [{ type: 'plot', id: 'x', title: 'X', kind: 'line', color: '#fff' }],
        setup({ ta }) {
          return (c) => {
            if (c.i === 3) ta.sma(2); // primitives may only be created in setup
            c.set('x', c.i);
          };
        },
      }),
    );
    const rt = new IndicatorRuntime({ registry: reg });
    rt.add({ id: 'bad', type: 'bad' });
    rt.setBars(randomBars(10));
    expect(rt.status('bad')).toEqual({
      state: 'error',
      message: 'ta primitives must be created in setup(), not in step()',
    });
  });
});

describe('multi-timeframe', () => {
  const HTF_SMA = defineIndicator({
    id: 'htf-sma',
    name: 'HTF SMA',
    shortName: 'HTF',
    category: 'other',
    overlay: true,
    inputs: {
      length: { kind: 'int', label: 'Length', default: 2 },
      tf: { kind: 'timeframe', label: 'Timeframe', default: '' },
    },
    outputs: [{ type: 'plot', id: 'ma', title: 'MA', kind: 'step', color: '#fff' }],
    setup({ inputs, ta }) {
      const ma = ta.sma(inputs.length);
      return (c) => c.set('ma', ma.update(c.close[c.i]!));
    },
  });

  /** 1-minute chart bars, 5-minute timeframe bars covering them. */
  function data(): { chart: BarArrays; htf: BarArrays } {
    const chart = randomBars(20, 3, 0, 60);
    const htf = randomBars(4, 4, 0, 300);
    return { chart, htf };
  }

  it('requests the timeframe series and aligns values to chart bars', () => {
    const reg = registry();
    reg.register(HTF_SMA);
    const rt = new IndicatorRuntime({ registry: reg });
    const { chart, htf } = data();
    rt.setBars(chart);
    rt.add({ id: 'm', type: 'htf-sma', inputs: { tf: '5m' } });
    expect(rt.requiredTimeframes()).toEqual(['5m']);
    expect(rt.status('m')).toEqual({ state: 'waiting', timeframe: '5m' });

    rt.setTimeframeBars('5m', htf);
    const ma = rt.result('m')!.values.ma!;
    const want = (k: number) => (k < 1 ? NaN : (htf.close[k]! + htf.close[k - 1]!) / 2);
    for (let j = 0; j < 20; j++) expect(ma[j]).toEqual(want(Math.floor(j / 5)));

    // Live update of the last 5m bar re-aligns chart bars 15..19 only.
    const changes = rt.updateTimeframeBar('5m', { ...barAt(htf, 3), close: 1000 });
    expect(changes).toEqual([{ id: 'm', from: 15 }]);
    expect(ma[19]).toEqual((1000 + htf.close[2]!) / 2);
    expect(ma[14]).toEqual(want(2));
  });

  it('rejects output sources on a different timeframe', () => {
    const reg = registry();
    reg.register(
      defineIndicator({
        id: 'htf-src',
        name: 'HTF source',
        shortName: 'HTF',
        category: 'other',
        overlay: true,
        inputs: {
          tf: { kind: 'timeframe', label: 'Timeframe', default: '' },
          source: { kind: 'source', label: 'Source', default: 'close' },
        },
        outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
        setup: () => (c) => c.set('v', c.src.source[c.i]!),
      }),
    );
    const rt = new IndicatorRuntime({ registry: reg });
    rt.add({ id: 'a', type: 'sma' });
    expect(() =>
      rt.add({
        id: 'b',
        type: 'htf-src',
        inputs: { tf: '1D', source: { instanceId: 'a', outputId: 'ma' } },
      }),
    ).toThrow(/price sources/);
  });
});
