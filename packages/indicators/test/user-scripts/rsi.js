/* global defineIndicator */
// Relative Strength Index (Wilder) with an optional smoothing MA or Bollinger Bands.
defineIndicator({
  id: 'my-rsi',
  name: 'My RSI',
  shortName: 'MyRSI',
  category: 'momentum',
  overlay: false,
  precision: 2,
  scaleRange: { min: 0, max: 100 },
  inputs: {
    length: { kind: 'int', label: 'RSI Length', default: 14, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    maType: {
      kind: 'enum',
      label: 'MA Type',
      options: ['SMA', 'Bollinger Bands', 'EMA', 'SMMA (RMA)', 'WMA', 'VWMA'],
      default: 'SMA',
    },
    maLength: { kind: 'int', label: 'MA Length', default: 14, min: 1, max: 5000 },
    bbMult: { kind: 'float', label: 'BB StdDev', default: 2, min: 0.001, max: 50, step: 0.5 },
  },
  outputs: [
    { type: 'hline', id: 'upper', title: 'Upper Band', value: 70, color: '#787b86' },
    {
      type: 'hline',
      id: 'middle',
      title: 'Middle Band',
      value: 50,
      color: 'rgba(120, 123, 134, 0.5)',
    },
    { type: 'hline', id: 'lower', title: 'Lower Band', value: 30, color: '#787b86' },
    {
      type: 'fill',
      id: 'zone',
      title: 'Background',
      between: ['upper', 'lower'],
      color: 'rgba(126, 87, 194, 0.1)',
    },
    { type: 'plot', id: 'rsi', title: 'RSI', kind: 'line', color: '#7e57c2' },
    { type: 'plot', id: 'ma', title: 'RSI-based MA', kind: 'line', color: '#ffeb3b' },
    { type: 'plot', id: 'bbUpper', title: 'Upper Bollinger Band', kind: 'line', color: 'green' },
    { type: 'plot', id: 'bbLower', title: 'Lower Bollinger Band', kind: 'line', color: 'green' },
  ],
  setup({ inputs, ta }) {
    const diff = ta.change();
    const avgGain = ta.rma(inputs.length);
    const avgLoss = ta.rma(inputs.length);

    const bands = inputs.maType === 'Bollinger Bands';
    const n = inputs.maLength;
    let smooth;
    switch (inputs.maType) {
      case 'EMA':
        smooth = ta.ema(n);
        break;
      case 'SMMA (RMA)':
        smooth = ta.rma(n);
        break;
      case 'WMA':
        smooth = ta.wma(n);
        break;
      case 'VWMA':
        smooth = ta.vwma(n);
        break;
      default:
        smooth = ta.sma(n); // SMA and the Bollinger Bands basis
    }
    const sd = bands ? ta.stdev(n) : null;

    return (c) => {
      const ch = diff.update(c.src.source[c.i]);
      const up = avgGain.update(Math.max(ch, 0));
      const down = avgLoss.update(-Math.min(ch, 0));
      const rsi = down === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / down);
      const ma = smooth.update(rsi, c.volume[c.i]);
      c.set('rsi', rsi);
      c.set('ma', ma);
      if (sd) {
        const width = inputs.bbMult * sd.update(rsi);
        c.set('bbUpper', ma + width);
        c.set('bbLower', ma - width);
      }
    };
  },
});
