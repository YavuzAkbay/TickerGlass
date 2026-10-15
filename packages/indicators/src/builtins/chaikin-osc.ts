import { defineIndicator } from '../registry';
import { moneyFlowVolume } from './accdist';
import { COLOR } from './common';

/**
 * Chaikin Oscillator: ema(A/D, fast) - ema(A/D, slow), SMA-seeded (first value
 * at slow - 1; TA-Lib ADOSC seeds differently and agrees after warm-up).
 */
export const CHAIKIN_OSC = defineIndicator({
  id: 'chaikin-osc',
  name: 'Chaikin Oscillator',
  shortName: 'Chaikin Osc',
  category: 'volume',
  keywords: ['chaikin', 'oscillator', 'adosc', 'accumulation', 'distribution', 'volume'],
  overlay: false,
  format: 'volume',
  inputs: {
    fast: { kind: 'int', label: 'Fast Length', default: 3, min: 1, max: 2000 },
    slow: { kind: 'int', label: 'Slow Length', default: 10, min: 1, max: 2000 },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero', value: 0, color: COLOR.level },
    { type: 'plot', id: 'osc', title: 'Chaikin Oscillator', kind: 'line', color: COLOR.pink },
  ],
  setup({ inputs, ta }) {
    const ad = ta.cum();
    const fast = ta.ema(inputs.fast);
    const slow = ta.ema(inputs.slow);
    return (c) => {
      const x = ad.update(moneyFlowVolume(c));
      c.set('osc', fast.update(x) - slow.update(x));
    };
  },
});
