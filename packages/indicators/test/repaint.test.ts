import { describe, expect, it } from 'vitest';
import { SMA } from '../src/builtins';
import { IndicatorInstance } from '../src/instance';
import { BarStore } from '../src/bars';
import { defineIndicator, IndicatorRegistry, validateDefinition } from '../src/registry';
import { IndicatorRuntime, type Change } from '../src/runtime';
import { randomBars } from '../src/test-utils';
import type { BarArrays, BarInput } from '../src/types';
import { barAt, sliceBars, snapshot } from './helpers';

/**
 * Test-only ZigZag on closes: the last pivot moves while price extends it
 * (`setAt` clears the old one), a reversal by `deviation` % adds a pivot, and
 * `ext` marks the last bar only (cleared retroactively once a bar is added).
 */
const TOY = defineIndicator({
  id: 'toy-zigzag',
  name: 'Toy ZigZag',
  shortName: 'TZZ',
  category: 'other',
  overlay: true,
  repaints: true,
  inputs: { deviation: { kind: 'float', label: 'Deviation %', default: 1 } },
  outputs: [
    { type: 'plot', id: 'zz', title: 'ZZ', kind: 'line', color: ['#00ff00', '#ff0000'] },
    { type: 'plot', id: 'ext', title: 'Last', kind: 'circles', color: '#0000ff' },
  ],
  setup({ inputs, ta }) {
    const s = ta.vars({ dir: 0, idx: -1, price: NaN, ext: -1 });
    const dev = inputs.deviation / 100;
    return (c) => {
      const x = c.close[c.i]!;
      const pivot = (dir: number) => {
        s.dir = dir;
        s.idx = c.i;
        s.price = x;
        c.setAt('zz', c.i, x, dir < 0 ? 1 : 0);
      };
      const move = () => {
        c.setAt('zz', s.idx, NaN);
        pivot(s.dir);
      };
      if (c.isLast) {
        if (s.ext >= 0 && s.ext < c.i) c.setAt('ext', s.ext, NaN);
        s.ext = c.i;
        c.set('ext', x);
      }
      if (s.idx < 0) pivot(0);
      else if (s.dir === 1 && x >= s.price) move();
      else if (s.dir === -1 && x <= s.price) move();
      else if (s.dir >= 0 && x <= s.price * (1 - dev)) pivot(-1);
      else if (s.dir <= 0 && x >= s.price * (1 + dev)) pivot(1);
    };
  },
});

function registry(): IndicatorRegistry {
  const r = new IndicatorRegistry();
  r.register(TOY);
  r.register(SMA);
  return r;
}

/** Ticks that push the close to the high, back to the low and around (pivots move back and forth). */
function wildTicks(b: BarInput): BarInput[] {
  const at = (close: number): BarInput => ({ ...b, close });
  return [at(b.open), at(b.high), at(b.low), at(b.high), at(b.open), b];
}

/** History to `from`, then every bar appended and re-ticked; returns all changes. */
function feed(rt: IndicatorRuntime, cols: BarArrays, from: number): Change[][] {
  rt.setBars(sliceBars(cols, 0, from));
  const all: Change[][] = [];
  for (let i = from; i < cols.time.length; i++)
    for (const t of wildTicks(barAt(cols, i))) all.push(rt.updateBar(i, t));
  return all;
}

describe('repainting definitions (setAt)', () => {
  const bars = randomBars(300, 11, 1_700_000_000, 900);

  it.each([0.3, 1, 3])('live ticks and appends equal a full computation (deviation %s)', (d) => {
    const full = new IndicatorRuntime({ registry: registry() });
    full.add({ id: 'z', type: 'toy-zigzag', inputs: { deviation: d } });
    full.add({
      id: 'ma',
      type: 'sma',
      inputs: { length: 3, source: { instanceId: 'z', outputId: 'zz' } },
    });
    full.setBars(bars);
    const live = new IndicatorRuntime({ registry: registry() });
    live.add({ id: 'z', type: 'toy-zigzag', inputs: { deviation: d } });
    live.add({
      id: 'ma',
      type: 'sma',
      inputs: { length: 3, source: { instanceId: 'z', outputId: 'zz' } },
    });
    const changes = feed(live, bars, 50);
    expect(full.status('z')).toEqual({ state: 'ok' });
    expect(snapshot(live.result('z')!)).toEqual(snapshot(full.result('z')!));
    expect(snapshot(live.result('ma')!)).toEqual(snapshot(full.result('ma')!));
    // Some ticks did repaint the past (otherwise the test proves nothing).
    expect(changes.some((cs) => cs.some((c) => c.id === 'z' && c.from < live.length - 1))).toBe(
      true,
    );
  });

  it('reports the first past index that actually changed and propagates it', () => {
    const at = (time: number, close: number): BarInput => ({
      time,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1,
    });
    const rt = new IndicatorRuntime({ registry: registry() });
    rt.add({ id: 'z', type: 'toy-zigzag', inputs: { deviation: 1 } });
    rt.add({
      id: 'ma',
      type: 'sma',
      inputs: { length: 2, source: { instanceId: 'z', outputId: 'zz' } },
    });
    const closes = [100, 102, 103];
    rt.setBars({
      time: Float64Array.from(closes, (_, i) => i),
      open: Float64Array.from(closes),
      high: Float64Array.from(closes),
      low: Float64Array.from(closes),
      close: Float64Array.from(closes),
      volume: Float64Array.from(closes, () => 1),
    });
    const fromOf = (cs: Change[], id: string) => cs.find((c) => c.id === id)?.from;
    // Update right after a full compute: the last bar's own retro writes are undone too.
    let cs = rt.updateBar(2, at(2, 101.5));
    expect(fromOf(cs, 'z')).toBe(1);
    expect(rt.result('z')!.values.zz![1]).toBe(102);
    expect(rt.result('z')!.values.zz![2]).toBeNaN();
    cs = rt.updateBar(2, at(2, 103));
    expect(fromOf(cs, 'z')).toBe(1);
    expect(rt.result('z')!.values.zz![1]).toBeNaN();
    // Append: the pivot at bar 2 moves to bar 3; `ext` of bar 2 is cleared.
    cs = rt.updateBar(3, at(3, 104));
    expect(fromOf(cs, 'z')).toBe(2);
    expect(fromOf(cs, 'ma')).toBe(0); // dependents recompute fully from a past change
    expect(rt.result('z')!.values.zz![2]).toBeNaN();
    expect(rt.result('z')!.values.zz![3]).toBe(104);
    // Tick back: the pivot returns to bar 2 (undo of the move).
    cs = rt.updateBar(3, at(3, 102.5));
    expect(fromOf(cs, 'z')).toBe(2);
    expect(rt.result('z')!.values.zz![2]).toBe(103);
    expect(rt.result('z')!.values.ext![2]).toBeNaN();
    // Tick that moves nothing in the past: only the last bar changed.
    cs = rt.updateBar(3, at(3, 102.6));
    expect(fromOf(cs, 'z')).toBe(3);
    expect(fromOf(cs, 'ma')).toBe(3);
    // Reversal adds a pivot at the last bar: no past change.
    cs = rt.updateBar(3, at(3, 101));
    expect(fromOf(cs, 'z')).toBe(3);
    expect(rt.result('z')!.colors.zz![3]).toBe(1);
    // And forward again past the old pivot: moves it (from = 2).
    cs = rt.updateBar(3, at(3, 105));
    expect(fromOf(cs, 'z')).toBe(2);
    expect(rt.result('z')!.colors.zz![3]).toBe(0);
  });

  it('IndicatorInstance.computeLast returns n - 1 for non-repainting ticks', () => {
    const inst = new IndicatorInstance(TOY);
    const store = new BarStore();
    store.setAll(sliceBars(bars, 0, 100));
    inst.computeAll(store);
    store.setBar(99, { ...barAt(bars, 99) });
    expect(inst.computeLast(store, 'update')).toBe(99);
  });

  it('setAt requires repaints: true', () => {
    const { repaints: _, ...rest } = TOY;
    const bad = { ...rest, id: 'bad' };
    const r = new IndicatorRegistry();
    r.register(bad);
    const rt = new IndicatorRuntime({ registry: r });
    rt.add({ id: 'b', type: 'bad' });
    rt.setBars(sliceBars(bars, 0, 50));
    expect(rt.status('b')).toEqual({
      state: 'error',
      message: 'bad: setAt() requires "repaints: true"',
    });
  });

  it('rejects repaints together with a timeframe input', () => {
    expect(() =>
      validateDefinition({
        ...TOY,
        inputs: { ...TOY.inputs, timeframe: { kind: 'timeframe', label: 'TF', default: '' } },
      }),
    ).toThrow(/cannot have a timeframe input/);
  });
});
