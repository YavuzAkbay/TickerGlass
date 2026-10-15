import { describe, expect, it } from 'vitest';
import { listIndicators } from '../src/registry';
import { resolveInputs, resolveOutputs } from '../src/resolve';
import { IndicatorRuntime } from '../src/runtime';
import { randomBars } from '../src/test-utils';
import type { InputValueMap } from '../src/types';
import '../src/builtins';
import { FIXTURES, type IncrementalFixture } from './fixtures';
import { feedLive, snapshot } from './helpers';

const bars = randomBars(400, 7, 1_700_000_000, 900);
const NO_FIXTURE: IncrementalFixture = {};

/** Run every input on the chart series (timeframe inputs -> ''), then fixture overrides. */
function chartInputs(id: string): InputValueMap {
  const def = listIndicators().find((d) => d.id === id)!;
  const inputs: InputValueMap = {};
  for (const [key, d] of Object.entries(def.inputs)) if (d.kind === 'timeframe') inputs[key] = '';
  return { ...inputs, ...FIXTURES[id]?.inputs };
}

function runtime(fx: IncrementalFixture): IndicatorRuntime {
  return new IndicatorRuntime(fx.context ? { context: fx.context } : {});
}

it('fixtures only name registered indicators', () => {
  const ids = new Set(listIndicators().map((d) => d.id));
  expect(Object.keys(FIXTURES).filter((id) => !ids.has(id))).toEqual([]);
});

describe.each(listIndicators().map((d) => d.id))('%s', (id) => {
  const fx = FIXTURES[id] ?? NO_FIXTURE;
  const series = fx.bars ?? bars;

  it('live updates and appends equal a full computation', () => {
    const inputs = chartInputs(id);
    const full = runtime(fx);
    full.add({ id: 'x', type: id, inputs });
    full.setBars(series);
    const live = runtime(fx);
    live.add({ id: 'x', type: id, inputs });
    feedLive(live, series, fx.liveFrom ?? 150);
    const r = full.result('x')!;
    expect(r.status).toEqual({ state: 'ok' });
    // Something is computed past the warm-up (at the last bar unless sparse).
    const values = Object.values(r.values);
    if (fx.noValues)
      expect(values.every((v) => v.subarray(0, r.length).every(Number.isNaN))).toBe(true);
    else if (fx.sparse)
      expect(values.some((v) => v.subarray(0, r.length).some((x) => !Number.isNaN(x)))).toBe(true);
    else expect(values.some((v) => !Number.isNaN(v[r.length - 1]!))).toBe(true);
    expect(snapshot(live.result('x')!)).toEqual(snapshot(r));
  });

  it('works as an indicator-on-indicator source and resolves its outputs', () => {
    const def = listIndicators().find((d) => d.id === id)!;
    const out = resolveOutputs(def, resolveInputs(def, chartInputs(id)));
    for (const o of out) if (o.type === 'hline') expect(Number.isFinite(o.value)).toBe(true);
    const plot = out.find((o) => o.type === 'plot');
    if (!plot) return;
    const rt = runtime(fx);
    rt.add({ id: 'x', type: id, inputs: chartInputs(id) });
    rt.add({ id: 'ma', type: 'sma', inputs: { source: { instanceId: 'x', outputId: plot.id } } });
    feedLive(rt, series, fx.bars ? (fx.liveFrom ?? 150) : 300);
    expect(rt.status('ma')).toEqual({ state: 'ok' });
  });
});
