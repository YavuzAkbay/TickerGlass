import { defineIndicator } from '../registry';
import { trueRange } from './common';
import { zigZagPivots } from './zigzag';

/**
 * Fibonacci levels: output id, bool input key, ratio, default on, colour
 * (conventional defaults). Ids and keys never change.
 */
const LEVELS = [
  { id: 'l0', show: 'show0', ratio: 0, on: true, color: '#787b86' },
  { id: 'l236', show: 'show236', ratio: 0.236, on: true, color: '#f44336' },
  { id: 'l382', show: 'show382', ratio: 0.382, on: true, color: '#81c784' },
  { id: 'l500', show: 'show500', ratio: 0.5, on: true, color: '#4caf50' },
  { id: 'l618', show: 'show618', ratio: 0.618, on: true, color: '#009688' },
  { id: 'l786', show: 'show786', ratio: 0.786, on: true, color: '#64b5f6' },
  { id: 'l1000', show: 'show1000', ratio: 1, on: true, color: '#787b86' },
  { id: 'l1618', show: 'show1618', ratio: 1.618, on: false, color: '#2962ff' },
  { id: 'l2618', show: 'show2618', ratio: 2.618, on: false, color: '#f44336' },
  { id: 'l3618', show: 'show3618', ratio: 3.618, on: false, color: '#9c27b0' },
  { id: 'l4236', show: 'show4236', ratio: 4.236, on: false, color: '#e91e63' },
] as const;
type LevelId = (typeof LEVELS)[number]['id'];
type ShowKey = (typeof LEVELS)[number]['show'];

const LEVEL_INPUTS = Object.fromEntries(
  LEVELS.map((lv) => [
    lv.show,
    { kind: 'bool', label: String(lv.ratio), default: lv.on, group: 'Levels', hideInTitle: true },
  ]),
) as Record<ShowKey, { kind: 'bool'; label: string; default: boolean; group: string; hideInTitle: true }>;

const ATR_LENGTH = 10;

/**
 * Swing Fibonacci: Fibonacci levels of the last ZigZag leg (see
 * `zigZagPivots`), whose reversal threshold is `deviation` times the ATR(10)
 * as a percentage of the close. Level r is at end + (start - end) * r with
 * start/end the leg's first/last pivot (swapped by "Reverse"), drawn as step
 * lines from the leg's start bar to the last bar. Only the last bar draws, so
 * the whole picture repaints as pivots move or new ones are confirmed.
 */
export const SWING_FIB = defineIndicator({
  id: 'swing-fib',
  name: 'Swing Fibonacci',
  shortName: 'Swing Fib',
  category: 'other',
  keywords: ['fib', 'fibonacci', 'retracement', 'auto', 'zigzag', 'levels'],
  overlay: true,
  repaints: true,
  inputs: {
    deviation: { kind: 'float', label: 'Deviation', default: 3, min: 0.00001, step: 0.5 },
    depth: { kind: 'int', label: 'Depth', default: 10, min: 2, max: 500 },
    reverse: { kind: 'bool', label: 'Reverse', default: false, hideInTitle: true },
    ...LEVEL_INPUTS,
  },
  outputs: LEVELS.map(
    (lv) =>
      ({
        type: 'plot',
        id: lv.id,
        title: String(lv.ratio),
        kind: 'step',
        color: lv.color,
        showLastValue: true,
      }) as const,
  ),
  setup({ inputs, ta }) {
    const atr = ta.rma(ATR_LENGTH);
    const zz = zigZagPivots(ta, inputs.depth, null);
    const shown = LEVELS.filter((lv) => inputs[lv.show]);
    // Bars drawn by the last bar's previous run ([-1, -1]: none).
    const drawn = ta.vars({ from: -1, to: -1 });
    return (c) => {
      const i = c.i;
      const a = atr.update(trueRange(c, true));
      zz.update(c, ((100 * a) / c.close[i]!) * inputs.deviation);
      if (!c.isLast) return;
      /** Write bar j unless it already holds v (keeps the tick's undo log small). */
      const put = (id: LevelId, j: number, v: number) => {
        if (j === i) c.set(id, v);
        else if (!Object.is(c.get(id, j), v)) c.setAt(id, j, v);
      };
      const s = zz.state;
      const start = s.prevIdx >= 0 ? s.prevIdx : i + 1;
      // Clear what an earlier run drew outside the new range (it always reaches bar i).
      for (let j = drawn.from; j >= 0 && j <= Math.min(drawn.to, start - 1); j++)
        for (const lv of shown) put(lv.id, j, NaN);
      drawn.from = -1;
      drawn.to = -1;
      if (start > i) return;
      const startPrice = inputs.reverse ? s.price : s.prevPrice;
      const endPrice = inputs.reverse ? s.prevPrice : s.price;
      for (const lv of shown) {
        const v = endPrice + (startPrice - endPrice) * lv.ratio;
        for (let j = start; j <= i; j++) put(lv.id, j, v);
      }
      drawn.from = start;
      drawn.to = i;
    };
  },
});
