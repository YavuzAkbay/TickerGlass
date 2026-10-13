import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * Ichimoku Cloud. Values are unshifted; the leading spans are drawn
 * `displacement - 1` bars forward and the lagging span as many bars back
 * (reference convention), via plot offsets.
 */
export const ICHIMOKU = defineIndicator({
  id: 'ichimoku',
  name: 'Ichimoku Cloud',
  shortName: 'Ichimoku',
  category: 'trend',
  keywords: ['ichimoku', 'kinko hyo', 'cloud', 'kumo', 'tenkan', 'kijun', 'senkou', 'chikou'],
  overlay: true,
  inputs: {
    conversion: { kind: 'int', label: 'Conversion Line Length', default: 9, min: 1, max: 5000 },
    base: { kind: 'int', label: 'Base Line Length', default: 26, min: 1, max: 5000 },
    spanB: { kind: 'int', label: 'Leading Span B Length', default: 52, min: 1, max: 5000 },
    displacement: { kind: 'int', label: 'Lagging Span', default: 26, min: 1, max: 500 },
  },
  outputs: [
    { type: 'plot', id: 'conversion', title: 'Conversion Line', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'base', title: 'Base Line', kind: 'line', color: COLOR.red },
    {
      type: 'plot',
      id: 'lagging',
      title: 'Lagging Span',
      kind: 'line',
      color: '#43a047',
      offset: (inputs) => 1 - inputs.displacement,
    },
    {
      type: 'plot',
      id: 'spanA',
      title: 'Leading Span A',
      kind: 'line',
      color: '#a5d6a7',
      offset: (inputs) => inputs.displacement - 1,
    },
    {
      type: 'plot',
      id: 'spanB',
      title: 'Leading Span B',
      kind: 'line',
      color: '#ef9a9a',
      offset: (inputs) => inputs.displacement - 1,
    },
    {
      type: 'fill',
      id: 'cloud',
      title: 'Plots Background',
      between: ['spanA', 'spanB'],
      // 0: span A above span B (bullish), 1: otherwise.
      color: ['rgba(67, 160, 71, 0.1)', 'rgba(244, 67, 54, 0.1)'],
    },
  ],
  setup({ inputs, ta }) {
    const donchian = (n: number) => ({ hi: ta.highest(n), lo: ta.lowest(n) });
    const conv = donchian(inputs.conversion);
    const base = donchian(inputs.base);
    const spanB = donchian(inputs.spanB);
    return (c) => {
      const h = c.high[c.i]!;
      const l = c.low[c.i]!;
      const cv = (conv.hi.update(h) + conv.lo.update(l)) / 2;
      const bs = (base.hi.update(h) + base.lo.update(l)) / 2;
      const a = (cv + bs) / 2;
      const b = (spanB.hi.update(h) + spanB.lo.update(l)) / 2;
      c.set('conversion', cv);
      c.set('base', bs);
      c.set('lagging', c.close[c.i]!);
      c.set('spanA', a);
      c.set('spanB', b);
      c.setColor('cloud', a > b ? 0 : 1);
    };
  },
});
