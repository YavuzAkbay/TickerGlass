// Shared machinery of the Financials built-ins: reading the chart symbol's
// financial statements out of `env.fundamentals` (see IndicatorDefinition.
// usesFundamentals) and turning per-period line items into chart series.
import type { FundamentalsData, StatementData, StatementsByPeriod } from '../../types';

/** Statement period basis chosen by the `period` input of every Financials built-in. */
export type PeriodBasis = 'Quarterly' | 'Annual';

export type StatementKind = 'income' | 'balance' | 'cashflow';

/**
 * Line-item label aliases. Providers rename rows between versions and sources
 * ("Total Revenue" vs "Revenues"); the first present alias wins.
 */
export const ROW = {
  revenue: ['Total Revenue', 'Revenues', 'Operating Revenue'],
  grossProfit: ['Gross Profit'],
  operatingIncome: ['Operating Income'],
  netIncome: ['Net Income', 'Net Income Common Stockholders'],
  dilutedEps: ['Diluted EPS'],
  dilutedShares: ['Diluted Average Shares', 'Weighted Average Shs Out Dil'],
  shares: ['Ordinary Shares Number', 'Share Issued'],
  totalAssets: ['Total Assets'],
  currentAssets: ['Current Assets', 'Total Current Assets'],
  cash: ['Cash And Cash Equivalents'],
  currentLiabilities: ['Current Liabilities', 'Total Current Liabilities'],
  totalDebt: ['Total Debt'],
  equity: ['Stockholders Equity', 'Total Stockholder Equity'],
  ocf: ['Operating Cash Flow', 'Total Cash From Operating Activities'],
  capex: ['Capital Expenditure', 'Capital Expenditures'],
  fcf: ['Free Cash Flow'],
} as const;

/** One line item as period ends (unix seconds, ascending) and a value per period. */
export interface Series {
  readonly periods: readonly number[];
  readonly values: readonly number[];
}

function ascending(stmt: StatementData, row: readonly number[]): Series {
  let sorted = true;
  for (let k = 1; k < stmt.periods.length; k++)
    if (stmt.periods[k]! < stmt.periods[k - 1]!) {
      sorted = false;
      break;
    }
  if (sorted) return { periods: stmt.periods, values: row };
  const order = stmt.periods
    .map((p, k) => [p, k] as const)
    .sort((a, b) => a[0] - b[0]);
  return {
    periods: order.map(([p]) => p),
    values: order.map(([, k]) => row[k]!),
  };
}

/**
 * The first row of `stmt` matching an `aliases` entry, periods ascending, or
 * null when the statement or the row is missing.
 */
export function series(stmt: StatementData | undefined, aliases: readonly string[]): Series | null {
  if (!stmt || !stmt.periods.length) return null;
  for (const name of aliases) {
    const row = stmt.rows[name];
    if (row && row.length === stmt.periods.length) return ascending(stmt, row);
  }
  return null;
}

/** Error for a symbol that reports no data of this basis and kind. */
export function missingData(basis: PeriodBasis, what: string): Error {
  return new Error(`No ${basis.toLowerCase()} ${what} data for this symbol`);
}

/** All three statements of one basis, or null when the host loaded none. */
export function statementsOf(
  fund: FundamentalsData | undefined,
  basis: PeriodBasis,
): Pick<StatementsByPeriod, StatementKind> | null {
  if (!fund) return null;
  return basis === 'Quarterly' ? (fund.quarterly ?? null) : (fund.annual ?? null);
}

/** One line item of one statement; throws `missingData` when absent. */
export function requireSeries(
  fund: FundamentalsData | undefined,
  basis: PeriodBasis,
  kind: StatementKind,
  aliases: readonly string[],
  what: string,
): Series {
  const stmt = statementsOf(fund, basis)?.[kind];
  return series(stmt, aliases) ?? throwMissing(basis, what);
}

function throwMissing(basis: PeriodBasis, what: string): never {
  throw missingData(basis, what);
}

/** Value of the last period ending at or before `t` (NaN before the first). */
export function valueAt(s: Series, t: number): number {
  let lo = 0;
  let hi = s.periods.length - 1;
  let r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (s.periods[m]! <= t) {
      r = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return r < 0 ? NaN : s.values[r]!;
}

/**
 * Trailing twelve months of a quarterly series: the sum of each period and the
 * three before it (NaN until four quarters are known). Annual series pass
 * through unchanged.
 */
export function trailingTwelveMonths(s: Series, basis: PeriodBasis): Series {
  if (basis === 'Annual') return s;
  const periods = s.periods.slice(3);
  const values = s.values.slice(3).map((_, k) => {
    let sum = 0;
    for (let j = k; j < k + 4; j++) {
      const v = s.values[j]!;
      if (!Number.isFinite(v)) return NaN;
      sum += v;
    }
    return sum;
  });
  return { periods, values };
}

/**
 * Growth of `s` per period in percent over the previous year (4 quarters back,
 * or the previous year on the annual basis). NaN while either side is missing
 * or the base is zero.
 */
export function yearOverYear(s: Series, basis: PeriodBasis): Series {
  const lag = basis === 'Quarterly' ? 4 : 1;
  const periods = s.periods.slice(lag);
  const values = s.values.slice(lag).map((v, k) => {
    const base = s.values[k]!;
    if (!Number.isFinite(v) || !Number.isFinite(base) || base === 0) return NaN;
    return ((v - base) / Math.abs(base)) * 100;
  });
  return { periods, values };
}

/**
 * `s` divided by `other` read at `s`'s period ends (statements of different
 * kinds may label period ends a few days apart). NaN where either is missing
 * or the denominator is zero.
 */
export function divideBy(s: Series, other: Series): Series {
  const values = s.periods.map((p, k) => {
    const d = valueAt(other, p);
    const v = s.values[k]!;
    if (!Number.isFinite(v) || !Number.isFinite(d) || d === 0) return NaN;
    return v / d;
  });
  return { periods: s.periods, values };
}

/** `s * k` per period (for percent-of-revenue style series). */
export function scaled(s: Series, k: number): Series {
  return { periods: s.periods, values: s.values.map((v) => v * k) };
}

/** Period-basis input shared by every Financials built-in. */
export const PERIOD_INPUT = {
  kind: 'enum',
  label: 'Period',
  options: ['Quarterly', 'Annual'] as const,
  default: 'Quarterly',
} as const;
