import { defineIndicator } from '../registry';
import { moneyFlowVolume } from './accdist';
import { COLOR } from './common';

/** Chaikin Money Flow: sum of money flow volume / sum of volume over `length` bars. */
export const CMF = defineIndicator({
  id: 'cmf',
  name: 'Chaikin Money Flow',
  shortName: 'CMF',
  category: 'volume',
  keywords: ['cmf', 'chaikin', 'money flow', 'volume', 'accumulation'],
  overlay: false,
  precision: 3,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 20, min: 1, max: 2000 },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero', value: 0, color: COLOR.level },
    { type: 'plot', id: 'cmf', title: 'MF', kind: 'line', color: COLOR.green },
  ],
  setup({ inputs, ta }) {
    const flow = ta.sum(inputs.length);
    const vol = ta.sum(inputs.length);
    return (c) => {
      const f = flow.update(moneyFlowVolume(c));
      const v = vol.update(c.volume[c.i]!);
      c.set('cmf', v === 0 ? NaN : f / v);
    };
  },
});
