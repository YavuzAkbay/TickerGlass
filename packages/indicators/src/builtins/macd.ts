import { defineIndicator } from '../registry';
import { COLOR } from './common';

const OSC_MA = ['SMA', 'EMA'] as const;

/** Moving Average Convergence Divergence with a 4-colour histogram. */
export const MACD = defineIndicator({
  id: 'macd',
  name: 'Moving Average Convergence Divergence',
  shortName: 'MACD',
  category: 'momentum',
  keywords: ['macd', 'convergence', 'divergence', 'histogram', 'oscillator'],
  overlay: false,
  inputs: {
    fast: { kind: 'int', label: 'Fast Length', default: 12, min: 1, max: 5000 },
    slow: { kind: 'int', label: 'Slow Length', default: 26, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    signal: { kind: 'int', label: 'Signal Smoothing', default: 9, min: 1, max: 50 },
    oscMa: { kind: 'enum', label: 'Oscillator MA Type', options: OSC_MA, default: 'EMA' },
    signalMa: { kind: 'enum', label: 'Signal Line MA Type', options: OSC_MA, default: 'EMA' },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero Line', value: 0, color: COLOR.levelMiddle },
    {
      type: 'plot',
      id: 'hist',
      title: 'Histogram',
      kind: 'columns',
      // grow above, fall above, grow below, fall below
      color: ['#18a383', '#8cd1c1', '#f2b0b2', '#e5484d'],
    },
    { type: 'plot', id: 'macd', title: 'MACD', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'signal', title: 'Signal', kind: 'line', color: COLOR.orange },
  ],
  setup({ inputs, ta }) {
    const ma = (type: (typeof OSC_MA)[number], n: number) =>
      type === 'SMA' ? ta.sma(n) : ta.ema(n);
    const fast = ma(inputs.oscMa, inputs.fast);
    const slow = ma(inputs.oscMa, inputs.slow);
    const signal = ma(inputs.signalMa, inputs.signal);
    return (c) => {
      const x = c.src.source[c.i]!;
      const macd = fast.update(x) - slow.update(x);
      const sig = signal.update(macd);
      const hist = macd - sig;
      const rising = c.get('hist', c.i - 1) < hist;
      c.set('hist', hist, hist >= 0 ? (rising ? 0 : 1) : rising ? 2 : 3);
      c.set('macd', macd);
      c.set('signal', sig);
    };
  },
});
