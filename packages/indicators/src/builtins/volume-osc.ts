import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Volume Oscillator: 100 * (ema(volume, short) - ema(volume, long)) / ema(volume, long). */
export const VOLUME_OSC = defineIndicator({
  id: 'volume-osc',
  name: 'Volume Oscillator',
  shortName: 'Volume Osc',
  category: 'volume',
  keywords: ['volume oscillator', 'pvo', 'volume', 'oscillator'],
  overlay: false,
  format: 'percent',
  inputs: {
    short: { kind: 'int', label: 'Short Length', default: 5, min: 1, max: 4999 },
    long: { kind: 'int', label: 'Long Length', default: 10, min: 1, max: 5000 },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero', value: 0, color: COLOR.level },
    { type: 'plot', id: 'osc', title: 'Volume Osc', kind: 'line', color: COLOR.blue },
  ],
  setup({ inputs, ta }) {
    const short = ta.ema(inputs.short);
    const long = ta.ema(inputs.long);
    return (c) => {
      const v = c.volume[c.i]!;
      const s = short.update(v);
      const l = long.update(v);
      c.set('osc', l === 0 ? NaN : (100 * (s - l)) / l);
    };
  },
});
