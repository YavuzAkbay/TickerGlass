import { defineIndicator } from '../registry';
import { COLOR, change } from './common';
import { ergodicOf } from './smi-ergodic';

/** True Strength Index: 100 * double-smoothed change / double-smoothed |change|. */
export const TSI = defineIndicator({
  id: 'tsi',
  name: 'True Strength Index',
  shortName: 'TSI',
  category: 'momentum',
  keywords: ['tsi', 'true strength', 'oscillator'],
  overlay: false,
  precision: 2,
  inputs: {
    long: { kind: 'int', label: 'Long Length', default: 25, min: 1, max: 4999 },
    short: { kind: 'int', label: 'Short Length', default: 13, min: 1, max: 4999 },
    signal: { kind: 'int', label: 'Signal Length', default: 13, min: 1, max: 4999 },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero', value: 0, color: COLOR.level },
    { type: 'plot', id: 'tsi', title: 'True Strength Index', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'signal', title: 'Signal', kind: 'line', color: '#e91e63' },
  ],
  setup({ inputs, ta }) {
    const erg = ergodicOf(ta, inputs.long, inputs.short);
    const signal = ta.ema(inputs.signal);
    return (c) => {
      const tsi = 100 * erg.update(change(c.close, c.i));
      c.set('tsi', tsi);
      c.set('signal', signal.update(tsi));
    };
  },
});
