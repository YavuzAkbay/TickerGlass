import { defineIndicator } from '../registry';
import { AO_COLORS, aoColor } from './awesome-osc';

/** Accelerator Oscillator: AO - sma(AO, 5) as coloured columns. */
export const ACCELERATOR_OSC = defineIndicator({
  id: 'accelerator-osc',
  name: 'Accelerator Oscillator',
  shortName: 'AC',
  category: 'momentum',
  keywords: ['ac', 'accelerator oscillator', 'bill williams', 'awesome', 'oscillator'],
  overlay: false,
  inputs: {},
  outputs: [{ type: 'plot', id: 'ac', title: 'AC', kind: 'columns', color: AO_COLORS }],
  setup({ ta }) {
    const fast = ta.sma(5);
    const slow = ta.sma(34);
    const signal = ta.sma(5);
    return (c) => {
      const hl2 = (c.high[c.i]! + c.low[c.i]!) / 2;
      const ao = fast.update(hl2) - slow.update(hl2);
      const ac = ao - signal.update(ao);
      c.set('ac', ac, aoColor(ac - c.get('ac', c.i - 1)));
    };
  },
});
