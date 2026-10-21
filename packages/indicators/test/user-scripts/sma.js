/* global defineIndicator */
// Simple moving average of a price source.
defineIndicator({
  id: 'my-sma',
  name: 'My Simple Moving Average',
  shortName: 'MySMA',
  category: 'movingAverage',
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 9, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'ma', title: 'MA', kind: 'line', color: '#6e9bd6' }],
  setup({ inputs, ta }) {
    const avg = ta.sma(inputs.length);
    return (c) => {
      c.set('ma', avg.update(c.src.source[c.i]));
    };
  },
});
