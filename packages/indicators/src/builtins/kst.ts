import { defineIndicator } from '../registry';
import { COLOR } from './common';
import { rocAt } from './roc';

const GROUP = 'ROC / SMA Lengths';

/** Know Sure Thing: weighted sum of four smoothed ROCs, with an SMA signal. */
export const KST = defineIndicator({
  id: 'kst',
  name: 'Know Sure Thing',
  shortName: 'KST',
  category: 'momentum',
  keywords: ['kst', 'know sure thing', 'roc', 'oscillator'],
  overlay: false,
  precision: 2,
  inputs: {
    roc1: { kind: 'int', label: 'ROC Length #1', default: 10, min: 1, max: 4999, group: GROUP },
    roc2: { kind: 'int', label: 'ROC Length #2', default: 15, min: 1, max: 4999, group: GROUP },
    roc3: { kind: 'int', label: 'ROC Length #3', default: 20, min: 1, max: 4999, group: GROUP },
    roc4: { kind: 'int', label: 'ROC Length #4', default: 30, min: 1, max: 4999, group: GROUP },
    sma1: { kind: 'int', label: 'SMA Length #1', default: 10, min: 1, max: 5000, group: GROUP },
    sma2: { kind: 'int', label: 'SMA Length #2', default: 10, min: 1, max: 5000, group: GROUP },
    sma3: { kind: 'int', label: 'SMA Length #3', default: 10, min: 1, max: 5000, group: GROUP },
    sma4: { kind: 'int', label: 'SMA Length #4', default: 15, min: 1, max: 5000, group: GROUP },
    signal: { kind: 'int', label: 'Signal Line Length', default: 9, min: 1, max: 5000 },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero', value: 0, color: COLOR.levelMiddle },
    { type: 'plot', id: 'kst', title: 'KST', kind: 'line', color: '#0fb5c9' },
    { type: 'plot', id: 'signal', title: 'Signal', kind: 'line', color: '#e5484d' },
  ],
  setup({ inputs, ta }) {
    const rocs = [inputs.roc1, inputs.roc2, inputs.roc3, inputs.roc4];
    const smas = [inputs.sma1, inputs.sma2, inputs.sma3, inputs.sma4].map((n) => ta.sma(n));
    const signal = ta.sma(inputs.signal);
    return (c) => {
      let kst = 0;
      for (let k = 0; k < 4; k++) kst += (k + 1) * smas[k]!.update(rocAt(c.close, c.i, rocs[k]!));
      c.set('kst', kst);
      c.set('signal', signal.update(kst));
    };
  },
});
