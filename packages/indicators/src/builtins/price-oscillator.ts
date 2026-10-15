import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Price Oscillator (PPO): 100 * (ma(short) - ma(long)) / ma(long), SMA or EMA. */
export const PRICE_OSCILLATOR = defineIndicator({
  id: 'price-oscillator',
  name: 'Price Oscillator',
  shortName: 'PPO',
  category: 'momentum',
  keywords: ['ppo', 'apo', 'price oscillator', 'percentage', 'oscillator'],
  overlay: false,
  format: 'percent',
  precision: 2,
  inputs: {
    short: { kind: 'int', label: 'Short Length', default: 10, min: 1, max: 5000 },
    long: { kind: 'int', label: 'Long Length', default: 21, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    exponential: { kind: 'bool', label: 'Use exponential MA', default: false },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero Line', value: 0, color: COLOR.level },
    { type: 'plot', id: 'po', title: 'Price Oscillator', kind: 'line', color: '#089981' },
  ],
  setup({ inputs, ta }) {
    const ma = (n: number) => (inputs.exponential ? ta.ema(n) : ta.sma(n));
    const short = ma(inputs.short);
    const long = ma(inputs.long);
    return (c) => {
      const x = c.src.source[c.i]!;
      const s = short.update(x);
      const l = long.update(x);
      c.set('po', l === 0 ? NaN : (100 * (s - l)) / l);
    };
  },
});
