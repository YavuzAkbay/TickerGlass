import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Parabolic SAR, a bar-by-bar implementation of the standard recursion. */
export const PARABOLIC_SAR = defineIndicator({
  id: 'parabolic-sar',
  name: 'Parabolic SAR',
  shortName: 'SAR',
  category: 'trend',
  keywords: ['sar', 'parabolic', 'stop and reverse', 'trailing stop'],
  overlay: true,
  inputs: {
    start: { kind: 'float', label: 'Start', default: 0.02, min: 0, step: 0.01 },
    increment: { kind: 'float', label: 'Increment', default: 0.02, min: 0, step: 0.01 },
    max: { kind: 'float', label: 'Max Value', default: 0.2, min: 0, step: 0.01 },
  },
  outputs: [{ type: 'plot', id: 'sar', title: 'ParabolicSAR', kind: 'cross', color: COLOR.blue }],
  setup({ inputs, ta }) {
    const { start, increment, max } = inputs;
    // below: 1 when the SAR is below price (uptrend).
    const st = ta.vars({ result: NaN, maxMin: NaN, acc: NaN, below: 0 });
    return (c) => {
      const i = c.i;
      if (i === 0) return; // NaN on the first bar, no state change.
      const high = c.high[i]!;
      const low = c.low[i]!;
      let first = false;
      if (i === 1) {
        if (c.close[1]! > c.close[0]!) {
          st.below = 1;
          st.maxMin = high;
          st.result = c.low[0]!;
        } else {
          st.below = 0;
          st.maxMin = low;
          st.result = c.high[0]!;
        }
        first = true;
        st.acc = start;
      }
      st.result += st.acc * (st.maxMin - st.result);
      if (st.below) {
        if (st.result > low) {
          first = true;
          st.below = 0;
          st.result = Math.max(high, st.maxMin);
          st.maxMin = low;
          st.acc = start;
        }
      } else if (st.result < high) {
        first = true;
        st.below = 1;
        st.result = Math.min(low, st.maxMin);
        st.maxMin = high;
        st.acc = start;
      }
      if (!first) {
        if (st.below) {
          if (high > st.maxMin) {
            st.maxMin = high;
            st.acc = Math.min(st.acc + increment, max);
          }
        } else if (low < st.maxMin) {
          st.maxMin = low;
          st.acc = Math.min(st.acc + increment, max);
        }
      }
      if (st.below) {
        st.result = Math.min(st.result, c.low[i - 1]!);
        if (i > 1) st.result = Math.min(st.result, c.low[i - 2]!);
      } else {
        st.result = Math.max(st.result, c.high[i - 1]!);
        if (i > 1) st.result = Math.max(st.result, c.high[i - 2]!);
      }
      c.set('sar', st.result);
    };
  },
});
