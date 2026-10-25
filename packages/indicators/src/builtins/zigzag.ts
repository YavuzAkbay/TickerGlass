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
 * sides), which swing-hl keeps.
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
 * moves while price extends it, so past values repaint.
 *
 * A pivot only counts as confirmed once price has moved `deviation` % against
 * it (fallen that far below a pivot high, or risen that far above a pivot
 * low). Until then the last pivot stays hidden: the leg in progress is drawn
 * as a dashed forecast line from the previous pivot to the furthest extreme
 * reached since, extending bar by bar until the reversal confirms the pivot
 * (or a further extreme takes over the leg). "Extend to last bar" continues
 * the dashed line to the last bar's close. A bar holding both a high and a
 * low pivot shows the newer (low) one on the line (one value per bar) and
 * both labels.
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
      type: 'plot',
      id: 'zzf',
      title: 'Forecast',
      kind: 'line',
      color: COLOR.blue,
      lineWidth: 2,
      lineStyle: 'dashed',
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
    const dev = inputs.deviation;
    // Running low/high of the current pivot's reversal window [idx..i]: the
    // pivot is confirmed once the opposite extreme is `deviation` % away.
    const rev = ta.vars({ lo: Infinity, hi: -Infinity });
    // The last pivot whose vertex and label are hidden (not confirmed yet).
    // `high` is 1 for a pivot high, 0 for a low.
    const hid = ta.vars({ bar: -1, price: NaN, high: 0 });
    // Bars the previous last bar's forecast leg wrote, for cleanup.
    const fz = ta.vars({ start: -1, end: -1, tail: -1, lblBar: -1, lblHigh: 0 });

    const zz = zigZagPivots<ZigZagCtx>(ta, inputs.depth, {
      set(c, j, price, high) {
        c.setAt('zz', j, price);
        if (labels) c.setAt(high ? 'hiLbl' : 'loLbl', j, price);
        rev.lo = Infinity;
        rev.hi = -Infinity;
        for (let k = j; k <= c.i; k++) {
          if (c.low[k]! < rev.lo) rev.lo = c.low[k]!;
          if (c.high[k]! > rev.hi) rev.hi = c.high[k]!;
        }
      },
      clear(c, j, high) {
        c.setAt('zz', j, NaN);
        if (labels) c.setAt(high ? 'hiLbl' : 'loLbl', j, NaN);
      },
    });

    return (c) => {
      // Drop what the previous last bar drew (its writes are committed now).
      if (fz.start >= 0 && fz.start < c.i) {
        c.setAt('zzf', fz.start, NaN);
        fz.start = -1;
      }
      if (fz.end >= 0 && fz.end < c.i) {
        c.setAt('zzf', fz.end, NaN);
        fz.end = -1;
      }
      if (fz.tail >= 0 && fz.tail < c.i) {
        c.setAt('zzf', fz.tail, NaN);
        fz.tail = -1;
      }
      if (fz.lblBar >= 0 && fz.lblBar < c.i) {
        c.setAt(fz.lblHigh ? 'hiLbl' : 'loLbl', fz.lblBar, NaN);
        fz.lblBar = -1;
      }

      zz.update(c, dev);

      const st = zz.state;
      if (st.idx >= 0) {
        if (c.low[c.i]! < rev.lo) rev.lo = c.low[c.i]!;
        if (c.high[c.i]! > rev.hi) rev.hi = c.high[c.i]!;
        const move = (100 * ((st.dir > 0 ? rev.lo : rev.hi) - st.price)) / Math.abs(st.price);
        const confirmed = st.dir > 0 ? move <= -dev : move >= dev;

        if (hid.bar >= 0) {
          // The hidden pivot is proven by its own reversal arriving, or by
          // the pivot added after it (that one moved `deviation` % beyond it).
          const proven =
            (hid.bar === st.idx &&
              hid.price === st.price &&
              hid.high === (st.dir > 0 ? 1 : 0) &&
              confirmed) ||
            (hid.bar === st.prevIdx &&
              hid.price === st.prevPrice &&
              hid.high === (st.dir < 0 ? 1 : 0));
          if (proven) {
            c.setAt('zz', hid.bar, hid.price);
            if (labels) c.setAt(hid.high ? 'hiLbl' : 'loLbl', hid.bar, hid.price);
            hid.bar = -1;
          } else if (hid.bar !== st.idx) {
            // It moved away or was replaced: its bar stays as the core left it.
            hid.bar = -1;
          }
        }
        if (!confirmed && st.prevIdx >= 0) {
          // Unconfirmed: hide the pivot; the forecast leg starts at the
          // previous one instead.
          if (hid.bar !== st.idx) {
            c.setAt('zz', st.idx, NaN);
            if (labels) c.setAt(st.dir > 0 ? 'hiLbl' : 'loLbl', st.idx, NaN);
          }
          hid.bar = st.idx;
          hid.price = st.price;
          hid.high = st.dir > 0 ? 1 : 0;
        }

        if (c.isLast) {
          // Dashed forecast leg: from the last confirmed pivot to the furthest
          // extreme reached since (oldest bar wins ties), whatever price does
          // in between. Once that extreme is behind the last bar, "Extend to
          // last bar" continues the line to the last close.
          const usePrev = !confirmed && st.prevIdx >= 0;
          const startBar = usePrev ? st.prevIdx : st.idx;
          const startPrice = usePrev ? st.prevPrice : st.price;
          const up = usePrev ? st.dir > 0 : st.dir < 0;
          let endBar = -1;
          let endPrice = up ? -Infinity : Infinity;
          for (let k = startBar + 1; k <= c.i; k++) {
            const v = up ? c.high[k]! : c.low[k]!;
            if (up ? v > endPrice : v < endPrice) {
              endPrice = v;
              endBar = k;
            }
          }
          if (endBar >= 0) {
            c.setAt('zzf', startBar, startPrice);
            c.setAt('zzf', endBar, endPrice);
            fz.start = startBar;
            fz.end = endBar;
            fz.tail = -1;
            fz.lblBar = -1;
            if (inputs.extendToLastBar && endBar < c.i) {
              c.set('zzf', c.close[c.i]!);
              fz.tail = c.i;
            }
            if (labels) {
              c.setAt(up ? 'hiLbl' : 'loLbl', endBar, endPrice);
              fz.lblBar = endBar;
              fz.lblHigh = up ? 1 : 0;
            }
          }
        }
      }
    };
  },
});
