import { IndicatorRegistry, IndicatorRuntime, type BarArrays } from '@investopen/indicators';
import { describe, expect, it } from 'vitest';
import type { AlertSpec, IndicatorRef } from './types';
import { alertBars, instanceWarmup, warmupBars, warmupSince } from './warmup';

/** Deterministic random walk (LCG), `n` bars. */
function synthetic(n: number): BarArrays {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const time = new Float64Array(n);
  const open = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  const volume = new Float64Array(n);
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.04));
    time[i] = 1_700_000_000 + i * 60;
    open[i] = o;
    close[i] = p;
    high[i] = Math.max(o, p) * (1 + rnd() * 0.01);
    low[i] = Math.min(o, p) * (1 - rnd() * 0.01);
    volume[i] = 1000 + Math.floor(rnd() * 1000);
  }
  return { time, open, high, low, close, volume };
}

function slice(b: BarArrays, from: number): BarArrays {
  const s = (a: ArrayLike<number>) => Float64Array.from(a).subarray(from);
  return {
    time: s(b.time),
    open: s(b.open),
    high: s(b.high),
    low: s(b.low),
    close: s(b.close),
    volume: s(b.volume),
  };
}

function ema(bars: BarArrays, length: number): Float64Array {
  const rt = new IndicatorRuntime();
  rt.add({ id: 'e', type: 'ema', inputs: { length } });
  rt.setBars(bars);
  const r = rt.result('e');
  if (!r) throw new Error('no result');
  return (r.values['ema'] as Float64Array).slice(0, r.length);
}

const ref = (
  instances: IndicatorRef['instances'],
  instanceId: string,
  outputId: string,
): IndicatorRef => ({
  instances,
  instanceId,
  outputId,
  title: '',
});

describe('warmupBars', () => {
  it('EMA 50: a warmupBars lead-in matches the full history within 1e-8 relative', () => {
    const r = ref(
      [{ id: 'e', type: 'ema', inputs: { length: 50, source: 'close', offset: 0 } }],
      'e',
      'ema',
    );
    const w = warmupBars(r);
    expect(w).toBe(550);
    const evaluated = 1000;
    const all = synthetic(5000);
    const n = all.time.length;
    const full = ema(all, 50);
    const from = n - evaluated - w;
    const part = ema(slice(all, from), 50);
    let worst = 0;
    for (let i = n - evaluated; i < n; i++) {
      const a = full[i]!;
      const b = part[i - from]!;
      worst = Math.max(worst, Math.abs(a - b) / Math.abs(a));
    }
    expect(worst).toBeLessThan(1e-8);
    // A much shorter lead-in is visibly off: the test can fail.
    const short = ema(slice(all, n - evaluated - 60), 50);
    expect(Math.abs(short[60]! - full[n - evaluated]!) / full[n - evaluated]!).toBeGreaterThan(
      1e-8,
    );
  });

  it('base: 10 x max(int inputs, 1) + 50, at least 300', () => {
    expect(instanceWarmup({ id: 'a', type: 'rsi', inputs: { length: 14 } })).toBe(300);
    expect(instanceWarmup({ id: 'a', type: 'sma', inputs: { length: 200 } })).toBe(2050);
    // Unknown type: max(int inputs) = 1.
    expect(instanceWarmup({ id: 'a', type: 'nope', inputs: {} })).toBe(300);
    // Defaults fill missing int inputs (MACD slow 26 -> 310).
    expect(instanceWarmup({ id: 'a', type: 'macd', inputs: {} })).toBe(310);
  });

  it('overrides by definition id', () => {
    expect(instanceWarmup({ id: 'a', type: 'obv', inputs: {} })).toBe(5000);
    expect(instanceWarmup({ id: 'a', type: 'obv', inputs: {} }, { maxBars: 2000 })).toBe(2000);
    expect(instanceWarmup({ id: 'a', type: 'parabolic-sar', inputs: {} })).toBe(500);
    expect(
      instanceWarmup({
        id: 'a',
        type: 'ichimoku',
        inputs: { conversion: 9, base: 26, spanB: 52, displacement: 26 },
      }),
    ).toBe(546);
    // VWAP: two anchor periods of bars (Session on 5m: 2 days = 576 + 1).
    const vwap = { id: 'a', type: 'vwap', inputs: { anchor: 'Session' } };
    expect(instanceWarmup(vwap, { intervalSeconds: 300 })).toBe(577);
    expect(instanceWarmup(vwap, { intervalSeconds: 3600 })).toBe(300);
    expect(instanceWarmup(vwap)).toBe(5000);
  });

  it('chains add up along sources (max over upstream)', () => {
    const r = ref(
      [
        { id: 'rsi', type: 'rsi', inputs: { length: 14, source: 'close' } },
        {
          id: 'sma',
          type: 'sma',
          inputs: { length: 40, source: { instanceId: 'rsi', outputId: 'rsi' } },
        },
        { id: 'big', type: 'sma', inputs: { length: 100, source: 'close' } },
        {
          id: 'top',
          type: 'ema',
          inputs: { length: 9, source: { instanceId: 'sma', outputId: 'ma' } },
        },
      ],
      'top',
      'ema',
    );
    // top 300 + sma 450 + rsi 300; `big` is not upstream of top.
    expect(warmupBars(r)).toBe(1050);
    expect(warmupBars({ ...r, instanceId: 'big' })).toBe(1050);
  });

  it('throws on cycles and unknown upstream ids', () => {
    const cyc = ref(
      [
        { id: 'a', type: 'sma', inputs: { source: { instanceId: 'b', outputId: 'ma' } } },
        { id: 'b', type: 'sma', inputs: { source: { instanceId: 'a', outputId: 'ma' } } },
      ],
      'a',
      'ma',
    );
    expect(() => warmupBars(cyc)).toThrow(/cycle/);
    const missing = ref(
      [{ id: 'a', type: 'sma', inputs: { source: { instanceId: 'zz', outputId: 'ma' } } }],
      'a',
      'ma',
    );
    expect(() => warmupBars(missing)).toThrow(/unknown instance/);
  });
});

describe('warmupSince / alertBars', () => {
  it('anchored VWAP loads by time', () => {
    const r = ref(
      [
        { id: 'a', type: 'anchored-vwap', inputs: { anchor: 1_700_000_000 } },
        { id: 'b', type: 'anchored-vwap', inputs: { anchor: 0 } },
      ],
      'a',
      'vwap',
    );
    expect(warmupSince(r)).toBe(1_700_000_000);
    expect(
      warmupSince(ref([{ id: 'b', type: 'anchored-vwap', inputs: { anchor: 0 } }], 'b', 'vwap')),
    ).toBeNull();
  });

  it('adds moving bars + 2 and caps at maxBars', () => {
    const left = {
      kind: 'indicator' as const,
      ref: ref([{ id: 'e', type: 'ema', inputs: { length: 50 } }], 'e', 'ema'),
    };
    const spec: AlertSpec = {
      schemaVersion: 1,
      left,
      condition: { op: 'movingUp', amount: 1, bars: 20 },
      trigger: 'once',
    };
    expect(alertBars(spec)).toBe(572);
    const price: AlertSpec = {
      schemaVersion: 1,
      left: { kind: 'price', field: 'close' },
      condition: { op: 'greater', right: left },
      trigger: 'once',
    };
    expect(alertBars(price)).toBe(552);
    expect(
      alertBars({ ...price, condition: { op: 'greater', right: { kind: 'value', value: 1 } } }),
    ).toBe(2);
    const obv: AlertSpec = {
      ...price,
      condition: {
        op: 'enteringChannel',
        channel: {
          kind: 'bounds',
          upper: {
            kind: 'indicator',
            ref: ref([{ id: 'o', type: 'obv', inputs: {} }], 'o', 'obv'),
          },
          lower: { kind: 'value', value: 0 },
        },
      },
    };
    expect(alertBars(obv)).toBe(5000);
  });
});

describe('declared warm-ups (IndicatorDefinition.warmup)', () => {
  const registry = new IndicatorRegistry();
  const def = {
    category: 'other',
    overlay: false,
    outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#000' }],
    setup: () => () => {},
  } as const;
  registry.register({
    ...def,
    id: 'cum',
    name: 'Cum',
    shortName: 'C',
    inputs: {},
    warmup: { kind: 'cumulative' },
  });
  registry.register({
    ...def,
    id: 'fixed',
    name: 'Fixed',
    shortName: 'F',
    inputs: {},
    warmup: { bars: 800 },
  });
  registry.register({
    ...def,
    id: 'byinput',
    name: 'By input',
    shortName: 'B',
    inputs: { length: { kind: 'int', label: 'Length', default: 20, min: 1 } },
    warmup: { bars: { fromInputs: (i: { length: number }) => 40 * i.length }['fromInputs'] },
  });
  const w = (type: string, inputs = {}, maxBars?: number) =>
    instanceWarmup({ id: 'a', type, inputs }, { registry, ...(maxBars ? { maxBars } : {}) });

  it('wins over the heuristics, floored at the minimum and capped at maxBars', () => {
    expect(w('cum')).toBe(5000);
    expect(w('cum', {}, 2000)).toBe(2000);
    expect(w('fixed')).toBe(800);
    expect(w('fixed', {}, 600)).toBe(600);
    expect(w('byinput')).toBe(800);
    expect(w('byinput', { length: 5 })).toBe(300);
    expect(w('byinput', { length: 'bad' })).toBe(800);
  });
});
