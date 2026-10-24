import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import {
  PERIOD_INPUT,
  ROW,
  divideBy,
  requireSeries,
  series,
  statementsOf,
  trailingTwelveMonths,
  valueAt,
} from './common';

/**
 * Diluted earnings per share as reported (the diluted EPS row, or net income
 * over diluted average shares when the row is missing), plus the trailing
 * twelve months while on the quarterly basis.
 */
export const EPS = defineIndicator({
  id: 'fin-eps',
  name: 'Earnings Per Share',
  shortName: 'EPS',
  category: 'financials',
  keywords: ['eps', 'earnings per share', 'diluted', 'income statement', 'financials'],
  overlay: false,
  format: 'price',
  precision: 2,
  usesFundamentals: true,
  inputs: {
    period: PERIOD_INPUT,
    ttm: { kind: 'bool', label: 'TTM', default: true, hideInTitle: true },
  },
  outputs: [
    { type: 'plot', id: 'eps', title: 'EPS', kind: 'step', color: COLOR.blue },
    { type: 'plot', id: 'ttm', title: 'TTM', kind: 'step', color: COLOR.orange },
  ],
  setup({ inputs, env }) {
    const stmts = statementsOf(env.fundamentals, inputs.period);
    const reported = series(stmts?.income, ROW.dilutedEps);
    const netIncome = requireSeries(env.fundamentals, inputs.period, 'income', ROW.netIncome, 'net income');
    const shares = series(stmts?.income, ROW.dilutedShares);
    // Diluted EPS row when the provider reports it; otherwise derived from the
    // income statement's own share count, so period ends line up exactly.
    const eps = reported ?? (shares ? divideBy(netIncome, shares) : null);
    if (!eps) throw new Error(`No ${inputs.period.toLowerCase()} diluted EPS data for this symbol`);
    const ttm = trailingTwelveMonths(eps, inputs.period);
    return (c) => {
      c.set('eps', valueAt(eps, c.time[c.i]!));
      if (inputs.ttm) c.set('ttm', valueAt(ttm, c.time[c.i]!));
    };
  },
});
