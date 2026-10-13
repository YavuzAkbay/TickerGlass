import { describe, expect, it } from 'vitest';
import { defineIndicator, IndicatorRegistry } from './registry';
import { IndicatorRuntime } from './runtime';
import { EMA, PIVOT_POINTS, SMA, VWAP } from './builtins';
import { calendarPeriod } from './calendar';
import { resolveOutputs } from './resolve';
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

  const HTF_CONFIRMED = defineIndicator({
    id: 'htf-confirmed',
    name: 'HTF close',
    shortName: 'HTF',
    category: 'other',
    overlay: true,
    inputs: {
      tf: { kind: 'timeframe', label: 'Timeframe', default: '', waitForCloseInput: 'wait' },
      wait: { kind: 'bool', label: 'Wait for timeframe closes', default: true },
    },
    outputs: [{ type: 'plot', id: 'c', title: 'C', kind: 'step', color: '#fff' }],
    setup: () => (c) => c.set('c', c.close[c.i]!),
  });

  it('aligns to closed timeframe bars when waiting for closes (no lookahead)', () => {
    const reg = registry();
    reg.register(HTF_CONFIRMED);
    const rt = new IndicatorRuntime({ registry: reg });
    const { chart, htf } = data();
    rt.setBars(chart);
    rt.add({ id: 'w', type: 'htf-confirmed', inputs: { tf: '5m' } });
    rt.add({ id: 'f', type: 'htf-confirmed', inputs: { tf: '5m', wait: false } });
    rt.setTimeframeBars('5m', htf);
    const w = rt.result('w')!.values.c!;
    const f = rt.result('f')!.values.c!;
    for (let j = 0; j < 20; j++) {
      const k = Math.floor(j / 5);
      expect(f[j]).toEqual(htf.close[k]); // final value of the containing bar
      expect(w[j]).toEqual(k < 1 ? NaN : htf.close[k - 1]); // last closed bar
    }
    // A tick of the forming 5m bar changes nothing for the confirmed instance.
    const changes = rt.updateTimeframeBar('5m', { ...barAt(htf, 3), close: 1000 });
    expect(changes).toEqual([{ id: 'f', from: 15 }]);
    expect(w[19]).toEqual(htf.close[2]);
  });

  it('does not propagate timeframe ticks that leave aligned values unchanged', () => {
    const reg = registry();
    reg.register(PIVOT_POINTS);
    const rt = new IndicatorRuntime({ registry: reg });
    const { chart, htf } = data();
    rt.setBars(chart);
    rt.add({ id: 'p', type: 'pivot-points', inputs: { timeframe: '5m' } });
    rt.add({
      id: 'dep',
      type: 'sma',
      inputs: { length: 2, source: { instanceId: 'p', outputId: 'p' } },
    });
    rt.setTimeframeBars('5m', htf);
    // Pivots of the forming bar come from the previous bar: nothing to redo.
    expect(rt.updateTimeframeBar('5m', { ...barAt(htf, 3), close: 1000 })).toEqual([]);
    // A new timeframe bar changes chart bars from its first one (none here) -> no chart change.
    expect(rt.updateTimeframeBar('5m', { ...barAt(htf, 3), time: 1200 })).toEqual([]);
  });

  it('gives timeframe instances the timeframe interval in env', () => {
    const seen: number[] = [];
    const reg = registry();
    reg.register(
      defineIndicator({
        id: 'env-probe',
        name: 'Env',
        shortName: 'Env',
        category: 'other',
        overlay: true,
        inputs: { tf: { kind: 'timeframe', label: 'Timeframe', default: '' } },
        outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
        setup: ({ env }) => {
          seen.push(env.intervalSeconds);
          return () => {};
        },
      }),
    );
    const rt = new IndicatorRuntime({ registry: reg, context: { intervalSeconds: 60 } });
    const { chart, htf } = data();
    rt.setBars(chart);
    rt.add({ id: 'c', type: 'env-probe' });
    rt.add({ id: 't', type: 'env-probe', inputs: { tf: '5m' } });
    rt.setTimeframeBars('5m', htf);
    expect(seen).toContain(60);
    expect(seen).toContain(0);
    seen.length = 0;
    rt.setContext({ timeframeSeconds: { '5m': 300 } });
    expect(seen).toEqual([300]);
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

describe('bars context (timezone, session, interval)', () => {
  const NY = 'America/New_York';
  // 2024-03-05 (Tue) 04:30 UTC = Mon 23:30 in New York.
  const t = Date.UTC(2024, 2, 5, 4, 30) / 1000;

  it('computes calendar periods in the exchange timezone', () => {
    expect(calendarPeriod(t, 'session', 'UTC')).toBe(calendarPeriod(t, 'session', 'UTC'));
    expect(calendarPeriod(t, 'session', NY)).toBe(calendarPeriod(t, 'session', 'UTC') - 1);
    // Overnight session (futures, 18:00-17:00 NY): Mon 23:30 belongs to Tuesday's trading day.
    expect(calendarPeriod(t, 'session', NY, '1800-1700')).toBe(calendarPeriod(t, 'session', 'UTC'));
    // 2024-03-31 23:30 NY = April 1 UTC: March (Q1) in New York, April (Q2) in UTC.
    const eoq = Date.UTC(2024, 3, 1, 3, 30) / 1000;
    expect(calendarPeriod(eoq, 'month', NY)).toBe(2024 * 12 + 2);
    expect(calendarPeriod(eoq, 'month', 'UTC')).toBe(2024 * 12 + 3);
    expect(calendarPeriod(eoq, 'quarter', NY)).toBe(2024 * 4);
    expect(calendarPeriod(eoq, 'quarter', 'UTC')).toBe(2024 * 4 + 1);
    expect(calendarPeriod(eoq, 'year', NY)).toBe(2024);
    expect(calendarPeriod(eoq, 'decade', NY)).toBe(202);
    expect(calendarPeriod(eoq, 'century', NY)).toBe(20);
    // Unknown zones fall back to UTC.
    expect(calendarPeriod(t, 'session', 'Not/AZone')).toBe(calendarPeriod(t, 'session', 'UTC'));
  });

  it('resets session VWAP at exchange midnight and recomputes on a context change', () => {
    const reg = new IndicatorRegistry();
    reg.register(VWAP);
    const rt = new IndicatorRuntime({ registry: reg });
    // Hourly bars from 2024-03-04 20:00 UTC (15:00 NY) for 12 hours.
    const bars = randomBars(12, 5, Date.UTC(2024, 2, 4, 20) / 1000, 3600);
    rt.setBars(bars);
    rt.add({ id: 'v', type: 'vwap', inputs: { showBand1: false } });
    const hlc3 = (i: number) => (bars.high[i]! + bars.low[i]! + bars.close[i]!) / 3;
    // UTC: new session at 00:00 UTC = bar 4.
    expect(rt.result('v')!.values.vwap![4]).toBeCloseTo(hlc3(4), 10);
    const changes = rt.setContext({ timezone: NY, intervalSeconds: 3600 });
    expect(changes).toEqual([{ id: 'v', from: 0 }]);
    const v = rt.result('v')!.values.vwap!;
    // New York: midnight = 05:00 UTC (EST) = bar 9.
    expect(v[4]).not.toBeCloseTo(hlc3(4), 10);
    expect(v[9]).toBeCloseTo(hlc3(9), 10);
    // Same context again: nothing to recompute.
    expect(rt.setContext({ timezone: NY })).toEqual([]);
  });

  it('hides VWAP on daily and above when asked', () => {
    const reg = new IndicatorRegistry();
    reg.register(VWAP);
    const rt = new IndicatorRuntime({ registry: reg, context: { intervalSeconds: 86_400 } });
    rt.setBars(randomBars(10, 1, 0, 86_400));
    rt.add({ id: 'h', type: 'vwap', inputs: { hideOnDWM: true } });
    rt.add({ id: 's', type: 'vwap' });
    expect(Array.from(rt.result('h')!.values.vwap!.subarray(0, 10)).every(Number.isNaN)).toBe(true);
    expect(rt.result('s')!.values.vwap![9]).not.toBeNaN();
    rt.setContext({ intervalSeconds: 3600 });
    expect(rt.result('h')!.values.vwap![9]).not.toBeNaN();
  });

  it('resolves shape and bgcolor offsets from inputs', () => {
    const def = defineIndicator({
      id: 'off',
      name: 'Off',
      shortName: 'Off',
      category: 'other',
      overlay: true,
      inputs: { offset: { kind: 'int', label: 'Offset', default: 2 } },
      outputs: [
        { type: 'bgcolor', id: 'bg', title: 'BG', color: '#fff', offset: (i) => i.offset },
        {
          type: 'shape',
          id: 'sh',
          title: 'SH',
          shape: 'circle',
          location: 'aboveBar',
          color: '#fff',
          offset: -1,
        },
      ],
      setup: () => () => {},
    });
    const out = resolveOutputs(def, { offset: 3 });
    expect(out.map((o) => (o.type === 'bgcolor' || o.type === 'shape' ? o.offset : null))).toEqual([
      3, -1,
    ]);
  });
});
