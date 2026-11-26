import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import {
  PERIOD_INPUT,
  ROW,
  divideBy,
  requireSeries,
  series,
  splitAdjusted,
  statementsOf,
  trailingTwelveMonths,
  valueAt,
} from './common';

/**
 * Diluted earnings per share, split-adjusted like the bars (the diluted EPS row, or net income
 * over diluted average shares when the row is missing), plus the trailing
 * twelve months while on the quarterly basis.
 */
export const EPS = defineIndicator({
  id: 'fin-eps',
  name: 'Earnings Per Share',
  shortName: 'EPS',
  description:
    'Earnings per share: net income divided by shares outstanding, per reporting period.',
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
    const netIncome = requireSeries(
      env.fundamentals,
      inputs.period,
      'income',
      ROW.netIncome,
      'net income',
    );
    const splits = env.fundamentals?.splits;
    const raw = series(stmts?.income, ROW.dilutedShares);
    const shares = raw && splitAdjusted(raw, raw, splits, 'count');
    // Diluted EPS row when the provider reports it; otherwise derived from the
    // income statement's own share count, so period ends line up exactly.
    const eps = reported
      ? splitAdjusted(reported, raw, splits, 'perShare')
      : shares
        ? divideBy(netIncome, shares)
        : null;
    if (!eps) throw new Error(`No ${inputs.period.toLowerCase()} diluted EPS data for this symbol`);
    const ttm = trailingTwelveMonths(eps, inputs.period);
    return (c) => {
      c.set('eps', valueAt(eps, c.time[c.i]!));
      if (inputs.ttm) c.set('ttm', valueAt(ttm, c.time[c.i]!));
    };
  },
});
