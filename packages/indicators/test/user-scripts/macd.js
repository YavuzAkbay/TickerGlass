/* global defineIndicator, NO_COLOR */
// MACD with a four-colour histogram (grow/fall above/below zero).
defineIndicator({
  id: 'my-macd',
  name: 'My MACD',
  shortName: 'MyMACD',
  category: 'momentum',
  overlay: false,
  inputs: {
    fast: { kind: 'int', label: 'Fast Length', default: 12, min: 1 },
    slow: { kind: 'int', label: 'Slow Length', default: 26, min: 1 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    signal: { kind: 'int', label: 'Signal Smoothing', default: 9, min: 1, max: 50 },
    oscMa: { kind: 'enum', label: 'Oscillator MA Type', options: ['SMA', 'EMA'], default: 'EMA' },
    signalMa: {
      kind: 'enum',
      label: 'Signal Line MA Type',
      options: ['SMA', 'EMA'],
      default: 'EMA',
    },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero Line', value: 0, color: 'rgba(120, 123, 134, 0.5)' },
    {
      type: 'plot',
      id: 'hist',
      title: 'Histogram',
      kind: 'columns',
      color: ['#7fb069', '#b2dfdb', '#ffcdd2', '#de6a4f'],
    },
    { type: 'plot', id: 'macd', title: 'MACD', kind: 'line', color: '#6e9bd6' },
    { type: 'plot', id: 'signal', title: 'Signal', kind: 'line', color: '#e0a93b' },
  ],
  setup({ inputs, ta }) {
    const GROW_ABOVE = 0;
    const FALL_ABOVE = 1;
    const GROW_BELOW = 2;
    const FALL_BELOW = 3;
    const fastMa = inputs.oscMa === 'SMA' ? ta.sma(inputs.fast) : ta.ema(inputs.fast);
    const slowMa = inputs.oscMa === 'SMA' ? ta.sma(inputs.slow) : ta.ema(inputs.slow);
    const signalMa = inputs.signalMa === 'SMA' ? ta.sma(inputs.signal) : ta.ema(inputs.signal);

    return (c) => {
      const x = c.src.source[c.i];
      const macd = fastMa.update(x) - slowMa.update(x);
      const signal = signalMa.update(macd);
      const hist = macd - signal;
      const prev = c.i > 0 ? c.get('hist', c.i - 1) : NaN;
      let color;
      if (Number.isNaN(hist)) color = NO_COLOR;
      else if (hist >= 0) color = prev < hist ? GROW_ABOVE : FALL_ABOVE;
      else color = prev < hist ? GROW_BELOW : FALL_BELOW;
      c.set('hist', hist, color);
      c.set('macd', macd);
      c.set('signal', signal);
    };
  },
});
