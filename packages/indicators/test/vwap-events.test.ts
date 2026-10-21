import { describe, expect, it } from 'vitest';
import { IndicatorRuntime } from '../src/runtime';
import { randomBars } from '../src/test-utils';
import type { BarsEvents, InputValueMap } from '../src/types';
import '../src/builtins';
import { feedLive, snapshot } from './helpers';

const DAY = 86_400;
const T0 = 1_700_006_400; // a Monday 00:00 UTC

// Daily bars with a gap of three days between bars 4 and 5.
const DAYS = [0, 1, 2, 3, 4, 7, 8];
const CLOSE = [10, 12, 11, 14, 13, 16, 10];
const VOLUME = [1, 3, 2, 2, 1, 4, 2];
const T = DAYS.map((d) => T0 + d * DAY);
const BARS = {
  time: Float64Array.from(T),
  open: Float64Array.from(CLOSE),
  high: Float64Array.from(CLOSE),
  low: Float64Array.from(CLOSE),
  close: Float64Array.from(CLOSE),
  volume: Float64Array.from(VOLUME),
};

const NONE: BarsEvents = { dividends: [], splits: [], earnings: [] };

/**
 * Dividends: before the first bar (ignored), inside bar 1 (reset at bar 2),
 * two inside bar 2 (one reset at bar 3), inside the gap (reset at bar 5) and
 * after the last bar (ignored). Unsorted on purpose: the runtime sorts.
 */
const EVENTS: BarsEvents = {
  ...NONE,
  dividends: [T[4]! + DAY, T[0]! - DAY, T[1]! + 3600, T[2]! + 200, T[2]! + 100, T[6]! + DAY],
};

const INPUTS: InputValueMap = { anchor: 'Dividends', source: 'close', showBand1: true, mult1: 1 };

function run(inputs: InputValueMap, events: BarsEvents | null) {
  const rt = new IndicatorRuntime({ context: { intervalSeconds: DAY, events } });
  rt.add({ id: 'x', type: 'vwap', inputs });
  rt.setBars(BARS);
  return snapshot(rt.result('x')!);
}

function expectClose(got: number[], want: number[]): void {
  expect(got).toHaveLength(want.length);
  got.forEach((g, i) =>
    expect(Math.abs(g - want[i]!), `[${i}] got ${g} want ${want[i]}`).toBeLessThanOrEqual(1e-8),
  );
}

describe('VWAP event anchors', () => {
  it('resets at the first bar at or after each event (hand-computed)', () => {
    const r = run(INPUTS, EVENTS);
    // Periods: [0, 1], [2], [3, 4], [5, 6].
    // Bar 1: (10*1 + 12*3) / 4 = 11.5; E[x^2] = (100 + 432) / 4 = 133 -> sd sqrt(0.75).
    // Bar 4: (14*2 + 13) / 3 = 41/3; E[x^2] = (392 + 169) / 3 = 187 -> sd sqrt(2)/3.
    // Bar 6: (16*4 + 10*2) / 6 = 14; E[x^2] = (1024 + 200) / 6 = 204 -> sd sqrt(8).
    const vwap = [10, 11.5, 11, 14, 41 / 3, 16, 14];
    const sd = [0, Math.sqrt(0.75), 0, 0, Math.sqrt(2) / 3, 0, Math.sqrt(8)];
    expectClose(r.vwap!, vwap);
    expectClose(
      r.upper1!,
      vwap.map((v, i) => v + sd[i]!),
    );
    expectClose(
      r.lower1!,
      vwap.map((v, i) => v - sd[i]!),
    );
  });

  it('accumulates over the whole series without events', () => {
    const cumulative = [10, 11.5, 68 / 6, 96 / 8, 109 / 9, 173 / 13, 193 / 15];
    expectClose(run(INPUTS, null).vwap!, cumulative);
    expectClose(run(INPUTS, NONE).vwap!, cumulative);
  });

  it('each anchor reads its own event kind', () => {
    const events: BarsEvents = { dividends: [], splits: [T[3]!], earnings: [T[5]! - 1] };
    const splits = run({ ...INPUTS, anchor: 'Splits' }, events).vwap!;
    expectClose(splits, [10, 11.5, 68 / 6, 14, 41 / 3, 105 / 7, 125 / 9]);
    const earnings = run({ ...INPUTS, anchor: 'Earnings' }, events).vwap!;
    expectClose(earnings, [10, 11.5, 68 / 6, 96 / 8, 109 / 9, 16, 14]);
    // Dividends: none in this set.
    expectClose(run(INPUTS, events).vwap!, run(INPUTS, null).vwap!);
  });

  it('live ticks and appends equal a full computation', () => {
    const bars = randomBars(400, 11, 1_700_000_000, 900);
    const t = (i: number) => bars.time[i]!;
    // Events inside bars, on bar times, in gaps and on the live bars.
    const events: BarsEvents = {
      dividends: [t(10) + 1, t(50), t(120) + 450, t(120) + 600, t(305), t(390) + 10],
      splits: [t(200)],
      earnings: [t(301) - 1, t(399)],
    };
    for (const anchor of ['Dividends', 'Splits', 'Earnings']) {
      const inputs = { anchor, showBand2: true };
      const full = new IndicatorRuntime({ context: { intervalSeconds: 900, events } });
      full.add({ id: 'x', type: 'vwap', inputs });
      full.setBars(bars);
      const live = new IndicatorRuntime({ context: { intervalSeconds: 900, events } });
      live.add({ id: 'x', type: 'vwap', inputs });
      feedLive(live, bars, 300);
      expect(snapshot(live.result('x')!), anchor).toEqual(snapshot(full.result('x')!));
    }
  });

  it('recomputes only event-anchored instances when the events change', () => {
    const rt = new IndicatorRuntime({ context: { intervalSeconds: DAY } });
    rt.add({ id: 'ev', type: 'vwap', inputs: INPUTS });
    rt.add({ id: 'session', type: 'vwap', inputs: { ...INPUTS, anchor: 'Session' } });
    rt.add({ id: 'sma', type: 'sma', inputs: { length: 2 } });
    rt.setBars(BARS);
    expectClose(snapshot(rt.result('ev')!).vwap!, run(INPUTS, null).vwap!);

    // Events arrive later.
    const changes = rt.setContext({ events: EVENTS });
    expect(changes.map((c) => c.id)).toEqual(['ev']);
    expect(snapshot(rt.result('ev')!)).toEqual(run(INPUTS, EVENTS));
    // The same times again (new object, other order): nothing to do.
    expect(
      rt.setContext({ events: { ...EVENTS, dividends: [...EVENTS.dividends].reverse() } }),
    ).toEqual([]);
    // Other context changes keep the events.
    rt.setContext({ timezone: 'America/New_York' });
    expect(snapshot(rt.result('ev')!)).toEqual(run(INPUTS, EVENTS));

    // Switching an instance to an event anchor picks up the events.
    rt.setInputs('session', INPUTS);
    expect(snapshot(rt.result('session')!)).toEqual(run(INPUTS, EVENTS));

    // Cleared (symbol change): back to accumulating over the whole series.
    expect(
      rt
        .setContext({ events: null })
        .map((c) => c.id)
        .sort(),
    ).toEqual(['ev', 'session']);
    expectClose(snapshot(rt.result('ev')!).vwap!, run(INPUTS, null).vwap!);
  });
});
