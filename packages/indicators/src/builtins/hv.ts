import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * Historical Volatility: annualised population stdev of log returns,
 * 100 * stdev(ln(close / close[1])) * sqrt(365 / per). per = 1 on intraday
 * and 1D bars (or an unknown interval), 7 on longer intervals.
 */
export const HV = defineIndicator({
  id: 'hv',
  name: 'Historical Volatility',
  shortName: 'HV',
  category: 'volatility',
  keywords: ['hv', 'historical volatility', 'volatility', 'stdev', 'log return'],
  overlay: false,
  format: 'percent',
  precision: 2,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 10, min: 1, max: 5000 },
  },
  outputs: [{ type: 'plot', id: 'hv', title: 'HV', kind: 'line', color: COLOR.blue }],
  setup({ inputs, ta, env }) {
    const sd = ta.stdev(inputs.length);
    const per = env.intervalSeconds > 86_400 ? 7 : 1;
    const annual = Math.sqrt(365 / per);
    return (c) => {
      const i = c.i;
      const r = i > 0 ? Math.log(c.close[i]! / c.close[i - 1]!) : NaN;
      c.set('hv', 100 * sd.update(r) * annual);
    };
  },
});
