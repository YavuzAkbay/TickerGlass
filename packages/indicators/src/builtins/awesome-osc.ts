import { defineIndicator } from '../registry';

/** Columns palette of AO/AC: 0 rising (or first value), 1 falling or flat. */
export const AO_COLORS = ['#0fb5c9', '#DE6A4F'] as const;

/** Palette index from the bar-to-bar change (`diff <= 0` red, else green; NaN -> green). */
export function aoColor(diff: number): number {
  return diff <= 0 ? 1 : 0;
}

/** Awesome Oscillator: sma(hl2, 5) - sma(hl2, 34) as coloured columns. */
export const AWESOME_OSC = defineIndicator({
  id: 'awesome-osc',
  name: 'Awesome Oscillator',
  shortName: 'AO',
  category: 'momentum',
  keywords: ['ao', 'awesome oscillator', 'bill williams', 'oscillator'],
  overlay: false,
  inputs: {},
  outputs: [{ type: 'plot', id: 'ao', title: 'AO', kind: 'columns', color: AO_COLORS }],
  setup({ ta }) {
    const fast = ta.sma(5);
    const slow = ta.sma(34);
    return (c) => {
      const hl2 = (c.high[c.i]! + c.low[c.i]!) / 2;
      const ao = fast.update(hl2) - slow.update(hl2);
      c.set('ao', ao, aoColor(ao - c.get('ao', c.i - 1)));
    };
  },
});
