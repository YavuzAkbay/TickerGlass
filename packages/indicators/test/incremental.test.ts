import { describe, expect, it } from 'vitest';
import { listIndicators } from '../src/registry';
import { resolveInputs, resolveOutputs } from '../src/resolve';
import { IndicatorRuntime } from '../src/runtime';
import { randomBars } from '../src/test-utils';
import type { InputValueMap } from '../src/types';
import '../src/builtins';
import { feedLive, snapshot } from './helpers';

const bars = randomBars(400, 7, 1_700_000_000, 900);

/** Run every input on the chart series (timeframe inputs -> ''). */
function chartInputs(id: string): InputValueMap {
  const def = listIndicators().find((d) => d.id === id)!;
  const inputs: InputValueMap = {};
  for (const [key, d] of Object.entries(def.inputs)) if (d.kind === 'timeframe') inputs[key] = '';
  return inputs;
}

describe.each(listIndicators().map((d) => d.id))('%s', (id) => {
  it('live updates and appends equal a full computation', () => {
    const inputs = chartInputs(id);
    const full = new IndicatorRuntime();
    full.add({ id: 'x', type: id, inputs });
    full.setBars(bars);
    const live = new IndicatorRuntime();
    live.add({ id: 'x', type: id, inputs });
    feedLive(live, bars, 150);
    const r = full.result('x')!;
    expect(r.status).toEqual({ state: 'ok' });
    // Something is computed past the warm-up.
    expect(Object.values(r.values).some((v) => !Number.isNaN(v[r.length - 1]!))).toBe(true);
    expect(snapshot(live.result('x')!)).toEqual(snapshot(r));
  });

  it('works as an indicator-on-indicator source and resolves its outputs', () => {
    const def = listIndicators().find((d) => d.id === id)!;
    const out = resolveOutputs(def, resolveInputs(def, chartInputs(id)));
    for (const o of out) if (o.type === 'hline') expect(Number.isFinite(o.value)).toBe(true);
    const plot = out.find((o) => o.type === 'plot');
    if (!plot) return;
    const rt = new IndicatorRuntime();
    rt.add({ id: 'x', type: id, inputs: chartInputs(id) });
    rt.add({ id: 'ma', type: 'sma', inputs: { source: { instanceId: 'x', outputId: plot.id } } });
    feedLive(rt, bars, 300);
    expect(rt.status('ma')).toEqual({ state: 'ok' });
  });
});
