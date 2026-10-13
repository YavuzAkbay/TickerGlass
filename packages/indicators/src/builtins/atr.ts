import { defineIndicator } from '../registry';
import { COLOR, trueRange } from './common';

const SMOOTHING = ['RMA', 'SMA', 'EMA', 'WMA'] as const;

/** Average True Range: moving average of `ta.tr(true)` (first bar: high - low). */
export const ATR = defineIndicator({
  id: 'atr',
  name: 'Average True Range',
  shortName: 'ATR',
  category: 'volatility',
  keywords: ['atr', 'average true range', 'volatility', 'true range'],
  overlay: false,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 14, min: 1, max: 5000 },
    smoothing: { kind: 'enum', label: 'Smoothing', options: SMOOTHING, default: 'RMA' },
  },
  outputs: [{ type: 'plot', id: 'atr', title: 'ATR', kind: 'line', color: COLOR.red }],
  setup({ inputs, ta }) {
    const n = inputs.length;
    const s = inputs.smoothing;
    const ma =
      s === 'SMA' ? ta.sma(n) : s === 'EMA' ? ta.ema(n) : s === 'WMA' ? ta.wma(n) : ta.rma(n);
    return (c) => c.set('atr', ma.update(trueRange(c, true)));
  },
});
