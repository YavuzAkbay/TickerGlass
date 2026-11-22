import { describe, expect, it } from 'vitest';
import { DEFAULT_CHECK_LIVE_BARS, checkScript, firstMismatch, sameValue } from './check';
import { IndicatorRegistry } from './registry';
import { randomBars } from './test-utils';
import { compileUserScript, probeLineOffset } from './user-script';

const CTX = { timezone: 'UTC', session: null, intervalSeconds: 60 } as const;

function registryOf(body: string) {
  const reg = new IndicatorRegistry();
  const { definition } = compileUserScript(
    `defineIndicator({
      id: 'x', name: 'T', shortName: 'T', category: 'other', overlay: false,
      inputs: {},
      outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
      ${body}
    });`,
    { scriptId: 't', lineOffset: probeLineOffset() },
  );
  reg.register(definition);
  return reg;
}

describe('checkScript', () => {
  const bars = randomBars(120);

  it('passes when live updates equal the full compute', () => {
    const registry = registryOf(
      'setup({ ta }) { const m = ta.sma(5); return (c) => c.set("v", m.update(c.close[c.i])); },',
    );
    expect(checkScript({ registry, type: 'user:t', bars, context: CTX, inputs: {} })).toEqual({
      ok: true,
    });
  });

  it('reports the first mismatch of state kept outside ta', () => {
    const registry = registryOf('setup() { let n = 0; return (c) => { n++; c.set("v", n); }; },');
    const r = checkScript({ registry, type: 'user:t', bars, context: CTX, inputs: {} });
    expect(r).toMatchObject({ ok: false, mismatch: { outputId: 'v' } });
    if ('mismatch' in r)
      expect(r.mismatch.index).toBeGreaterThanOrEqual(120 - DEFAULT_CHECK_LIVE_BARS);
  });

  it('reports an error of the computation', () => {
    const registry = registryOf('setup() { return () => { throw new Error("boom"); }; },');
    const r = checkScript({ registry, type: 'user:t', bars, context: CTX, inputs: {} });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/^Check \(full\): .*boom/) });
  });

  it('accepts plain arrays and a custom number of live bars', () => {
    const registry = registryOf('setup() { let n = 0; return (c) => { n++; c.set("v", n); }; },');
    const plain = Object.fromEntries(Object.entries(bars).map(([k, v]) => [k, Array.from(v)]));
    const r = checkScript({
      registry,
      type: 'user:t',
      bars: plain as never,
      context: CTX,
      inputs: {},
      liveBars: 3,
    });
    expect(r).toMatchObject({ ok: false, mismatch: { index: 117 } });
  });
});

describe('sameValue / firstMismatch', () => {
  it('compares with a relative tolerance and NaN equal to NaN', () => {
    expect(sameValue(NaN, NaN)).toBe(true);
    expect(sameValue(1e6 + 1e-4, 1e6)).toBe(true);
    expect(sameValue(1e6 + 1e-2, 1e6)).toBe(false);
    expect(sameValue(Infinity, -Infinity)).toBe(false);
  });

  it('finds the earliest differing bar over values and colours', () => {
    const res = (v: number[]) => ({
      length: 3,
      values: { a: Float64Array.from(v) },
      colors: {},
      status: { state: 'ok' as const },
    });
    expect(firstMismatch(res([1, 2, 3]), res([1, 2, 3]), 3)).toBeNull();
    expect(firstMismatch(res([1, 2, 3]), res([1, 9, 8]), 3)).toEqual({
      outputId: 'a',
      index: 1,
      full: 2,
      live: 9,
    });
  });
});
