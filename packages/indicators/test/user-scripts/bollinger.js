/* global defineIndicator */
// Bollinger Bands: MA basis +- mult * population standard deviation, filled between the bands.
defineIndicator({
  id: 'my-bb',
  name: 'My Bollinger Bands',
  shortName: 'MyBB',
  category: 'bands',
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 20, min: 1, max: 5000 },
    maType: {
      kind: 'enum',
      label: 'Basis MA Type',
      options: ['SMA', 'EMA', 'SMMA (RMA)', 'WMA', 'VWMA'],
      default: 'SMA',
    },
    source: { kind: 'source', label: 'Source', default: 'close' },
    mult: { kind: 'float', label: 'StdDev', default: 2, min: 0.001, max: 50, step: 0.1 },
  },
  outputs: [
    { type: 'plot', id: 'basis', title: 'Basis', kind: 'line', color: '#ff6d00' },
    { type: 'plot', id: 'upper', title: 'Upper', kind: 'line', color: '#2962ff' },
    { type: 'plot', id: 'lower', title: 'Lower', kind: 'line', color: '#2962ff' },
    {
      type: 'fill',
      id: 'band',
      title: 'Background',
      between: ['upper', 'lower'],
      color: 'rgba(33, 150, 243, 0.05)',
    },
  ],
  setup({ inputs, ta }) {
    const makers = {
      SMA: ta.sma,
      EMA: ta.ema,
      'SMMA (RMA)': ta.rma,
      WMA: ta.wma,
      VWMA: ta.vwma,
    };
    const basisMa = makers[inputs.maType].call(ta, inputs.length);
    const sd = ta.stdev(inputs.length);
    return (c) => {
      const x = c.src.source[c.i];
      const basis = basisMa.update(x, c.volume[c.i]);
      const dev = inputs.mult * sd.update(x);
      c.set('basis', basis);
      c.set('upper', basis + dev);
      c.set('lower', basis - dev);
    };
  },
});
