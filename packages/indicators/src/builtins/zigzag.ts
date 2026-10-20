import { defineIndicator } from '../registry';
import type { InputsSchema, StepContext, Ta } from '../types';
import { COLOR } from './common';

/** Retroactive writes of a ZigZag's pivots (see `zigZagPivots`). */
export interface ZigZagDraw<C> {
  /** A pivot was added or moved to bar j. */
  set(c: C, j: number, price: number, high: boolean): void;
  /** The last pivot at bar j moved away (to a later bar). */
  clear(c: C, j: number, high: boolean): void;
}

/** ZigZag state carried across bars (ta.vars). */
export interface ZigZagState {
  /** Direction of the last pivot: 1 high, -1 low, 0 none yet. */
  dir: number;
  /** Bar and price of the last pivot (-1 / NaN: none). */
  idx: number;
  price: number;
  /** Bar and price of the pivot before it (start of the last leg). */
  prevIdx: number;
  prevPrice: number;
}

type Bars = Pick<StepContext, 'i' | 'high' | 'low'>;

/**
 * ZigZag pivot test: the value `d` bars back if no newer bar of the
 * last `d` is strictly beyond it and no older bar of the `d` before it is
 * beyond or equal (so among equal extremes the oldest is the pivot); NaN
 * otherwise or before bar 2d. Unlike `ta.pivotHigh`/`pivotLow` (strict on both
 * sides), which pivots-hl keeps.
 */
function findPivot(src: ArrayLike<number>, i: number, d: number, high: boolean): number {
  if (i < 2 * d) return NaN;
  const p = src[i - d]!;
  if (Number.isNaN(p)) return NaN;
  for (let k = 0; k < d; k++) {
    const v = src[i - k]!;
    if (high ? v > p : v < p) return NaN;
  }
  for (let k = d + 1; k <= 2 * d; k++) {
    const v = src[i - k]!;
    if (high ? v >= p : v <= p) return NaN;
  }
  return p;
}

/**
 * ZigZag pivots: candidates
 * are pivot highs/lows over d = max(2, floor(depth / 2)) bars on each side
 * (`findPivot`), found d bars late. A candidate in the direction of the last
 * pivot that goes further moves that pivot; an opposite one at least
 * `deviation` % beyond the last pivot's price (a high above a low, a low below
 * a high) adds a new pivot; the first candidate always does. Each bar tries
 * the high candidate first, then the low one (`allowZigZagOnOneBar`, default
 * true), so one bar can hold a high and a low pivot. Must be created in
 * `setup`; `update` once per bar.
 */
export function zigZagPivots<C extends Bars>(ta: Ta, depth: number, draw: ZigZagDraw<C> | null) {
  const d = Math.max(2, Math.floor(depth / 2));
  const s: ZigZagState = ta.vars({ dir: 0, idx: -1, price: NaN, prevIdx: -1, prevPrice: NaN });

  const add = (c: C, j: number, price: number, dir: number) => {
    s.prevIdx = s.idx;
    s.prevPrice = s.price;
    s.dir = dir;
    s.idx = j;
    s.price = price;
    draw?.set(c, j, price, dir > 0);
  };

  const offer = (c: C, j: number, price: number, dir: number, deviation: number) => {
    if (s.dir === 0) add(c, j, price, dir);
    else if (s.dir === dir) {
      if (dir > 0 ? !(price > s.price) : !(price < s.price)) return;
      draw?.clear(c, s.idx, dir > 0);
      // Both pivots on one bar: the earlier one is visible again.
      if (s.prevIdx === s.idx) draw?.set(c, s.prevIdx, s.prevPrice, dir < 0);
      s.idx = j;
      s.price = price;
      draw?.set(c, j, price, dir > 0);
    } else {
      const dev = (100 * (price - s.price)) / Math.abs(s.price);
      if (dir > 0 ? dev >= deviation : dev <= -deviation) add(c, j, price, dir);
    }
  };

  return {
    state: s as Readonly<ZigZagState>,
    /** Feed bar `c.i`; `deviation` in % (NaN: no reversal can be confirmed). */
    update(c: C, deviation: number): void {
      const j = c.i - d;
      const h = findPivot(c.high, c.i, d, true);
      if (!Number.isNaN(h)) offer(c, j, h, 1, deviation);
      const l = findPivot(c.low, c.i, d, false);
      if (!Number.isNaN(l)) offer(c, j, l, -1, deviation);
    },
  };
}

/** What the ZigZag's pivot writer needs from its step context. */
type ZigZagCtx = Pick<
  StepContext<InputsSchema, 'zz' | 'hiLbl' | 'loLbl'>,
  'i' | 'high' | 'low' | 'setAt'
>;

/**
 * ZigZag: lines between confirmed swing pivots (see `zigZagPivots`), drawn as
 * a gap-connecting line through values at the pivot bars only, with optional
 * price labels. Pivots are found `floor(depth / 2)` bars late and the last one
 * moves while price extends it, so past values repaint. "Extend to last bar"
 * adds a provisional point at the last bar's close (cleared once a newer bar
 * exists). A bar holding both a high and a low pivot shows the newer (low) one
 * on the line (one value per bar) and both labels.
 */
export const ZIGZAG = defineIndicator({
  id: 'zigzag',
  name: 'Zig Zag',
  shortName: 'ZigZag',
  category: 'other',
  keywords: ['zigzag', 'zig zag', 'swing', 'pivot', 'reversal'],
  overlay: true,
  repaints: true,
  inputs: {
    deviation: {
      kind: 'float',
      label: 'Price deviation for reversals (%)',
      default: 5,
      min: 0.00001,
      max: 100,
      step: 0.5,
    },
    depth: { kind: 'int', label: 'Pivot legs', default: 10, min: 2, max: 500 },
    extendToLastBar: {
      kind: 'bool',
      label: 'Extend to last bar',
      default: true,
      hideInTitle: true,
    },
    showPrice: { kind: 'bool', label: 'Display reversal price', default: true, hideInTitle: true },
  },
  outputs: [
    {
      type: 'plot',
      id: 'zz',
      title: 'ZigZag',
      kind: 'line',
      color: COLOR.blue,
      lineWidth: 2,
      connectGaps: true,
      showLastValue: false,
    },
    {
      type: 'shape',
      id: 'hiLbl',
      title: 'High Label',
      shape: 'labelDown',
      location: 'absolute',
      color: COLOR.blue,
      textColor: '#ffffff',
      textFromValue: true,
    },
    {
      type: 'shape',
      id: 'loLbl',
      title: 'Low Label',
      shape: 'labelUp',
      location: 'absolute',
      color: COLOR.blue,
      textColor: '#ffffff',
      textFromValue: true,
    },
  ],
  setup({ inputs, ta }) {
    const labels = inputs.showPrice;
    const zz = zigZagPivots<ZigZagCtx>(ta, inputs.depth, {
      set(c, j, price, high) {
        c.setAt('zz', j, price);
        if (labels) c.setAt(high ? 'hiLbl' : 'loLbl', j, price);
      },
      clear(c, j, high) {
        c.setAt('zz', j, NaN);
        if (labels) c.setAt(high ? 'hiLbl' : 'loLbl', j, NaN);
      },
    });
    // Bar holding the provisional "extend to last bar" point (-1: none).
    const ext = ta.vars({ bar: -1 });
    return (c) => {
      // Pivots are confirmed >= 2 bars late, so this slot never holds one yet.
      if (ext.bar >= 0 && ext.bar < c.i) {
        c.setAt('zz', ext.bar, NaN);
        ext.bar = -1;
      }
      zz.update(c, inputs.deviation);
      if (inputs.extendToLastBar && c.isLast && zz.state.idx >= 0) {
        c.set('zz', c.close[c.i]!);
        ext.bar = c.i;
      }
    };
  },
});
