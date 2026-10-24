import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import {
  PERIOD_INPUT,
  ROW,
  requireSeries,
  series,
  statementsOf,
  trailingTwelveMonths,
  valueAt,
  type Series,
} from './common';

/**
 * Free cash flow per fiscal period: the reported row when the provider has
 * one, otherwise operating cash flow less capital expenditure.
 */
export const FREE_CASH_FLOW = defineIndicator({
  id: 'fin-fcf',
  name: 'Free Cash Flow',
  shortName: 'FCF',
  category: 'financials',
  keywords: ['free cash flow', 'fcf', 'cash flow', 'capex', 'financials'],
  overlay: false,
  format: 'volume',
  usesFundamentals: true,
  inputs: {
    period: PERIOD_INPUT,
    ttm: { kind: 'bool', label: 'TTM', default: true, hideInTitle: true },
  },
  outputs: [
    { type: 'plot', id: 'fcf', title: 'Free Cash Flow', kind: 'step', color: COLOR.green },
    { type: 'plot', id: 'ttm', title: 'TTM', kind: 'step', color: COLOR.orange },
  ],
  setup({ inputs, env }) {
    const stmts = statementsOf(env.fundamentals, inputs.period);
    const reported = series(stmts?.cashflow, ROW.fcf);
    let fcf: Series;
    if (reported) fcf = reported;
    else {
      const ocf = requireSeries(
        env.fundamentals,
        inputs.period,
        'cashflow',
        ROW.ocf,
        'operating cash flow',
      );
      const capex = requireSeries(env.fundamentals, inputs.period, 'cashflow', ROW.capex, 'capital expenditure');
      fcf = {
        periods: ocf.periods,
        values: ocf.values.map((v, k) => {
          const cx = valueAt(capex, ocf.periods[k]!);
          return Number.isFinite(v) && Number.isFinite(cx) ? v - Math.abs(cx) : NaN;
        }),
      };
    }
    const ttm = trailingTwelveMonths(fcf, inputs.period);
    return (c) => {
      c.set('fcf', valueAt(fcf, c.time[c.i]!));
      if (inputs.ttm) c.set('ttm', valueAt(ttm, c.time[c.i]!));
    };
  },
});
