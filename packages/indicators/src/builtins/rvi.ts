import { defineIndicator } from '../registry';

/**
 * Relative Vigor Index: sum of swma(close - open) over sum of swma(high - low),
 * signal = swma(rvi).
 */
export const RVI = defineIndicator({
  id: 'rvi',
  name: 'Relative Vigor Index',
  shortName: 'RVGI',
  category: 'momentum',
  keywords: ['rvi', 'rvgi', 'relative vigor', 'vigor', 'oscillator'],
  overlay: false,
  precision: 4,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 10, min: 1, max: 5000 },
  },
  outputs: [
    { type: 'plot', id: 'rvi', title: 'RVGI', kind: 'line', color: '#18a383' },
    { type: 'plot', id: 'signal', title: 'Signal', kind: 'line', color: '#e5484d' },
  ],
  setup({ inputs, ta }) {
    const swBody = ta.swma();
    const swRange = ta.swma();
    const num = ta.sum(inputs.length);
    const den = ta.sum(inputs.length);
    const swSignal = ta.swma();
    return (c) => {
      const i = c.i;
      const a = num.update(swBody.update(c.close[i]! - c.open[i]!));
      const b = den.update(swRange.update(c.high[i]! - c.low[i]!));
      const rvi = b === 0 ? NaN : a / b;
      c.set('rvi', rvi);
      c.set('signal', swSignal.update(rvi));
    };
  },
});
