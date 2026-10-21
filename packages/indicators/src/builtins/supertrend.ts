import { defineIndicator } from '../registry';
import { trueRange } from './common';

const nz = (x: number) => (Number.isNaN(x) ? 0 : x);

/**
 * Supertrend (on hl2 with ATR). The first bar is
 * hidden (no prior bar to trail); the line is split into up/down plots.
 */
export const SUPERTREND = defineIndicator({
  id: 'supertrend',
  name: 'Supertrend',
  shortName: 'Supertrend',
  category: 'trend',
  keywords: ['supertrend', 'atr', 'trailing stop', 'trend'],
  overlay: true,
  inputs: {
    atrLength: { kind: 'int', label: 'ATR Length', default: 10, min: 1, max: 5000 },
    factor: { kind: 'float', label: 'Factor', default: 3, min: 0.01, step: 0.01 },
  },
  outputs: [
    { type: 'plot', id: 'up', title: 'Up Trend', kind: 'line', color: '#8bc34a' },
    { type: 'plot', id: 'down', title: 'Down Trend', kind: 'line', color: '#DE6A4F' },
    {
      type: 'plot',
      id: 'middle',
      title: 'Body Middle',
      kind: 'line',
      color: '#A39E8F',
      visible: false,
      showLastValue: false,
    },
    {
      type: 'fill',
      id: 'upFill',
      title: 'Uptrend Highlighter',
      between: ['middle', 'up'],
      color: 'rgba(139, 195, 74, 0.1)',
    },
    {
      type: 'fill',
      id: 'downFill',
      title: 'Downtrend Highlighter',
      between: ['middle', 'down'],
      color: 'rgba(222, 106, 79, 0.1)',
    },
  ],
  setup({ inputs, ta }) {
    const atr = ta.rma(inputs.atrLength);
    // Previous bar's final bands, supertrend and ATR.
    const st = ta.vars({ lower: NaN, upper: NaN, trend: NaN, atr: NaN });
    return (c) => {
      const i = c.i;
      const a = atr.update(trueRange(c, true));
      const src = (c.high[i]! + c.low[i]!) / 2;
      const close = c.close[i]!;
      const prevClose = i > 0 ? c.close[i - 1]! : NaN;
      const prevLower = nz(st.lower);
      const prevUpper = nz(st.upper);
      let lower = src - inputs.factor * a;
      let upper = src + inputs.factor * a;
      lower = lower > prevLower || prevClose < prevLower ? lower : prevLower;
      upper = upper < prevUpper || prevClose > prevUpper ? upper : prevUpper;
      let dir: number;
      if (Number.isNaN(st.atr)) dir = 1;
      else if (st.trend === prevUpper) dir = close > upper ? -1 : 1;
      else dir = close < lower ? 1 : -1;
      const trend = dir === -1 ? lower : upper;
      st.lower = lower;
      st.upper = upper;
      st.trend = trend;
      st.atr = a;
      if (i === 0) return;
      c.set(dir < 0 ? 'up' : 'down', trend);
      c.set('middle', (c.open[i]! + close) / 2);
    };
  },
});
