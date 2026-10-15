import { defineIndicator } from '../registry';
import { isPriceSource } from '../resolve';
import { COLOR } from './common';

/**
 * Correlation Coefficient: Pearson correlation of the chart's source with the
 * same price source of another symbol over the last `length` bars. Any bar
 * without a value in the window (either series) gives NaN.
 */
export const CORRELATION = defineIndicator({
  id: 'correlation',
  name: 'Correlation Coefficient',
  shortName: 'CC',
  category: 'other',
  keywords: ['correlation', 'cc', 'correl', 'pearson', 'compare', 'symbol'],
  overlay: false,
  precision: 2,
  scaleRange: { min: -1, max: 1 },
  inputs: {
    symbol: { kind: 'symbol', label: 'Symbol', default: 'GOOG' },
    source: { kind: 'source', label: 'Source', default: 'close' },
    length: { kind: 'int', label: 'Length', default: 20, min: 2, max: 5000 },
  },
  outputs: [
    { type: 'plot', id: 'cc', title: 'Correlation', kind: 'line', color: COLOR.blue },
    { type: 'hline', id: 'upper', title: 'Upper', value: 1, color: COLOR.level },
    { type: 'hline', id: 'middle', title: 'Middle', value: 0, color: COLOR.levelMiddle },
    { type: 'hline', id: 'lower', title: 'Lower', value: -1, color: COLOR.level },
  ],
  setup({ inputs, ta }) {
    const cor = ta.correlation(inputs.length);
    // ta.correlation skips NaN pairs; require `length` consecutive valid pairs.
    const st = ta.vars({ run: 0 });
    return (c) => {
      const x = c.src.source[c.i]!;
      // An indicator output as source has no external counterpart: use close.
      const key = isPriceSource(inputs.source) ? inputs.source : 'close';
      const y = c.ext.symbol[key][c.i]!;
      const v = cor.update(x, y);
      st.run = Number.isNaN(x) || Number.isNaN(y) ? 0 : st.run + 1;
      c.set('cc', st.run >= inputs.length ? v : NaN);
    };
  },
});
